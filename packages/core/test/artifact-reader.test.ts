/* oxlint-disable typescript/no-non-null-assertion, unicorn/no-await-expression-member -- Known test fixture positions and direct result assertions. */
import { expect, test } from "bun:test";

import {
  Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Schema,
  SchemaGetter,
  Stream,
} from "effect";

import type { Service } from "../src/artifact-reader.ts";
import {
  Artifact,
  ArtifactReader,
  ArtifactReadError,
  ArtifactUnavailable,
  ArtifactStorage,
  ArtifactQuery,
  Task,
} from "../src/index.ts";

const Json = Artifact.make({
  fields: [["count"]],
  id: "read-json",
  schema: Schema.Struct({ count: Schema.Int }),
  version: 1,
});
const Bytes = Artifact.make({
  contentType: "application/octet-stream",
  id: "read-bytes",
  kind: "bytes",
  version: 1,
});
const error = Schema.Union([ArtifactReadError, ArtifactUnavailable]);
const spec = {
  error,
  id: "reader-test",
  input: Schema.Null,
  replay: "idempotent" as const,
  success: Schema.Int,
  version: 1,
};

test("fixtures, own publications, latest and query pages share a store across tests", async () => {
  const producer = Task.make({ ...spec, outputs: { json: Json } }, () =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      const reader = yield* ArtifactReader;
      const ref = yield* storage.publish(Json, { count: 42 }, { key: "one" });
      expect((yield* reader.get(Json, ref)).count).toBe(42);
      expect(
        yield* reader.latest(Json, {
          key: "one",
          output: "json",
          taskId: spec.id,
        })
      ).toEqual(ref);
      return 42;
    })
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* Artifact.fixture(
        Json,
        { count: 1 },
        { key: "first" }
      );
      const produced = yield* Task.test(producer, {
        artifacts: [fixture],
        input: null,
      });
      expect(produced.artifacts).toHaveLength(2);
      const consumer = Task.make(spec, () =>
        Effect.gen(function* () {
          const all = yield* Stream.runCollect(
            ArtifactQuery.stream(Json, {
              limit: 1,
              orderBy: [{ direction: "desc", field: { json: ["count"] } }],
              versions: "all",
            })
          );
          expect(all.map((row) => row.metadata.sequence)).toEqual([2, 1]);
          const reader = yield* ArtifactReader;
          return (yield* reader.get(
            Json,
            Schema.decodeUnknownSync(Json.refSchema)(
              produced.publications[0]?.reference
            )
          )).count;
        })
      );
      expect(
        (yield* Task.test(consumer, {
          artifacts: produced.artifacts,
          input: null,
        })).value
      ).toBe(42);
      const again = yield* Task.test(producer, {
        artifacts: produced.artifacts,
        input: null,
      });
      expect(again.publications[0]!.reference.digest).toBe("test-digest-2");
      expect(again.publications[0]!.reference.version).toBe(2);
    })
  );
});

test("binary copies at concurrency eight use the same four-writer ordering as the host", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* Artifact.fixture(Bytes, new Uint8Array([1, 2, 3]));
      const task = Task.make({ ...spec, outputs: { bytes: Bytes } }, () =>
        Effect.gen(function* () {
          const reader = yield* ArtifactReader;
          const storage = yield* ArtifactStorage;
          const refs = yield* Effect.forEach(
            Array.from({ length: 8 }, (_, i) => i),
            (i) =>
              storage.publish(Bytes, reader.stream(Bytes, fixture.reference), {
                key: `copy-${i}`,
              }),
            { concurrency: 8 }
          );
          const values = yield* Effect.forEach(
            refs,
            (ref) => reader.bytes(Bytes, ref),
            { concurrency: 8 }
          );
          for (const value of values) {
            expect([...value]).toEqual([1, 2, 3]);
          }
          values[0]![0] = 9;
          expect([...(yield* reader.bytes(Bytes, refs[0]!))]).toEqual([
            1, 2, 3,
          ]);
          return refs.length;
        })
      );
      const result = yield* Task.test(task, {
        artifacts: [fixture],
        input: null,
      });
      expect(result.value).toBe(8);
      const [publication] = result.publications;
      if (publication?.kind === "bytes") {
        publication.bytes[0] = 99;
      }
      const follow = Task.make(spec, () =>
        Effect.gen(function* () {
          const reader = yield* ArtifactReader;
          return (yield* reader.bytes(
            Bytes,
            Schema.decodeUnknownSync(Bytes.refSchema)(
              result.publications[0]?.reference
            )
          ))[0]!;
        })
      );
      expect(
        (yield* Task.test(follow, { artifacts: result.artifacts, input: null }))
          .value
      ).toBe(1);
    })
  );
}, 10_000);

test("closed captured readers and decoder defects are typed, safe failures", async () => {
  let saved: Service | undefined;
  const readerTask = Task.make(spec, () =>
    Effect.gen(function* () {
      saved = yield* ArtifactReader;
      return 0;
    })
  );
  const fixture = await Effect.runPromise(Artifact.fixture(Json, { count: 1 }));
  await Effect.runPromise(
    Task.test(readerTask, { artifacts: [fixture], input: null })
  );
  expect(
    await Effect.runPromise(
      saved!.get(Json, fixture.reference).pipe(Effect.flip)
    )
  ).toMatchObject({ reason: "Closed" });
  const Evil = Artifact.make({
    id: Json.id,
    schema: Schema.Struct({ count: Schema.Int }).check(
      Schema.makeFilter(() => {
        throw new Error("SECRET-CANARY");
      })
    ),
    version: 1,
  });
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      const reader = yield* ArtifactReader;
      yield* reader.get(Evil, fixture.reference);
      return 0;
    })
  );
  const failure = await Effect.runPromise(
    Task.test(task, { artifacts: [fixture], input: null }).pipe(Effect.flip)
  );
  expect(failure).toMatchObject({ reason: "DecodeFailed" });
  expect(JSON.stringify(failure)).not.toContain("SECRET-CANARY");
});

test("task-local reader Layers override the host and require no extra application service", async () => {
  const fixture = await Effect.runPromise(Artifact.fixture(Json, { count: 1 }));
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      const reader = yield* ArtifactReader;
      return (yield* reader.get(Json, fixture.reference)).count;
    })
  );
  const fake = ArtifactReader.of({
    bytes: () => Effect.die("unused"),
    get: () => Effect.succeed({ count: 99 }),
    latest: () => Effect.die("unused"),
    metadata: () => Effect.die("unused"),
    query: () => Effect.die("unused"),
    stream: () => Stream.die("unused"),
  });
  expect(
    (
      await Effect.runPromise(
        Task.test(task.provide(Layer.succeed(ArtifactReader, fake)), {
          input: null,
        })
      )
    ).value
  ).toBe(99);
});

test("async decoding and interruption discard codec finalizer defects", async () => {
  const Plain = Artifact.make({
    id: "async-reader",
    schema: Schema.String,
    version: 1,
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* Artifact.fixture(Plain, "CANARY-reader-finalizer");
      const started = yield* Deferred.make<boolean>();
      const codec = Schema.String.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transformEffect((value: string) =>
            Effect.scoped(
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() => Effect.die(new Error(value)));
                yield* Deferred.succeed(started, true);
                return yield* Effect.never;
              })
            )
          ),
          encode: SchemaGetter.transform((value: string) => value),
        })
      );
      const Async = Artifact.make({ id: Plain.id, schema: codec, version: 1 });
      const task = Task.make(spec, () =>
        Effect.gen(function* () {
          const reader = yield* ArtifactReader;
          yield* reader.get(Async, fixture.reference);
          return 0;
        })
      );
      const fiber = yield* Effect.forkChild(
        Task.test(task, { artifacts: [fixture], input: null })
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(Cause.pretty(exit.cause)).not.toContain(
          "CANARY-reader-finalizer"
        );
      }
      const Valid = Artifact.make({
        id: Plain.id,
        schema: Schema.String.pipe(
          Schema.decodeTo(Schema.String, {
            decode: SchemaGetter.transformEffect((value: string) =>
              Effect.yieldNow.pipe(Effect.as(value))
            ),
            encode: SchemaGetter.transform((value: string) => value),
          })
        ),
        version: 1,
      });
      const valid = Task.make({ ...spec, success: Schema.String }, () =>
        Effect.gen(function* () {
          const reader = yield* ArtifactReader;
          return yield* reader.get(Valid, fixture.reference);
        })
      );
      expect(
        (yield* Task.test(valid, { artifacts: [fixture], input: null })).value
      ).toBe("CANARY-reader-finalizer");
    })
  );
});

test("fixture defaults use the greatest earlier timestamp and reject collisions without changing references", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const x = yield* Artifact.fixture(
        Json,
        { count: 1 },
        { committedAt: "2026-01-01T00:00:00.000Z", key: "x" }
      );
      const y = yield* Artifact.fixture(
        Json,
        { count: 2 },
        { committedAt: "2020-01-01T00:00:00.000Z", key: "y" }
      );
      const x2 = yield* Artifact.fixture(
        Json,
        { count: 3 },
        { key: "x", version: 2 }
      );
      const task = Task.make(spec, () =>
        Effect.gen(function* () {
          const reader = yield* ArtifactReader;
          const page = yield* reader.query(Json, { versions: "all" });
          expect(page.rows[2]?.metadata.committedAt).toBe(
            "2026-01-01T00:00:00.001Z"
          );
          return page.rows.length;
        })
      );
      const result = yield* Task.test(task, {
        artifacts: [x, y, x2],
        input: null,
      });
      expect(result.value).toBe(3);
      expect(result.artifacts[2]?.reference).toEqual(x2.reference);
      const backwards = yield* Artifact.fixture(
        Json,
        { count: 4 },
        { committedAt: "2010-01-01T00:00:00.000Z", key: "x", version: 2 }
      );
      expect(
        yield* Task.test(task, { artifacts: [x, backwards], input: null }).pipe(
          Effect.flip
        )
      ).toMatchObject({ code: "InvalidBoundary" });
      const conflict = yield* Artifact.fixture(
        Json,
        { count: 4 },
        { committedAt: "2026-01-01T00:00:00.000Z", key: "x" }
      );
      expect(
        yield* Task.test(task, { artifacts: [x, conflict], input: null }).pipe(
          Effect.flip
        )
      ).toMatchObject({ code: "InvalidBoundary" });
    })
  );
});

test("invocation shutdown fails an escaped stream and closes reads before task Layer cleanup", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* Artifact.fixture(
        Bytes,
        new Uint8Array(524_288).fill(5)
      );
      const started = yield* Deferred.make<boolean>();
      const finish = yield* Deferred.make<boolean>();
      let escaped:
        | Fiber.Fiber<void, ArtifactReadError | ArtifactUnavailable>
        | undefined;
      let cleanupReason = "";
      const Client = Context.Service<boolean>("test/ReaderCleanup");
      const layer = Layer.effect(
        Client,
        Effect.acquireRelease(
          Effect.gen(function* () {
            const reader = yield* ArtifactReader;
            yield* reader.metadata(Bytes, fixture.reference);
            return reader;
          }),
          (reader) =>
            reader.metadata(Bytes, fixture.reference).pipe(
              Effect.match({
                onFailure: (failure) => {
                  cleanupReason = failure.reason;
                },
                onSuccess: () => {
                  cleanupReason = "unexpected-success";
                },
              })
            )
        ).pipe(Effect.as(true))
      );
      const task = Task.make(spec, () =>
        Effect.gen(function* () {
          const reader = yield* ArtifactReader;
          escaped = yield* Effect.forkDetach(
            Stream.runForEach(reader.stream(Bytes, fixture.reference), () =>
              Deferred.succeed(started, true).pipe(
                Effect.andThen(Deferred.await(finish))
              )
            )
          );
          yield* Deferred.await(started);
          return 0;
        })
      ).provide(layer);
      yield* Task.test(task, { artifacts: [fixture], input: null });
      expect(cleanupReason).toBe("Closed");
      yield* Deferred.succeed(finish, true);
      if (!escaped) {
        return yield* Effect.die("Missing escaped stream");
      }
      const exit = yield* Fiber.await(escaped);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(
          Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.reason
        ).toBe("Closed");
      }
    })
  );
}, 10_000);
