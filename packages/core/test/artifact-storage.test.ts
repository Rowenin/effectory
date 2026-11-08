/* oxlint-disable max-classes-per-file -- Distinct services verify requirement inference and Layer lifetimes. */
import { expect, test } from "bun:test";

import { Context, Deferred, Effect, Fiber, Layer, Schema } from "effect";

import {
  Application,
  Artifact,
  ArtifactStorage,
  Tag,
  Task,
  TaskRuntimeError,
} from "../src/index.ts";

const Report = Artifact.make({
  id: "report",
  schema: Schema.Struct({ count: Schema.Int }),
  version: 1,
});
const Team = Tag.make("team", Schema.String);
const spec = {
  error: Schema.Never,
  id: "report-task",
  input: Schema.Null,
  outputs: { report: Report },
  replay: "idempotent" as const,
  success: Schema.Null,
  version: 1,
};

function runtime(publish: Task.RuntimeContext["publish"]): Task.RuntimeContext {
  return {
    attempt: 1,
    attemptId: "attempt",
    invocationPath: "task",
    key: (name) => name,
    progress: () => Effect.void,
    publish,
    revision: "revision",
    runId: "run",
    taskId: spec.id,
    taskVersion: 1,
  };
}

const fake = ArtifactStorage.of({
  publish: (artifact, _value, options) =>
    Schema.decodeUnknownEffect(artifact.refSchema)({
      artifactId: `fake/${options.key}`,
      digest: "fake-digest",
      schemaId: artifact.id,
      schemaVersion: artifact.version,
      version: 1,
    }).pipe(
      Effect.mapError(
        () =>
          new TaskRuntimeError({
            code: "InvalidBoundary",
            message: "Invalid fake reference",
          })
      )
    ),
});

test("service and legacy publications share receipts, inherited tags and typed overrides", async () => {
  const task = Task.make(spec, (_, context) =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      const first = yield* storage.publish(
        Report,
        { count: 42 },
        {
          key: "report",
          tags: [Team("explicit")],
        }
      );
      const second = yield* context.publish(
        "report",
        { count: 42 },
        {
          key: "report",
          tags: [Team("explicit")],
        }
      );
      expect(first).toEqual(second);
      return null;
    })
  );
  const result = await Effect.runPromise(
    Task.test(task, {
      input: null,
      tags: { deployment: "42", team: "inherited" },
    })
  );
  expect(result.publications).toHaveLength(1);
  expect(result.publications[0]?.tags).toEqual({
    deployment: "42",
    team: "explicit",
  });
});

test("output membership uses canonical definitions and duplicate aliases need disambiguation", async () => {
  const copy = Artifact.make({
    id: "report",
    schema: Report.schema,
    version: 1,
  });
  const task = Task.make(
    { ...spec, outputs: { first: Report, second: Report } },
    () =>
      Effect.gen(function* () {
        const storage = yield* ArtifactStorage;
        const ambiguous = yield* storage
          .publish(Report, { count: 1 }, { key: "x" })
          .pipe(Effect.flip, Effect.orDie);
        expect(ambiguous.code).toBe("InvalidBoundary");
        expect(ambiguous.message).toContain("first, second");
        const foreign = yield* storage
          .publish(copy, { count: 1 }, { key: "x" })
          .pipe(Effect.flip, Effect.orDie);
        expect(foreign.code).toBe("UnknownOutput");
        expect(foreign.message).toContain("different definition instance");
        const wrong = yield* storage
          .publish(Report, { count: 1 }, { key: "x", output: "missing" })
          .pipe(Effect.flip, Effect.orDie);
        expect(wrong.code).toBe("UnknownOutput");
        yield* storage.publish(
          Report,
          { count: 1 },
          { key: "x", output: "second" }
        );
        return null;
      })
  );
  const result = await Effect.runPromise(Task.test(task, { input: null }));
  expect(result.publications.map((p) => p.output)).toEqual(["second"]);
});

test("inner fakes replace both surfaces and recording; outside fakes are overridden", async () => {
  const task = Task.make(spec, (_, context) =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      const a = yield* storage.publish(Report, { count: 1 }, { key: "a" });
      const b = yield* context.publish("report", { count: 2 }, { key: "b" });
      expect(a.artifactId.startsWith("fake/")).toBe(
        b.artifactId.startsWith("fake/")
      );
      return null;
    })
  );
  const replaced = await Effect.runPromise(
    Task.test(task.provide(Layer.succeed(ArtifactStorage, fake)), {
      input: null,
    })
  );
  expect(replaced.publications).toHaveLength(0);
  const real = await Effect.runPromise(
    Task.test(task, { input: null }).pipe(
      Effect.provideService(ArtifactStorage, fake)
    )
  );
  expect(real.publications).toHaveLength(2);
});

class Helper extends Context.Service<Helper, string>()("storage-test/Helper") {}
class Other extends Context.Service<Other, string>()("storage-test/Other") {}

test("Layer setup can publish, shared Layers build once, finalizers and escaped services are closed", async () => {
  let acquired = 0;
  let escaped: typeof ArtifactStorage.Service | undefined;
  const layer = Layer.effect(
    Helper,
    Effect.gen(function* () {
      acquired += 1;
      const storage = yield* ArtifactStorage;
      escaped = storage;
      yield* storage.publish(Report, { count: 1 }, { key: "setup" });
      yield* Effect.addFinalizer(() =>
        storage.publish(Report, { count: 3 }, { key: "release" }).pipe(
          Effect.flip,
          Effect.orDie,
          Effect.map((error) => expect(error.message).toBe("Invocation closed"))
        )
      );
      return "helper";
    })
  );
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      expect(yield* Helper).toBe("helper");
      yield* (yield* ArtifactStorage).publish(
        Report,
        { count: 2 },
        { key: "handler" }
      );
      return null;
    })
  )
    .provide(layer)
    .provide(layer);
  const result = await Effect.runPromise(Task.test(task, { input: null }));
  expect(acquired).toBe(1);
  expect(result.publications.map((p) => p.output)).toEqual([
    "report",
    "report",
  ]);
  if (!escaped) {
    throw new Error("Service was not captured");
  }
  const error = await Effect.runPromise(
    escaped
      .publish(Report, { count: 4 }, { key: "late" })
      .pipe(Effect.flip, Effect.orDie)
  );
  expect(error.code).toBe("InvalidBoundary");
});

for (const failAcquisition of [false, true]) {
  test(`detached setup publications stop before source release (acquisition failure: ${failAcquisition})`, async () => {
    const events: string[] = [];
    const started = Deferred.makeUnsafe<boolean>();
    const layer = Layer.effect(
      Helper,
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            events.push("acquire");
            return "source";
          }),
          () =>
            Effect.sync(() => {
              events.push("release");
            })
        );
        const storage = yield* ArtifactStorage;
        yield* storage
          .publish(Report, { count: 1 }, { key: "pending" })
          .pipe(Effect.forkDetach);
        yield* Deferred.await(started);
        if (failAcquisition) {
          return yield* new TaskRuntimeError({
            code: "InvalidBoundary",
            message: "setup failed",
          });
        }
        return "source";
      })
    );
    const task = Task.make(spec, () => Effect.succeed(null)).provide(layer);
    const exit = await Effect.runPromiseExit(
      task.execute(
        null,
        runtime(() =>
          Deferred.succeed(started, true).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                events.push("interrupt");
              })
            )
          )
        )
      )
    );
    expect(exit._tag).toBe(failAcquisition ? "Failure" : "Success");
    expect(events).toEqual(["acquire", "interrupt", "release"]);
  });
}

test("interrupting a publish caller waits for its child cleanup and cannot commit later", async () => {
  const started = Deferred.makeUnsafe<boolean>();
  const gate = Deferred.makeUnsafe<boolean>();
  const events: string[] = [];
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      const caller = yield* storage
        .publish(Report, { count: 1 }, { key: "x" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(caller);
      expect(events).toEqual(["cleanup"]);
      yield* Deferred.succeed(gate, true);
      yield* Effect.yieldNow;
      return null;
    })
  );
  await Effect.runPromise(
    task.execute(
      null,
      runtime(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, true);
          yield* Deferred.await(gate);
          events.push("commit");
          return yield* fake.publish(Report, { count: 1 }, { key: "x" });
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              events.push("cleanup");
            })
          )
        )
      )
    )
  );
  expect(events).toEqual(["cleanup"]);
});

export function storageTypeProof() {
  const publish = Effect.gen(function* () {
    const storage = yield* ArtifactStorage;
    const ref = yield* storage.publish(Report, { count: 1 }, { key: "x" });
    const id: "report" = ref.schemaId;
    // @ts-expect-error The artifact alone determines the value type.
    const invalid = storage.publish(Report, { count: "bad" }, { key: "x" });
    void invalid;
    return id;
  });
  const standalone: Effect.Effect<"report", TaskRuntimeError, ArtifactStorage> =
    publish;
  const layer = Layer.effect(
    Helper,
    Effect.gen(function* () {
      yield* ArtifactStorage;
      return yield* Other;
    })
  );
  const task = Task.make(spec, () => Effect.as(Helper, null)).provide(layer);
  const needed: Task.Definition<typeof spec, Other> = task;
  // @ts-expect-error Other must still be supplied.
  Application.make({ tasks: [task] }) satisfies Application.Application<never>;
  Application.make({
    tasks: [task.provide(Layer.succeed(Other, "ok"))],
  }) satisfies Application.Application<never>;
  const implementation = Task.implementation(
    { id: "replacement", target: Task.contract(spec) },
    () => Effect.as(standalone, null)
  );
  const closed: Task.Definition<typeof spec, never> = implementation;
  return { closed, needed };
}

test("parallel Layer failure closes publications before acquired resources unwind", async () => {
  const started = Deferred.makeUnsafe<boolean>();
  const events: string[] = [];
  const source = Layer.effect(
    Helper,
    Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.succeed("source"), () =>
        Effect.sync(() => {
          events.push("release");
        })
      );
      const storage = yield* ArtifactStorage;
      yield* storage
        .publish(Report, { count: 1 }, { key: "pending" })
        .pipe(Effect.forkDetach);
      yield* Deferred.await(started);
      return "source";
    })
  );
  const failing = Layer.effect(
    Other,
    Deferred.await(started).pipe(
      Effect.andThen(
        Effect.fail(
          new TaskRuntimeError({
            code: "InvalidBoundary",
            message: "parallel setup failed",
          })
        )
      )
    )
  );
  const task = Task.make(spec, () => Effect.succeed(null)).provide(
    Layer.mergeAll(source, failing)
  );
  const exit = await Effect.runPromiseExit(
    task.execute(
      null,
      runtime(() =>
        Deferred.succeed(started, true).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              events.push("interrupt");
            })
          )
        )
      )
    )
  );
  expect(exit._tag).toBe("Failure");
  expect(events).toEqual(["interrupt", "release"]);
});

test("a Layer failing after additional acquisition closes before every finalizer", async () => {
  const started = Deferred.makeUnsafe<boolean>();
  const events: string[] = [];
  const layer = Layer.effect(
    Helper,
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      yield* storage
        .publish(Report, { count: 1 }, { key: "pending" })
        .pipe(Effect.forkDetach);
      yield* Deferred.await(started);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          events.push("release");
        })
      );
      return yield* new TaskRuntimeError({
        code: "InvalidBoundary",
        message: "late setup failure",
      });
    })
  );
  const task = Task.make(spec, () => Effect.succeed(null)).provide(layer);
  const exit = await Effect.runPromiseExit(
    task.execute(
      null,
      runtime(() =>
        Deferred.succeed(started, true).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              events.push("interrupt");
            })
          )
        )
      )
    )
  );
  expect(exit._tag).toBe("Failure");
  expect(events).toEqual(["interrupt", "release"]);
});

test("concurrent invocations and repeated attempts keep storage and metadata isolated", async () => {
  const captured: (typeof ArtifactStorage.Service)[] = [];
  const layer = Layer.effect(
    Helper,
    Effect.gen(function* () {
      captured.push(yield* ArtifactStorage);
      return "helper";
    })
  );
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      yield* Effect.yieldNow;
      yield* (yield* ArtifactStorage).publish(
        Report,
        { count: 1 },
        { key: "same" }
      );
      return null;
    })
  ).provide(layer);
  const results = await Effect.runPromise(
    Effect.all(
      [
        Task.test(task, { input: null, tags: [Team("one")] }),
        Task.test(task, { input: null, tags: [Team("two")] }),
      ],
      { concurrency: "unbounded" }
    )
  );
  expect(results.map((result) => result.publications[0]?.tags.team)).toEqual([
    "one",
    "two",
  ]);
  expect(captured[0]).not.toBe(captured[1]);
  const errors = await Effect.runPromise(
    Effect.all(
      captured.map((storage) =>
        storage.publish(Report, { count: 2 }, { key: "late" }).pipe(Effect.flip)
      )
    )
  );
  expect(errors.map((error) => error.message)).toEqual([
    "Invocation closed",
    "Invocation closed",
  ]);
});

test("legacy publication retains its no-service contract under an explicitly replaced context", async () => {
  const task = Task.make(spec, (_, context) =>
    context
      .publish("report", { count: 7 }, { key: "fallback" })
      .pipe(Effect.setContext(Context.empty()), Effect.as(null))
  );
  const result = await Effect.runPromise(Task.test(task, { input: null }));
  expect(result.publications[0]?.value).toEqual({ count: 7 });
});
