/* oxlint-disable max-classes-per-file -- Independent Effect service requirements. */
import { expect, test } from "bun:test";

import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Scope,
} from "effect";

import {
  Application,
  Artifact,
  ArtifactStorage,
  AssertionFailed,
  Checks,
  Task,
  TaskRuntimeError,
} from "../src/index.ts";

const spec = {
  error: AssertionFailed,
  id: "verify",
  input: Schema.Null,
  replay: "idempotent" as const,
  success: Schema.Boolean,
  version: 1,
};
class Resource extends Context.Service<Resource, boolean>()(
  "checks/Resource"
) {}
// oxlint-disable-next-line unicorn/throw-new-error -- Schema factory, not a constructor.
class DomainError extends Schema.TaggedError<
  DomainError,
  { readonly brand: unique symbol }
>()("DomainError", {}) {}
function failure<E, A>(exit: Exit.Exit<A, E>): E | undefined {
  return Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : undefined;
}

test("checks are lazy, record boolean results and respect thresholds without changing false observations", async () => {
  let evaluated = 0;
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      const checks = yield* Checks;
      const unused = checks.assert(
        "unused",
        Effect.sync(() => {
          evaluated += 1;
          return true;
        }),
        { message: "unused" }
      );
      void unused;
      yield* checks.assert("true", Effect.succeed(true), { message: "passed" });
      yield* checks.assert("low", Effect.succeed(false), {
        message: "low failure",
        severity: "low",
      });
      yield* checks
        .assert("caught", Effect.succeed(false), { message: "caught" })
        .pipe(Effect.catchTag("AssertionFailed", () => Effect.void));
      return true;
    })
  );
  const result = await Effect.runPromise(
    Task.test(task, { checks: { failOn: "high" }, input: null })
  );
  expect(evaluated).toBe(0);
  expect(result.checks.map((row) => [row.id, row.status])).toEqual([
    ["true", "Passed"],
    ["low", "Failed"],
    ["caught", "Failed"],
  ]);
  expect(
    result.checks.every(
      (row) => row.durationMillis === 0 && Object.isFrozen(row)
    )
  ).toBe(true);
  const blocked = await Effect.runPromiseExit(Task.test(task, { input: null }));
  expect(failure(blocked)).toBeInstanceOf(AssertionFailed);
});

test("evaluation errors retain their types; defects and runtime nonbooleans cannot become passes", async () => {
  const task = Task.make({ ...spec, error: DomainError }, () =>
    Effect.gen(function* () {
      const checks = yield* Checks;
      yield* checks
        .assert("domain", Effect.fail(new DomainError()), {
          message: "not persisted as the error",
        })
        .pipe(Effect.catchTag("AssertionFailed", Effect.die));
      return true;
    })
  );
  expect(
    failure(await Effect.runPromiseExit(Task.test(task, { input: null })))
  ).toBeInstanceOf(DomainError);
  const caught = Task.make(spec, () =>
    Effect.gen(function* () {
      const checks = yield* Checks;
      yield* checks
        .assert("defect", Effect.die("PRIVATE-CAUSE"), { message: "safe" })
        .pipe(Effect.ignoreCause);
      // JavaScript callers must not be able to record truthy values as Passed.
      // @ts-expect-error a predicate must return a boolean
      const nonboolean: Effect.Effect<boolean> = Effect.succeed(1);
      yield* checks
        .assert("nonboolean", nonboolean, { message: "safe" })
        .pipe(Effect.ignoreCause);
      return true;
    })
  );
  const result = await Effect.runPromise(Task.test(caught, { input: null }));
  expect(result.checks.map((row) => row.status)).toEqual(["Error", "Error"]);
  expect(JSON.stringify(result.checks)).not.toContain("PRIVATE-CAUSE");
});

test("Layer acquisition and nested scopes work; Layer release and captured services are closed", async () => {
  let captured: Checks["Service"] | undefined;
  const order: string[] = [];
  const artifact = Artifact.make({
    id: "check/output",
    schema: Schema.Boolean,
    version: 1,
  });
  const layer = Layer.effect(
    Resource,
    Effect.gen(function* () {
      const checks = yield* Checks;
      captured = checks;
      const storage = yield* ArtifactStorage;
      yield* checks.assert(
        "setup",
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                order.push("nested release");
              })
            );
            yield* storage.publish(artifact, true, { key: "setup" });
            return true;
          })
        ),
        { message: "setup" }
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const result = yield* Effect.exit(
            checks.assert("release", Effect.succeed(true), { message: "late" })
          );
          expect(failure(result)).toBeInstanceOf(TaskRuntimeError);
          order.push("layer release");
        })
      );
      return true;
    })
  );
  const task = Task.make(
    { ...spec, outputs: { result: artifact } },
    () => Resource
  ).provide(layer);
  const app = Application.make({
    tasks: [task],
  }) satisfies Application.Application<never>;
  expect(app).toBeDefined();
  const result = await Effect.runPromise(Task.test(task, { input: null }));
  expect(result.checks.map((row) => row.id)).toEqual(["setup"]);
  expect(order).toEqual(["nested release", "layer release"]);
  if (!captured) {
    throw new Error("No captured service");
  }
  expect(
    failure(
      await Effect.runPromiseExit(
        captured.assert("late", Effect.succeed(true), { message: "late" })
      )
    )
  ).toBeInstanceOf(TaskRuntimeError);
});

test("caller interruption awaits predicate cleanup and records Incomplete before continuing", async () => {
  const order: string[] = [];
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      const checks = yield* Checks;
      yield* checks
        .assert(
          "slow",
          Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                order.push("released");
              })
            )
          ),
          { message: "slow" }
        )
        .pipe(Effect.timeout("10 millis"), Effect.ignoreCause);
      order.push("continued");
      return true;
    })
  );
  const result = await Effect.runPromise(Task.test(task, { input: null }));
  expect(result.checks[0]?.status).toBe("Incomplete");
  expect(order).toEqual(["released", "continued"]);
});

test("detached checks are interrupted before task Layer resources release", async () => {
  const order: string[] = [];
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      const checks = yield* Checks;
      const entered = yield* Deferred.make<boolean>();
      yield* checks
        .assert(
          "detached",
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, true);
            return yield* Effect.never;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                order.push("predicate closed");
              })
            )
          ),
          { message: "detached" }
        )
        .pipe(Effect.forkDetach);
      yield* Deferred.await(entered);
      return true;
    })
  ).provide(
    Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          order.push("layer closed");
        })
      )
    )
  );
  const result = await Effect.runPromise(Task.test(task, { input: null }));
  expect(result.checks[0]?.status).toBe("Incomplete");
  expect(order).toEqual(["predicate closed", "layer closed"]);
});

test("ids and limits are checked before predicates, and a Task.provide fake replaces recording", async () => {
  let calls = 0;
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      const checks = yield* Checks;
      yield* checks.assert("same", Effect.succeed(true), { message: "first" });
      const duplicate = yield* Effect.exit(
        checks.assert(
          "same",
          Effect.sync(() => {
            calls += 1;
            return true;
          }),
          { message: "duplicate" }
        )
      );
      expect(failure(duplicate)).toMatchObject({ code: "InvalidBoundary" });
      const tooLarge = yield* Effect.exit(
        checks.assert(
          "large",
          Effect.sync(() => {
            calls += 1;
            return true;
          }),
          { message: "😀".repeat(501) }
        )
      );
      expect(failure(tooLarge)).toMatchObject({ code: "LimitExceeded" });
      return true;
    })
  );
  const recorded = await Effect.runPromise(Task.test(task, { input: null }));
  expect(recorded.checks).toHaveLength(1);
  expect(calls).toBe(0);
  const fake = Task.make(spec, () =>
    Effect.gen(function* () {
      yield* (yield* Checks).assert("fake", Effect.succeed(false), {
        message: "fake",
      });
      return true;
    })
  ).provide(Layer.succeed(Checks, Checks.of({ assert: () => Effect.void })));
  const overridden = await Effect.runPromise(Task.test(fake, { input: null }));
  expect(overridden.checks).toHaveLength(0);
});

// Compile-time dependencies must survive until the caller provides/scopes them.
const typed = Effect.gen(function* () {
  const checks = yield* Checks;
  const result: Effect.Effect<
    void,
    AssertionFailed | TaskRuntimeError | DomainError,
    Resource | Scope.Scope
  > = checks.assert(
    "typed",
    Effect.gen(function* () {
      yield* Scope.Scope;
      return yield* Resource;
    }).pipe(Effect.andThen(Effect.fail(new DomainError()))),
    { message: "typed" }
  );
  const bad = checks.assert("bad", Effect.succeed(true), {
    message: "bad",
    // @ts-expect-error invalid severity is rejected
    severity: "critical",
  });
  void bad;
  return yield* result;
});
void typed;
