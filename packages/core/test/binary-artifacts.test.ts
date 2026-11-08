/* oxlint-disable max-classes-per-file -- Independent services prove source and task-local Layer inference. */
import { expect, expectTypeOf, test } from "bun:test";

import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";

import type { TaskRuntimeError } from "../src/index.ts";
import { Application, Artifact, ArtifactStorage, Task } from "../src/index.ts";

const Bytes = Artifact.make({
  contentType: "application/octet-stream",
  id: "binary/test",
  kind: "bytes",
  version: 1,
});
const Json = Artifact.make({
  id: "json/test",
  schema: Schema.Struct({ count: Schema.Int }),
  version: 1,
});
const spec = {
  error: Schema.Never,
  id: "binary-task",
  input: Schema.Null,
  outputs: { bytes: Bytes, json: Json },
  replay: "idempotent" as const,
  success: Bytes.refSchema,
  version: 1,
};

function runtime(): Task.RuntimeContext {
  return {
    attempt: 1,
    attemptId: "a",
    invocationPath: "task",
    key: (key) => key,
    progress: () => Effect.void,
    publish: () => Effect.die("Unexpected JSON publication"),
    revision: "v",
    runId: "r",
    taskId: spec.id,
    taskVersion: 1,
  };
}

test("bytes descriptors are frozen, normalize MIME and reject schema/field drift", () => {
  const value = Artifact.make({
    contentType: "Text/CSV",
    id: "csv",
    kind: "bytes",
    retention: { maxAge: "30 days", maxVersions: 3 },
    version: 1,
  });
  expect(value.contentType).toBe("text/csv");
  expect(value.retention).toEqual({
    maxAgeMillis: 2_592_000_000,
    maxVersions: 3,
  });
  expect(Object.isFrozen(value)).toBe(true);
  expect("schema" in value).toBe(false);
  expect("fields" in value).toBe(false);
  expect(Json.kind).toBe("json");
  expect(Json.contentType).toBe("application/json");
  for (const invalid of [
    { id: "bad", kind: undefined, schema: Schema.String, version: 1 },
    { contentType: undefined, id: "bad", kind: "bytes", version: 1 },
    {
      contentType: "text/plain",
      id: "bad",
      kind: "bytes",
      schema: undefined,
      version: 1,
    },
    {
      contentType: "text/plain",
      fields: undefined,
      id: "bad",
      kind: "bytes",
      version: 1,
    },
    { contentType: "text/plain", id: "bad", schema: Schema.String, version: 1 },
  ]) {
    expect(() => {
      Reflect.apply(Artifact.make, undefined, [invalid]);
    }).toThrow();
  }
  for (const contentType of [
    "text/csv; charset=utf-8",
    "text/*",
    "text /csv",
    "text/é",
    "text/K",
    "text",
    `a/${"b".repeat(126)}`,
  ]) {
    expect(() =>
      Artifact.make({ contentType, id: "bad", kind: "bytes", version: 1 })
    ).toThrow();
  }
  expect(() => {
    Reflect.apply(Artifact.make, undefined, [
      { ...Bytes, schema: Schema.String },
    ]);
  }).toThrow();
  expect(() => {
    Reflect.apply(Artifact.make, undefined, [
      {
        contentType: "text/plain",
        fields: [],
        id: "bad",
        kind: "bytes",
        version: 1,
      },
    ]);
  }).toThrow();
});

test("test publications consume exact bytes, retain copied content, tags and stable receipts", async () => {
  const shared = new Uint8Array([0, 255, 42]);
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      const first = yield* storage.publish(Bytes, Stream.make(shared), {
        key: "x",
        tags: { team: "explicit" },
      });
      shared.fill(7);
      const retry = yield* storage.publish(
        Bytes,
        new Uint8Array([0, 255, 42]),
        { key: "x", tags: { team: "explicit" } }
      );
      expect(retry).toEqual(first);
      const conflict = yield* storage
        .publish(Bytes, shared, { key: "x" })
        .pipe(Effect.flip, Effect.orDie);
      expect(conflict.code).toBe("PublicationConflict");
      yield* storage.publish(Json, { count: 1 }, { key: "json" });
      return first;
    })
  );
  const result = await Effect.runPromise(
    Task.test(task, { input: null, tags: { run: "42", team: "inherited" } })
  );
  expect(result.publications).toHaveLength(2);
  const [publication] = result.publications;
  if (publication?.kind !== "bytes") {
    throw new Error("Missing bytes record");
  }
  expect(publication.bytes).toEqual(new Uint8Array([0, 255, 42]));
  expect(publication.byteLength).toBe(3);
  expect(publication.sha256).toBe(
    new Bun.CryptoHasher("sha256").update(publication.bytes).digest("hex")
  );
  expect(publication.reference.digest).toBe("test-digest-1");
  expect(publication.tags).toEqual({ run: "42", team: "explicit" });
  expect(result.publications[1]?.kind).toBe("json");
});

test("empty content and the common 16 MiB cap apply to finite arrays and streams", async () => {
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      const empty = yield* storage.publish(Bytes, new Uint8Array(), {
        key: "empty",
      });
      yield* storage.publish(Bytes, new Uint8Array(16_777_216), {
        key: "limit",
      });
      for (const source of [
        new Uint8Array(16_777_217),
        Stream.make(new Uint8Array(16_777_216), new Uint8Array(1)),
      ]) {
        const error = yield* storage
          .publish(Bytes, source, { key: "large" })
          .pipe(Effect.flip, Effect.orDie);
        expect(error.code).toBe("LimitExceeded");
      }
      return empty;
    })
  );
  const result = await Effect.runPromise(Task.test(task, { input: null }));
  expect(result.publications).toHaveLength(2);
  expect(
    result.publications[0]?.kind === "bytes" &&
      result.publications[0].byteLength
  ).toBe(0);
});

test("unsupported runtime and output membership fail before consuming source", async () => {
  let consumed = false;
  const source = Stream.fromEffect(
    Effect.sync(() => {
      consumed = true;
      return new Uint8Array(1);
    })
  );
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      const foreign = Artifact.make({
        contentType: Bytes.contentType,
        id: Bytes.id,
        kind: "bytes",
        version: 1,
      });
      const unknown = yield* storage
        .publish(foreign, source, { key: "x" })
        .pipe(Effect.flip, Effect.orDie);
      expect(unknown.code).toBe("UnknownOutput");
      expect(unknown.message).toContain("different definition instance");
      return yield* storage.publish(Bytes, source, { key: "x" });
    })
  );
  const error = await Effect.runPromise(
    task.execute(null, runtime()).pipe(Effect.flip, Effect.orDie)
  );
  expect(error.code).toBe("InvalidBoundary");
  expect(error.message).toContain("publishBytes");
  expect(consumed).toBe(false);
});

// oxlint-disable-next-line unicorn/throw-new-error -- Effect schema class factory, not an Error constructor.
class SourceFailure extends Schema.TaggedError<
  SourceFailure,
  { readonly brand: unique symbol }
>()("SourceFailure", {
  reason: Schema.String,
}) {}
class Source extends Context.Service<Source, Uint8Array>()(
  "binary-tests/Source"
) {}
class Helper extends Context.Service<Helper, typeof Bytes.refSchema.Type>()(
  "binary-tests/Helper"
) {}

test("source errors preserve declared types and release scoped resources", async () => {
  const events: string[] = [];
  const source = Stream.unwrap(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => events.push("acquire")),
        () => Effect.sync(() => events.push("release"))
      );
      return Stream.concat(
        Stream.succeed(new Uint8Array([1])),
        Stream.fail(new SourceFailure({ reason: "read failed" }))
      );
    })
  );
  const task = Task.make({ ...spec, error: SourceFailure }, () =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      return yield* storage.publish(Bytes, source, { key: "x" });
    })
  );
  const error = await Effect.runPromise(
    Task.test(task, { input: null }).pipe(Effect.flip)
  );
  expect(error).toEqual(new SourceFailure({ reason: "read failed" }));
  expect(events).toEqual(["acquire", "release"]);
});

test("task-local Layers can publish bytes and late services are closed", async () => {
  let escaped: typeof ArtifactStorage.Service | undefined;
  const helper = Layer.effect(
    Helper,
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      escaped = storage;
      return yield* storage.publish(Bytes, Stream.fromEffect(Source), {
        key: "setup",
      });
    })
  );
  const task = Task.make(spec, () => Helper)
    .provide(helper)
    .provide(Layer.succeed(Source, new Uint8Array([1, 2])));
  const result = await Effect.runPromise(Task.test(task, { input: null }));
  expect(result.publications).toHaveLength(1);
  if (!escaped) {
    throw new Error("Missing service");
  }
  const error = await Effect.runPromise(
    escaped.publish(Bytes, new Uint8Array(), { key: "late" }).pipe(Effect.flip)
  );
  expect(error.code).toBe("InvalidBoundary");
});

test("interrupting an awaited byte source releases it before fallback publication", async () => {
  const started = Deferred.makeUnsafe<boolean>();
  const events: string[] = [];
  const source = Stream.unwrap(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          events.push("release");
        })
      );
      yield* Deferred.succeed(started, true);
      return Stream.never;
    })
  );
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      const caller = yield* storage
        .publish(Bytes, source, { key: "same" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(caller);
      expect(events).toEqual(["release"]);
      return yield* storage.publish(Bytes, new Uint8Array([42]), {
        key: "same",
      });
    })
  );
  const result = await Effect.runPromise(Task.test(task, { input: null }));
  expect(result.publications).toHaveLength(1);
});

export function binaryTypeProof(storage: typeof ArtifactStorage.Service) {
  const array = storage.publish(Bytes, new Uint8Array(), { key: "x" });
  expectTypeOf<Effect.Services<typeof array>>().toEqualTypeOf<never>();
  expectTypeOf<Effect.Error<typeof array>>().toEqualTypeOf<TaskRuntimeError>();
  expectTypeOf<
    Effect.Success<typeof array>["schemaId"]
  >().toEqualTypeOf<"binary/test">();
  const failed = storage.publish(Bytes, Stream.fail("boom" as const), {
    key: "x",
  });
  expectTypeOf<Effect.Error<typeof failed>>().toEqualTypeOf<
    "boom" | TaskRuntimeError
  >();
  const sourced = storage.publish(Bytes, Stream.fromEffect(Source), {
    key: "x",
  });
  expectTypeOf<Effect.Services<typeof sourced>>().toEqualTypeOf<Source>();
  const scoped = storage.publish(
    Bytes,
    Stream.fromEffect(Effect.acquireRelease(Source, () => Effect.void)),
    { key: "x" }
  );
  expectTypeOf<Effect.Services<typeof scoped>>().toEqualTypeOf<
    Source | Scope.Scope
  >();
  // @ts-expect-error JSON values are determined by the artifact schema.
  const invalidJson = storage.publish(Json, { count: "wrong" }, { key: "x" });
  // @ts-expect-error JSON objects cannot be published to bytes artifacts.
  const invalidBytes = storage.publish(Bytes, { count: 1 }, { key: "x" });
  // @ts-expect-error Byte arrays cannot be published to the JSON artifact.
  const invalidArray = storage.publish(Json, new Uint8Array(), { key: "x" });
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      return yield* (yield* ArtifactStorage).publish(Bytes, new Uint8Array(), {
        key: "x",
      });
    })
  );
  const closed: Task.Definition<typeof spec> = task;
  Application.make({
    artifacts: [Bytes, Json],
    tasks: [closed],
  }) satisfies Application.Application<never>;
  return {
    array,
    failed,
    invalidArray,
    invalidBytes,
    invalidJson,
    scoped,
    sourced,
  };
}

export function genericPublishProof<
  Id extends string,
  BId extends string,
  S extends Schema.Codec<unknown, unknown>,
  E,
  R,
>(
  storage: typeof ArtifactStorage.Service,
  json: Artifact.Artifact<Id, S>,
  value: S["Type"],
  bytes: Artifact.Bytes<BId>,
  source: Stream.Stream<Uint8Array, E, R>
) {
  return {
    bytes: storage.publish(bytes, source, { key: "x" }),
    json: storage.publish(json, value, { key: "x" }),
  };
}
