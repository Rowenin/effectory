import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  fstatSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DownloadFrame } from "@effectory/runtime/lake-protocol";
import { Artifact } from "@offtree/effectory-sdk";
import { Deferred, Effect, Fiber, Schema, Stream } from "effect";
import type { Scope } from "effect";

import { createStore } from "../src/host-store.ts";
import { createLake } from "../src/lake.ts";

const Bytes = Artifact.make({
  contentType: "application/octet-stream",
  id: "test/bytes",
  kind: "bytes",
  retention: { maxVersions: 1 },
  version: 1,
});
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function fixture(directory: string) {
  const filename = path.join(directory, "state.sqlite");
  const database = new Database(filename);
  const lease = { assertActive: () => {}, token: "binary-test" };
  const store = createStore(database, lease);
  const blobs = path.join(directory, "blobs");
  const lake = createLake(database, blobs, lease);
  const producer = (principal = "owner") =>
    Effect.gen(function* () {
      const run = yield* store.submit(
        {
          input: {},
          kind: "task",
          requestKey: crypto.randomUUID(),
          targetId: "producer",
        },
        "revision",
        principal
      );
      yield* store.admitAttempt(run.runId, "publish", 1, "idempotent");
      return {
        attempt: 1,
        attemptId: `${run.runId}/publish/1`,
        invocationPath: "publish",
        revision: "revision",
        runId: run.runId,
        taskId: "producer",
        taskVersion: 1,
      };
    });
  const records = () =>
    Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))(
      database.query("SELECT COUNT(*) AS count FROM lake_records").get()
    ).count;
  return { blobs, database, filename, lake, lease, producer, records, store };
}

async function withLake<A, E>(
  body: (f: ReturnType<typeof fixture>) => Effect.Effect<A, E, Scope.Scope>
) {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-bytes-"));
  const f = fixture(directory);
  try {
    return await Effect.runPromise(Effect.scoped(body(f)));
  } finally {
    f.database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

function content(frames: readonly DownloadFrame[]) {
  expect(frames[0]?._tag).toBe("Metadata");
  expect(frames.filter((frame) => frame._tag === "Metadata")).toHaveLength(1);
  return Buffer.concat(
    frames.flatMap((frame) => (frame._tag === "Bytes" ? [frame.bytes] : []))
  );
}

test("binary publication preserves empty and non-UTF8 content across chunk boundaries and exact retry", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const identity = yield* f.producer();
      const bytes = new Uint8Array(196_613);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = index % 256;
      }
      const original = yield* f.lake.publishBytes(
        identity,
        "bytes",
        Bytes,
        Stream.make(
          bytes.subarray(0, 7),
          bytes.subarray(7, 65_539),
          bytes.subarray(65_539)
        ),
        { key: "binary", tags: { encoding: "raw" } }
      );
      const repeated = yield* f.lake.publishBytes(
        identity,
        "bytes",
        Bytes,
        Stream.succeed(bytes),
        { key: "binary", tags: { encoding: "raw" } }
      );
      expect(repeated).toEqual(original);
      expect(original.digest).toBe(digest(bytes));
      expect(f.records()).toBe(1);
      const frames = yield* f.lake
        .download(original.artifactId, original.version)
        .pipe(Stream.runCollect);
      expect(content(frames)).toEqual(Buffer.from(bytes));
      const [metadata] = frames;
      if (metadata?._tag !== "Metadata") {
        throw new Error("Missing metadata");
      }
      expect(metadata.metadata.kind).toBe("bytes");
      expect(metadata.metadata.contentType).toBe("application/octet-stream");
      expect(metadata.metadata.bytes).toBe(bytes.length);
      expect(metadata.metadata.tags).toEqual({ encoding: "raw" });
      const empty = yield* f.lake.publishBytes(
        identity,
        "bytes",
        Bytes,
        Stream.empty,
        { key: "empty" }
      );
      expect(empty.digest).toBe(digest(new Uint8Array()));
      expect(
        content(
          yield* f.lake
            .download(empty.artifactId, empty.version)
            .pipe(Stream.runCollect)
        )
      ).toHaveLength(0);
      const failure = yield* f.lake
        .publishBytes(
          identity,
          "bytes",
          Bytes,
          Stream.succeed(new Uint8Array([1])),
          { key: "binary", tags: { encoding: "raw" } }
        )
        .pipe(Effect.flip);
      expect(failure.code).toBe("PublicationConflict");
      expect(f.records()).toBe(2);
    })
  ));

test("binary cap accepts exactly 16 MiB and rejects a source exceeding it before metadata commit", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const identity = yield* f.producer();
      const bytes = new Uint8Array(16_777_216).fill(149);
      const reference = yield* f.lake.publishBytes(
        identity,
        "bytes",
        Bytes,
        Stream.succeed(bytes),
        { key: "limit" }
      );
      expect(reference.digest).toBe(digest(bytes));
      const failure = yield* f.lake
        .publishBytes(
          identity,
          "bytes",
          Bytes,
          Stream.make(bytes, new Uint8Array([0])),
          { key: "oversized" }
        )
        .pipe(Effect.flip);
      expect(failure.code).toBe("LimitExceeded");
      expect(f.records()).toBe(1);
      expect(readFileSync(path.join(f.blobs, reference.digest))).toEqual(
        Buffer.from(bytes)
      );
    })
  ));

test("artifact kind and MIME drift require a schema version change", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const identity = yield* f.producer();
      const bytes = Stream.succeed(new Uint8Array([49]));
      yield* f.lake.publishBytes(identity, "bytes", Bytes, bytes, {
        key: "first",
      });
      const changedMime = Artifact.make({
        contentType: "text/plain",
        id: Bytes.id,
        kind: "bytes",
        version: 1,
      });
      expect(
        (yield* f.lake
          .publishBytes(identity, "bytes", changedMime, bytes, { key: "mime" })
          .pipe(Effect.flip)).code
      ).toBe("PublicationConflict");
      const changedKind = Artifact.make({
        id: Bytes.id,
        schema: Schema.Int,
        version: 1,
      });
      expect(
        (yield* f.lake
          .publish(identity, "bytes", changedKind, 1, { key: "json" })
          .pipe(Effect.flip)).code
      ).toBe("PublicationConflict");
      const bumped = Artifact.make({
        contentType: "text/plain",
        id: Bytes.id,
        kind: "bytes",
        version: 2,
      });
      const ref = yield* f.lake.publishBytes(identity, "bytes", bumped, bytes, {
        key: "bumped",
      });
      expect(ref.schemaVersion).toBe(2);
      expect(f.records()).toBe(2);
    })
  ));

test("source failures and interruption finalize the source without publishing partial metadata", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const identity = yield* f.producer();
      const sourceError = { _tag: "SourceFailed" } as const;
      let failuresClosed = 0;
      const failed = Stream.succeed(new Uint8Array([1, 2])).pipe(
        Stream.concat(Stream.fail(sourceError)),
        Stream.ensuring(
          Effect.sync(() => {
            failuresClosed += 1;
          })
        )
      );
      expect(
        yield* f.lake
          .publishBytes(identity, "bytes", Bytes, failed, { key: "failure" })
          .pipe(Effect.flip)
      ).toBe(sourceError);
      expect(failuresClosed).toBe(1);
      expect(f.records()).toBe(0);
      const started = Deferred.makeUnsafe<null>();
      let interruptedClosed = false;
      const interrupted = Stream.fromEffect(
        Deferred.succeed(started, null).pipe(Effect.andThen(Effect.never))
      ).pipe(
        Stream.ensuring(
          Effect.sync(() => {
            interruptedClosed = true;
          })
        )
      );
      const fiber = yield* f.lake
        .publishBytes(identity, "bytes", Bytes, interrupted, {
          key: "interrupted",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(interruptedClosed).toBe(true);
      expect(f.records()).toBe(0);
      const retry = yield* f.lake.publishBytes(
        identity,
        "bytes",
        Bytes,
        Stream.succeed(new Uint8Array([42])),
        { key: "interrupted" }
      );
      expect(retry.version).toBe(1);
    })
  ));

test("an opened download survives reclamation while later downloads see the tombstone", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const identity = yield* f.producer();
      const bytes = new Uint8Array(262_147).fill(211);
      const ref = yield* f.lake.publishBytes(
        identity,
        "bytes",
        Bytes,
        Stream.succeed(bytes),
        { key: "open-reader" }
      );
      yield* f.store.project(identity.runId, "Succeeded");
      let reclaimed = false;
      const frames = yield* f.lake.download(ref.artifactId, ref.version).pipe(
        Stream.tap((frame) =>
          frame._tag === "Metadata"
            ? Effect.gen(function* () {
                const plan = yield* f.lake.planReclamation({
                  _tag: "Version",
                  artifactId: ref.artifactId,
                  version: ref.version,
                });
                const receipt = yield* f.lake.applyReclamation({
                  planId: plan.planId,
                });
                expect(receipt.reclaimedBytes).toBe(bytes.length);
                expect(receipt.pendingBytes).toBe(0);
                expect(existsSync(path.join(f.blobs, ref.digest))).toBe(false);
                reclaimed = true;
              })
            : Effect.void
        ),
        Stream.runCollect
      );
      expect(reclaimed).toBe(true);
      expect(content(frames)).toEqual(Buffer.from(bytes));
      expect(
        (yield* f.lake
          .download(ref.artifactId, ref.version)
          .pipe(Stream.runDrain, Effect.flip)).code
      ).toBe("NotFound");
      const history = yield* f.lake.versions(
        { artifactId: ref.artifactId, includeReclaimed: true },
        "owner"
      );
      expect(history.items[0]?.reclaimedAt).toBeDefined();
    })
  ));

test("JSON and bytes share physical digests safely and get/download route errors use metadata", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const identity = yield* f.producer();
      const json = Artifact.make({
        id: "test/json",
        schema: Schema.Int,
        version: 1,
      });
      const jsonRef = yield* f.lake.publish(identity, "json", json, 42, {
        key: "shared",
      });
      const bytes = new TextEncoder().encode("42");
      const bytesRef = yield* f.lake.publishBytes(
        identity,
        "bytes",
        Bytes,
        Stream.succeed(bytes),
        { key: "shared" }
      );
      expect(bytesRef.digest).toBe(jsonRef.digest);
      const getError = yield* f.lake
        .get(bytesRef.artifactId, bytesRef.version)
        .pipe(Effect.flip);
      expect(getError.code).toBe("InvalidInput");
      expect(getError.message).toContain("lake download");
      expect(getError.message).toContain("--version");
      expect(
        (yield* f.lake
          .download(jsonRef.artifactId, jsonRef.version)
          .pipe(Stream.runDrain, Effect.flip)).code
      ).toBe("InvalidInput");
      expect(
        (yield* f.lake
          .download(bytesRef.artifactId, bytesRef.version, "other")
          .pipe(Stream.runDrain, Effect.flip)).code
      ).toBe("NotFound");
      yield* f.store.project(identity.runId, "Succeeded");
      const plan = yield* f.lake.planReclamation({
        _tag: "Version",
        artifactId: bytesRef.artifactId,
        version: bytesRef.version,
      });
      expect(
        (yield* f.lake.applyReclamation({ planId: plan.planId })).reclaimedBytes
      ).toBe(0);
      expect(
        (yield* f.lake.get(jsonRef.artifactId, jsonRef.version)).value
      ).toBe(42);
    })
  ));

test("downloads reject corrupted content and byte get refuses before attempting a content read", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const identity = yield* f.producer();
      const ref = yield* f.lake.publishBytes(
        identity,
        "bytes",
        Bytes,
        Stream.succeed(new Uint8Array([1, 2, 3])),
        { key: "corrupt" }
      );
      writeFileSync(path.join(f.blobs, ref.digest), new Uint8Array([3, 2, 1]));
      expect(
        (yield* f.lake.get(ref.artifactId, ref.version).pipe(Effect.flip)).code
      ).toBe("InvalidInput");
      expect(
        (yield* f.lake
          .download(ref.artifactId, ref.version)
          .pipe(Stream.runDrain, Effect.flip)).code
      ).toBe("ContentUnavailable");
    })
  ));

test("four active writers defer the fifth source until interruption releases a slot", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const identity = yield* f.producer();
      const firstFour = Array.from({ length: 4 }, () =>
        Deferred.makeUnsafe<null>()
      );
      const fifth = Deferred.makeUnsafe<null>();
      let fifthConsumed = false;
      let closed = 0;
      const source = (started: Deferred.Deferred<null>, isFifth = false) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            if (isFifth) {
              fifthConsumed = true;
            }
            yield* Deferred.succeed(started, null);
            return yield* Effect.never;
          })
        ).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              closed += 1;
            })
          )
        );
      const active = yield* Effect.forEach(firstFour, (started, index) =>
        f.lake
          .publishBytes(identity, "bytes", Bytes, source(started), {
            key: `active-${index}`,
          })
          .pipe(Effect.forkChild)
      );
      yield* Effect.forEach(firstFour, (started) => Deferred.await(started));
      const waiting = yield* f.lake
        .publishBytes(identity, "bytes", Bytes, source(fifth, true), {
          key: "fifth",
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(fifthConsumed).toBe(false);
      const [first] = active;
      if (!first) {
        throw new Error("Missing first writer");
      }
      yield* Fiber.interrupt(first);
      yield* Deferred.await(fifth);
      expect(fifthConsumed).toBe(true);
      yield* Fiber.interruptAll([...active, waiting]);
      expect(closed).toBe(5);
      expect(f.records()).toBe(0);
    })
  ));

test("a producer-owned buffer changing during asynchronous writes cannot corrupt the content digest", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const identity = yield* f.producer();
      const bytes = new Uint8Array(262_144).fill(7);
      const source = Stream.fromEffect(
        Effect.sync(() => {
          queueMicrotask(() => {
            bytes.fill(99);
          });
          return bytes;
        })
      );
      const ref = yield* f.lake.publishBytes(identity, "bytes", Bytes, source, {
        key: "mutable",
      });
      const stored = readFileSync(path.join(f.blobs, ref.digest));
      expect(stored.length).toBe(bytes.length);
      expect(digest(stored)).toBe(ref.digest);
      const frames = yield* f.lake
        .download(ref.artifactId, ref.version)
        .pipe(Stream.runCollect);
      expect(content(frames)).toEqual(stored);
    })
  ));

test("binary retention preserves newest, survives reopening, and never reuses a reclaimed version", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const first = yield* f.producer();
      const old = yield* f.lake.publishBytes(
        first,
        "bytes",
        Bytes,
        Stream.succeed(new Uint8Array([1])),
        { key: "series" }
      );
      yield* f.store.project(first.runId, "Succeeded");
      const second = yield* f.producer();
      const latest = yield* f.lake.publishBytes(
        second,
        "bytes",
        Bytes,
        Stream.succeed(new Uint8Array([2])),
        { key: "series" }
      );
      yield* f.store.project(second.runId, "Succeeded");
      expect(latest.artifactId).toBe(old.artifactId);
      expect(latest.version).toBe(2);
      const plan = yield* f.lake.planReclamation({
        _tag: "Policy",
        schemaId: Bytes.id,
      });
      expect(plan.candidates.map((candidate) => candidate.version)).toEqual([
        1,
      ]);
      yield* f.lake.applyReclamation({ planId: plan.planId });
      const reopened = createLake(f.database, f.blobs, f.lease);
      expect(
        content(
          yield* reopened.download(latest.artifactId, 2).pipe(Stream.runCollect)
        )
      ).toEqual(Buffer.from([2]));
      const third = yield* f.producer();
      const next = yield* reopened.publishBytes(
        third,
        "bytes",
        Bytes,
        Stream.succeed(new Uint8Array([3])),
        { key: "series" }
      );
      expect(next.version).toBe(3);
      const page = yield* reopened.query(
        {
          artifact: { schemaId: Bytes.id, schemaVersion: 1 },
          limit: 20,
          version: 1,
          versions: "all",
        },
        "owner"
      );
      expect(page.rows.map((row) => row.version)).toEqual([2, 3]);
      expect(
        page.rows.every(
          (row) =>
            row.kind === "bytes" &&
            row.contentType === "application/octet-stream"
        )
      ).toBe(true);
    })
  ));

test("failed metadata commits remove owned installations but preserve shared content", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const identity = yield* f.producer();
      const existing = new Uint8Array([11, 12]);
      const retained = yield* f.lake.publishBytes(
        identity,
        "bytes",
        Bytes,
        Stream.succeed(existing),
        { key: "retained" }
      );
      const fresh = new Uint8Array([21, 22]);
      f.database.run(
        "CREATE TRIGGER byte_commit_fault BEFORE INSERT ON lake_records BEGIN SELECT RAISE(ABORT,'binary metadata failure'); END"
      );
      const failure = yield* f.lake
        .publishBytes(identity, "bytes", Bytes, Stream.succeed(fresh), {
          key: "fresh",
        })
        .pipe(Effect.flip);
      expect(failure.code).toBe("Unavailable");
      expect(existsSync(path.join(f.blobs, digest(fresh)))).toBe(false);
      yield* f.lake
        .publishBytes(identity, "bytes", Bytes, Stream.succeed(existing), {
          key: "shared-failure",
        })
        .pipe(Effect.flip);
      expect(existsSync(path.join(f.blobs, retained.digest))).toBe(true);
      expect(f.records()).toBe(1);
      f.database.run("DROP TRIGGER byte_commit_fault");
      const retry = yield* f.lake.publishBytes(
        identity,
        "bytes",
        Bytes,
        Stream.succeed(fresh),
        { key: "fresh" }
      );
      expect(retry.version).toBe(1);
      expect(
        content(
          yield* f.lake
            .download(retained.artifactId, retained.version)
            .pipe(Stream.runCollect)
        )
      ).toEqual(Buffer.from(existing));
    })
  ));

/** Observe the real verifier's held descriptor without patching filesystem APIs. */
function awaitVerification(
  f: ReturnType<typeof fixture>,
  reference: Artifact.Reference
) {
  const original = lstatSync(path.join(f.blobs, reference.digest));
  return Effect.gen(function* () {
    for (;;) {
      if (
        f.database
          .query("SELECT stage FROM lake_binary_installs WHERE digest = ?")
          .get(reference.digest) !== null
      ) {
        for (const entry of readdirSync("/dev/fd")) {
          if (!/^\d+$/u.test(entry)) {
            continue;
          }
          const fd = Number(entry);
          const stat = yield* Effect.try(() => fstatSync(fd)).pipe(
            Effect.catch(({ cause }) =>
              // The directory includes descriptors that unrelated runtime IO may close.
              typeof cause === "object" &&
              cause !== null &&
              Reflect.get(cause, "code") === "EBADF"
                ? Effect.undefined
                : Effect.die(cause)
            )
          );
          if (
            stat?.isFile() === true &&
            stat.dev === original.dev &&
            stat.ino === original.ino
          ) {
            return { fd, original };
          }
        }
      }
      yield* Effect.yieldNow;
    }
  }).pipe(Effect.timeout("5 seconds"));
}

test("a verified writer relinks staging after reclamation unlinks its still-open source", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(16_777_216).fill(71);
      const originalProducer = yield* f.producer();
      const original = yield* f.lake.publishBytes(
        originalProducer,
        "bytes",
        Bytes,
        Stream.succeed(bytes),
        { key: "verify-race" }
      );
      yield* f.store.project(originalProducer.runId, "Succeeded");
      const plan = yield* f.lake.planReclamation({
        _tag: "Version",
        artifactId: original.artifactId,
        version: original.version,
      });
      const nextProducer = yield* f.producer();
      const writer = yield* f.lake
        .publishBytes(nextProducer, "bytes", Bytes, Stream.succeed(bytes), {
          key: "verify-race",
        })
        .pipe(Effect.forkChild);
      const held = yield* awaitVerification(f, original);
      const receipt = yield* f.lake.applyReclamation({ planId: plan.planId });
      expect(receipt.reclaimedBytes).toBe(bytes.length);
      expect(receipt.pendingBytes).toBe(0);
      expect(existsSync(path.join(f.blobs, original.digest))).toBe(false);
      // The old verified inode remains pinned while its pathname is absent.
      const unlinked = fstatSync(held.fd);
      expect(unlinked.ino).toBe(held.original.ino);
      expect(unlinked.nlink).toBe(0);
      const next = yield* Fiber.join(writer);
      expect(next.digest).toBe(original.digest);
      expect(next.version).toBe(2);
      expect(digest(readFileSync(path.join(f.blobs, next.digest)))).toBe(
        next.digest
      );
      expect(
        content(
          yield* f.lake
            .download(next.artifactId, next.version)
            .pipe(Stream.runCollect)
        )
      ).toEqual(Buffer.from(bytes));
      expect(
        f.database.query("SELECT stage FROM lake_binary_installs LIMIT 1").get()
      ).toBeNull();
    })
  ));

test("a writer re-verifies a replaced digest pathname instead of trusting the held old inode", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(16_777_216).fill(73);
      const originalProducer = yield* f.producer();
      const original = yield* f.lake.publishBytes(
        originalProducer,
        "bytes",
        Bytes,
        Stream.succeed(bytes),
        { key: "replace-race" }
      );
      yield* f.store.project(originalProducer.runId, "Succeeded");
      const replacement = path.join(f.blobs, "replacement-for-test");
      const corrupt = new Uint8Array(bytes.length).fill(99);
      writeFileSync(replacement, corrupt);
      const replacementStat = lstatSync(replacement);
      const nextProducer = yield* f.producer();
      const writer = yield* f.lake
        .publishBytes(nextProducer, "bytes", Bytes, Stream.succeed(bytes), {
          key: "replace-race",
        })
        .pipe(Effect.result, Effect.forkChild);
      const held = yield* awaitVerification(f, original);
      expect(replacementStat.ino).not.toBe(held.original.ino);
      renameSync(replacement, path.join(f.blobs, original.digest));
      const unlinked = fstatSync(held.fd);
      expect(unlinked.ino).toBe(held.original.ino);
      expect(unlinked.nlink).toBe(0);
      const result = yield* Fiber.join(writer);
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") {
        throw new Error("Corrupt replacement was trusted");
      }
      expect(result.failure.code).toBe("ContentUnavailable");
      expect(f.records()).toBe(1);
      expect(lstatSync(path.join(f.blobs, original.digest)).ino).toBe(
        replacementStat.ino
      );
      expect(
        f.database.query("SELECT stage FROM lake_binary_installs LIMIT 1").get()
      ).toBeNull();
    })
  ));
