/* oxlint-disable typescript/no-non-null-assertion -- Asserted fixture rows and byte positions. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Artifact } from "@offtree/effectory-sdk";
import type { Expression } from "@offtree/effectory-sdk/ArtifactQuery";
import { Deferred, Effect, Fiber, Schema, Stream } from "effect";

import { createStore } from "../src/host-store.ts";
import { createLake } from "../src/lake.ts";

const Json = Artifact.make({
  fields: [["n"]],
  id: "reader-json",
  schema: Schema.Struct({ n: Schema.Int }),
  version: 1,
});
const Bytes = Artifact.make({
  contentType: "application/octet-stream",
  id: "reader-bytes",
  kind: "bytes",
  version: 1,
});
function setup(directory: string) {
  const db = new Database(path.join(directory, "state.sqlite"));
  const lease = { assertActive: () => {}, token: "reader-test" };
  const store = createStore(db, lease);
  const lake = createLake(db, path.join(directory, "blobs"), lease);
  const admit = (taskId: string, principal = "owner") =>
    Effect.gen(function* () {
      const run = yield* store.submit(
        {
          input: null,
          kind: "task",
          requestKey: crypto.randomUUID(),
          targetId: taskId,
        },
        "revision",
        principal
      );
      yield* store.admitAttempt(run.runId, "task", 1, "idempotent");
      const identity = {
        attempt: 1,
        attemptId: `${run.runId}/task/1`,
        invocationPath: "task",
        revision: "revision",
        runId: run.runId,
        taskId,
        taskVersion: 1,
      };
      return { binding: lake.reader(identity, () => true), identity };
    });
  return { admit, db, lake, store };
}
async function withStore<A, E>(
  body: (
    store: ReturnType<typeof setup>,
    directory: string
  ) => Effect.Effect<A, E>
) {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-reader-"));
  const f = setup(directory);
  try {
    return await Effect.runPromise(body(f, directory));
  } finally {
    f.db.close();
    await rm(directory, { force: true, recursive: true });
  }
}
test(
  "first access pins atomically against an existing reclaim plan; waits and new handles preserve protection",
  () =>
    withStore((f, directory) =>
      Effect.gen(function* () {
        const producer = yield* f.admit("producer");
        const ref = Schema.decodeUnknownSync(Json.refSchema)(
          yield* f.lake.publish(
            producer.identity,
            "value",
            Json,
            { n: 7 },
            { key: "value" }
          )
        );
        yield* f.store.project(producer.identity.runId, "Succeeded");
        const plan = yield* f.lake.planReclamation({
          _tag: "Version",
          artifactId: ref.artifactId,
          version: ref.version,
        });
        const consumer = yield* f.admit("consumer");
        expect(
          (yield* consumer.binding.reader.query(Json, { versions: "all" }))
            .rows[0]?.ref
        ).toEqual(ref);
        expect(
          f.db.query("SELECT COUNT(*) AS n FROM lake_consumer_pins").get()
        ).toEqual({ n: 0 });
        expect(yield* consumer.binding.reader.get(Json, ref)).toEqual({ n: 7 });
        expect(
          (yield* f.lake.applyReclamation({ planId: plan.planId }))
            .deletedVersions
        ).toBe(0);
        yield* f.store.project(consumer.identity.runId, "Waiting");
        const protectedPlan = yield* f.lake.planReclamation({
          _tag: "Version",
          artifactId: ref.artifactId,
          version: 1,
        });
        expect(protectedPlan.protectedBy).toEqual({
          consumerVersions: 1,
          producerVersions: 0,
          reportVersions: 0,
        });
        const versions = yield* f.lake.versions(
          { artifactId: ref.artifactId },
          "owner"
        );
        expect(versions.items[0]?.protection?.consumerRunIds).toEqual([
          consumer.identity.runId,
        ]);
        // A second lake instance observes the durable pin independently of the handle.
        const second = createLake(f.db, path.join(directory, "blobs"), {
          assertActive: () => {},
          token: "reader-test",
        });
        expect(
          (yield* second.planReclamation({
            _tag: "Version",
            artifactId: ref.artifactId,
            version: 1,
          })).protectedVersions
        ).toBe(1);
        yield* consumer.binding.close;
        yield* f.store.project(consumer.identity.runId, "Succeeded");
        const remove = yield* f.lake.planReclamation({
          _tag: "Version",
          artifactId: ref.artifactId,
          version: 1,
        });
        expect(
          (yield* f.lake.applyReclamation({ planId: remove.planId }))
            .deletedVersions
        ).toBe(1);
        const next = yield* f.admit("next");
        expect(
          yield* next.binding.reader.metadata(Json, ref).pipe(Effect.flip)
        ).toMatchObject({ reason: "Reclaimed" });
        expect(
          yield* next.binding.reader
            .latest(Json, { key: "value", output: "value", taskId: "producer" })
            .pipe(Effect.flip)
        ).toMatchObject({ reason: "Reclaimed" });
      })
    ),
  10_000
);

test(
  "reader distinguishes schema upgrades, wrong principals and corrupt content",
  () =>
    withStore((f, directory) =>
      Effect.gen(function* () {
        const producer = yield* f.admit("producer");
        const ref = Schema.decodeUnknownSync(Json.refSchema)(
          yield* f.lake.publish(
            producer.identity,
            "value",
            Json,
            { n: 7 },
            { key: "value" }
          )
        );
        yield* f.store.project(producer.identity.runId, "Succeeded");
        const consumer = yield* f.admit("consumer");
        expect(
          yield* consumer.binding.reader
            .get(Json, { ...ref, digest: "0".repeat(64) })
            .pipe(Effect.flip)
        ).toMatchObject({ reason: "DigestMismatch" });
        const other = yield* f.admit("other", "different-owner");
        expect(
          yield* other.binding.reader.get(Json, ref).pipe(Effect.flip)
        ).toMatchObject({ reason: "NotFound" });
        const V2 = Artifact.make({
          fields: Json.fields,
          id: Json.id,
          schema: Json.schema,
          version: 2,
        });
        const nextProducer = yield* f.admit("producer");
        yield* f.lake.publish(
          nextProducer.identity,
          "value",
          V2,
          { n: 8 },
          { key: "value" }
        );
        expect(
          yield* consumer.binding.reader
            .latest(Json, { key: "value", output: "value", taskId: "producer" })
            .pipe(Effect.flip)
        ).toMatchObject({
          artifactId: ref.artifactId,
          reason: "SchemaMismatch",
          version: 2,
        });
        expect(
          (yield* consumer.binding.reader.query(Json, { versions: "latest" }))
            .rows
        ).toHaveLength(0);
        yield* Effect.promise(() =>
          writeFile(path.join(directory, "blobs", ref.digest), '{"n":9}')
        );
        expect(
          yield* consumer.binding.reader.get(Json, ref).pipe(Effect.flip)
        ).toMatchObject({ reason: "Corrupt" });
      })
    ),
  10_000
);

test(
  "binary reader verifies EOF and real storage completes saturated copy fan-out",
  () =>
    withStore((f) =>
      Effect.gen(function* () {
        const producer = yield* f.admit("producer");
        const source = Stream.succeed(new Uint8Array(150_000).fill(42));
        const ref = Schema.decodeUnknownSync(Bytes.refSchema)(
          yield* producer.binding.owner.publish(
            f.lake.publishBytes(producer.identity, "bytes", Bytes, source, {
              key: "original",
            })
          )
        );
        yield* f.store.project(producer.identity.runId, "Succeeded");
        const consumers = yield* Effect.forEach(
          Array.from({ length: 16 }, (_, i) => i),
          (i) => f.admit(`consumer-${i}`)
        );
        yield* Effect.forEach(
          consumers,
          (consumer) =>
            Effect.gen(function* () {
              const copied = Schema.decodeUnknownSync(Bytes.refSchema)(
                yield* consumer.binding.owner.publish(
                  f.lake.publishBytes(
                    consumer.identity,
                    "bytes",
                    Bytes,
                    consumer.binding.reader.stream(Bytes, ref),
                    { key: "copy" }
                  )
                )
              );
              const value = yield* consumer.binding.reader.bytes(Bytes, copied);
              expect(value.length).toBe(150_000);
              expect(value[149_999]).toBe(42);
              yield* consumer.binding.close;
            }),
          { concurrency: 16 }
        );
      })
    ),
  15_000
);

test(
  "report obligations protect before materialization, track every status, and exempt source reads",
  () =>
    withStore((f) =>
      Effect.gen(function* () {
        const run = yield* f.store.submit(
          {
            input: null,
            kind: "task",
            reportPlan: [
              {
                attachmentId: "summary",
                execution: {
                  attemptTimeout: "5 minutes",
                  timeout: "5 minutes",
                },
                on: ["Succeeded"],
                reporterId: "reporter",
                reporterProviderId: null,
                reporterVersion: 1,
                scope: "run",
                targetId: "source",
                targetKind: "task",
                targetVersion: 1,
              },
            ],
            requestKey: "report-source",
            targetId: "source",
          },
          "revision",
          "owner"
        );
        yield* f.store.admitAttempt(run.runId, "task", 1, "idempotent");
        const identity = {
          attempt: 1,
          attemptId: "source/1",
          invocationPath: "task",
          revision: "revision",
          runId: run.runId,
          taskId: "source",
          taskVersion: 1,
        };
        const ref = Schema.decodeUnknownSync(Json.refSchema)(
          yield* f.lake.publish(
            identity,
            "value",
            Json,
            { n: 3 },
            { key: "main" }
          )
        );
        yield* f.store.project(run.runId, "Succeeded");
        const request = {
          _tag: "Version" as const,
          artifactId: ref.artifactId,
          version: 1,
        };
        expect(
          (yield* f.lake.planReclamation(request)).protectedBy?.reportVersions
        ).toBe(1);
        const reporter = yield* f.admit("reporter");
        f.db
          .query(
            "UPDATE host_reports SET reportRunId=? WHERE groupId IN (SELECT groupId FROM host_report_groups WHERE sourceRunId=?)"
          )
          .run(reporter.identity.runId, run.runId);
        for (const status of [
          "WaitingSource",
          "Queued",
          "Running",
          "NeedsAttention",
        ]) {
          f.db
            .query("UPDATE host_reports SET status=? WHERE reportRunId=?")
            .run(status, reporter.identity.runId);
          expect(
            (yield* f.lake.planReclamation(request)).protectedVersions
          ).toBe(1);
          expect(yield* reporter.binding.reader.get(Json, ref)).toEqual({
            n: 3,
          });
        }
        expect(
          f.db
            .query(
              "SELECT COUNT(*) AS n FROM lake_consumer_pins WHERE consumerRunId=?"
            )
            .get(reporter.identity.runId)
        ).toEqual({ n: 0 });
        for (const status of [
          "Succeeded",
          "Failed",
          "Cancelled",
          "NotApplicable",
        ]) {
          f.db
            .query("UPDATE host_reports SET status=? WHERE reportRunId=?")
            .run(status, reporter.identity.runId);
          expect(
            (yield* f.lake.planReclamation(request)).protectedVersions
          ).toBe(0);
        }
        yield* reporter.binding.reader.get(Json, ref);
        expect(
          f.db
            .query(
              "SELECT COUNT(*) AS n FROM lake_consumer_pins WHERE consumerRunId=?"
            )
            .get(reporter.identity.runId)
        ).toEqual({ n: 1 });
      })
    ),
  10_000
);

test(
  "1024 distinct external pins are idempotent and same-run reads are exempt",
  () =>
    withStore((f) =>
      Effect.gen(function* () {
        const producer = yield* f.admit("producer");
        const refs = [];
        for (let i = 0; i < 1025; i += 1) {
          refs.push(
            Schema.decodeUnknownSync(Json.refSchema)(
              yield* f.lake.publish(
                producer.identity,
                "value",
                Json,
                { n: i },
                { key: `value-${i}` }
              )
            )
          );
        }
        for (const ref of refs) {
          yield* producer.binding.reader.metadata(Json, ref);
        }
        expect(
          f.db.query("SELECT COUNT(*) AS n FROM lake_consumer_pins").get()
        ).toEqual({ n: 0 });
        yield* f.store.project(producer.identity.runId, "Succeeded");
        const consumer = yield* f.admit("consumer");
        for (const ref of refs.slice(0, 1024)) {
          yield* consumer.binding.reader.metadata(Json, ref);
        }
        yield* consumer.binding.reader.metadata(Json, refs[0]!);
        expect(
          yield* consumer.binding.reader
            .metadata(Json, refs[1024]!)
            .pipe(Effect.flip)
        ).toMatchObject({ reason: "PinLimit" });
        expect(
          f.db.query("SELECT COUNT(*) AS n FROM lake_consumer_pins").get()
        ).toEqual({ n: 1024 });
        yield* f.store.project(consumer.identity.runId, "Succeeded");
        yield* f.lake.cleanupReadPins;
        expect(
          f.db.query("SELECT COUNT(*) AS n FROM lake_consumer_pins").get()
        ).toEqual({ n: 768 });
        yield* f.lake.cleanupReadPins;
        yield* f.lake.cleanupReadPins;
        yield* f.lake.cleanupReadPins;
        expect(
          f.db.query("SELECT COUNT(*) AS n FROM lake_consumer_pins").get()
        ).toEqual({ n: 0 });
      })
    ),
  20_000
);

test(
  "pin contention retries outside the transaction and reports Busy after its bounded wait",
  () =>
    withStore((f, directory) =>
      Effect.gen(function* () {
        const producer = yield* f.admit("producer");
        const ref = Schema.decodeUnknownSync(Json.refSchema)(
          yield* f.lake.publish(
            producer.identity,
            "value",
            Json,
            { n: 1 },
            { key: "value" }
          )
        );
        yield* f.store.project(producer.identity.runId, "Succeeded");
        const consumer = yield* f.admit("consumer");
        const competitor = new Database(path.join(directory, "state.sqlite"));
        yield* Effect.acquireUseRelease(
          Effect.sync(() => competitor),
          (db) =>
            Effect.gen(function* () {
              db.exec("BEGIN IMMEDIATE");
              const release = yield* Effect.forkChild(
                Effect.sleep("60 millis").pipe(
                  Effect.andThen(Effect.sync(() => db.exec("COMMIT")))
                )
              );
              expect((yield* consumer.binding.reader.get(Json, ref)).n).toBe(1);
              yield* Fiber.join(release);
              db.exec("BEGIN IMMEDIATE");
              expect(
                yield* consumer.binding.reader
                  .metadata(Json, ref)
                  .pipe(Effect.flip)
              ).toMatchObject({ _tag: "ArtifactUnavailable", reason: "Busy" });
              db.exec("ROLLBACK");
            }),
          (db) =>
            Effect.sync(() => {
              if (db.inTransaction) {
                db.exec("ROLLBACK");
              }
              db.close();
            })
        );
      })
    ),
  10_000
);

test(
  "read-then-publish retains the shared group while a stream is open",
  () =>
    withStore((f) =>
      Effect.gen(function* () {
        const producer = yield* f.admit("producer");
        const ref = Schema.decodeUnknownSync(Bytes.refSchema)(
          yield* producer.binding.owner.publish(
            f.lake.publishBytes(
              producer.identity,
              "bytes",
              Bytes,
              Stream.succeed(new Uint8Array(524_288).fill(17)),
              { key: "original" }
            )
          )
        );
        yield* f.store.project(producer.identity.runId, "Succeeded");
        const consumers = yield* Effect.forEach(
          Array.from({ length: 16 }, (_, i) => i),
          (i) => f.admit(`consumer-${i}`)
        );
        yield* Effect.forEach(
          consumers,
          (consumer) =>
            Effect.scoped(
              Effect.gen(function* () {
                const started = yield* Deferred.make<boolean>();
                const finish = yield* Deferred.make<boolean>();
                const reading = yield* Effect.forkScoped(
                  Stream.runForEach(
                    consumer.binding.reader.stream(Bytes, ref),
                    () =>
                      Deferred.succeed(started, true).pipe(
                        Effect.andThen(Deferred.await(finish))
                      )
                  )
                );
                yield* Deferred.await(started);
                const copied = yield* consumer.binding.owner.publish(
                  f.lake.publishBytes(
                    consumer.identity,
                    "bytes",
                    Bytes,
                    consumer.binding.reader.stream(Bytes, ref),
                    { key: "copy" }
                  )
                );
                expect(copied.digest).toBe(ref.digest);
                yield* Deferred.succeed(finish, true);
                yield* Fiber.join(reading);
                yield* consumer.binding.close;
              })
            ),
          { concurrency: 16 }
        );
      })
    ),
  15_000
);

test(
  "partial bytes consumption does not claim integrity, but full reads reject a changed blob",
  () =>
    withStore((f, directory) =>
      Effect.gen(function* () {
        const producer = yield* f.admit("producer");
        const ref = Schema.decodeUnknownSync(Bytes.refSchema)(
          yield* producer.binding.owner.publish(
            f.lake.publishBytes(
              producer.identity,
              "bytes",
              Bytes,
              Stream.succeed(new Uint8Array(150_000).fill(42)),
              { key: "original" }
            )
          )
        );
        yield* f.store.project(producer.identity.runId, "Succeeded");
        yield* Effect.promise(() =>
          writeFile(
            path.join(directory, "blobs", ref.digest),
            new Uint8Array(150_000).fill(43)
          )
        );
        const consumer = yield* f.admit("consumer");
        const partial = yield* Stream.runCollect(
          consumer.binding.reader.stream(Bytes, ref).pipe(Stream.take(1))
        );
        expect(partial[0]?.[0]).toBe(43);
        expect(
          yield* consumer.binding.reader.bytes(Bytes, ref).pipe(Effect.flip)
        ).toMatchObject({ reason: "Corrupt" });
      })
    ),
  10_000
);

test(
  "query errors distinguish invalid expressions, invalid cursors and reclamation expiry",
  () =>
    withStore((f) =>
      Effect.gen(function* () {
        const producer = yield* f.admit("producer");
        const refs = [];
        for (let i = 0; i < 3; i += 1) {
          refs.push(
            Schema.decodeUnknownSync(Json.refSchema)(
              yield* f.lake.publish(
                producer.identity,
                "value",
                Json,
                { n: i },
                { key: `value-${i}` }
              )
            )
          );
        }
        yield* f.store.project(producer.identity.runId, "Succeeded");
        const consumer = yield* f.admit("consumer");
        const first = yield* consumer.binding.reader.query(Json, {
          limit: 1,
          versions: "all",
        });
        if (!first.cursor) {
          return yield* Effect.die("Missing fixture cursor");
        }
        expect(
          yield* consumer.binding.reader
            .query(Json, { cursor: "invalid", versions: "all" })
            .pipe(Effect.flip)
        ).toMatchObject({ reason: "InvalidCursor" });
        expect(
          yield* consumer.binding.reader
            .query(Json, { cursor: first.cursor, limit: 2, versions: "all" })
            .pipe(Effect.flip)
        ).toMatchObject({ reason: "InvalidCursor" });
        let where: Expression = {
          _tag: "Eq",
          field: { metadata: "runId" },
          value: producer.identity.runId,
        };
        for (let i = 0; i < 12; i += 1) {
          where = { _tag: "Not", term: where };
        }
        expect(
          yield* consumer.binding.reader
            .query(Json, { versions: "all", where })
            .pipe(Effect.flip)
        ).toMatchObject({ reason: "InvalidQuery" });
        const plan = yield* f.lake.planReclamation({
          _tag: "Version",
          artifactId: refs[2]!.artifactId,
          version: 1,
        });
        yield* f.lake.applyReclamation({ planId: plan.planId });
        expect(
          yield* consumer.binding.reader
            .query(Json, { cursor: first.cursor, limit: 1, versions: "all" })
            .pipe(Effect.flip)
        ).toMatchObject({ reason: "CursorExpired" });
      })
    ),
  10_000
);
