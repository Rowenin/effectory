# Checks and task outcomes

Use `Checks` for observations you want recorded with an invocation. Yield the returned Effect: constructing an assertion does not evaluate its predicate. Keep the predicate's ordinary Effect errors in the task's declared error schema; they are not converted into a passing check.

Create `effectory.ts`:

```ts
import {
  Application,
  AssertionFailed,
  Checks,
  Task,
} from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

export const VerifyCapacity = Task.make(
  {
    id: "capacity/verify",
    version: 1,
    input: Schema.Struct({ actual: Schema.Int, required: Schema.Int }),
    success: Schema.Boolean,
    error: AssertionFailed,
    replay: "idempotent",
  },
  ({ actual, required }) =>
    Effect.gen(function* () {
      const checks = yield* Checks;
      yield* checks.assert("minimum", Effect.succeed(actual >= required), {
        message: "Required capacity is available",
        severity: "high",
      });
      yield* checks.assert("spare", Effect.succeed(actual > required), {
        message: "Spare capacity is available",
        severity: "low",
      });
      return true;
    })
);

export default Application.make({
  tasks: [VerifyCapacity],
}) satisfies Application.Application<never>;
```

Create `effectory.test.ts`:

```ts
import { expect, test } from "bun:test";

import { Task } from "@offtree/effectory-sdk";
import { Cause, Effect, Exit, Option } from "effect";

import { VerifyCapacity } from "./effectory.ts";

test("sufficient spare capacity passes both checks", async () => {
  const result = await Effect.runPromise(
    Task.test(VerifyCapacity, { input: { actual: 4, required: 3 } })
  );
  expect(result.value).toBe(true);
  expect(result.checks.map((row) => [row.id, row.status])).toEqual([
    ["minimum", "Passed"],
    ["spare", "Passed"],
  ]);
});

test("a higher threshold does not rewrite a failed observation", async () => {
  const result = await Effect.runPromise(
    Task.test(VerifyCapacity, {
      input: { actual: 3, required: 3 },
      checks: { failOn: "high" },
    })
  );
  expect(result.value).toBe(true);
  expect(result.checks.map((row) => [row.id, row.status])).toEqual([
    ["minimum", "Passed"],
    ["spare", "Failed"],
  ]);
});

test("the default threshold fails on a low-severity observation", async () => {
  const exit = await Effect.runPromiseExit(
    Task.test(VerifyCapacity, { input: { actual: 3, required: 3 } })
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(
      Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    ).toMatchObject({
      _tag: "AssertionFailed",
      id: "spare",
      severity: "low",
    });
  }
});
```

The default threshold is `low`. A false observation at or above the threshold fails with `AssertionFailed`. Raising the threshold allows the handler to continue past lower-severity failures; their recorded status remains `Failed`. It does not suppress evaluator errors or defects. Catching `AssertionFailed` deliberately also does not erase its recorded observation.

The example only compares its input, so idempotent replay is appropriate. A predicate that calls a provider must account for that provider's errors and effects. Re-evaluation on another entry is not guaranteed to produce the original observation. Declare retry policy only where repeating that work is appropriate; an `AssertionFailed` tag is not a general reason to repeat external mutations.

For an initialized project containing this application, use the existing commands:

```sh
effectory daemon start
effectory task run capacity/verify --input '{"actual":3,"required":3}' --fail-on high --json
effectory run checks <run-id>
effectory run junit <run-id>
effectory daemon stop
```

The task succeeds at that threshold while the spare-capacity observation remains failed, including in JUnit output. A consumer of JUnit may apply its own failure policy; the run's threshold does not turn the XML observation into a pass. Export requires a terminal run. Use `--attempts all` on check history when investigating earlier entries rather than assuming the default view includes them.

Checks can run during task-local Layer acquisition and the handler, including a nested scope whose resources finish before the assertion completes. They cannot be started from task-local Layer finalizers or a captured service after the invocation closes. Keep check IDs stable and unique within an entry; use bounded item identities instead of unbounded dynamically generated IDs. Check counts and telemetry are bounded, so a check per item in an unrestricted loop is not an unlimited reporting channel.

The formatted application and test snippets passed strict typecheck against the workspace SDK and three tests with six assertions. They cover evaluation and thresholds; they do not establish CLI export, restart, retry or crash recovery for this application. This remains draft skill content, not an installed harness skill.
