import { expect, test } from "bun:test";

import { Effect, Redacted, Schema } from "effect";

import { AssertionFailed, Checks, Task, Vault } from "../src/index.ts";

const Secret = Vault.make({
  id: "checks/credentials",
  secrets: { token: Schema.String },
});
const canary = "CANARY-CHECKS-987654321";
const layer = Vault.layer(Secret, Vault.memory({ token: canary }));
const spec = {
  error: Schema.Union([AssertionFailed, Vault.Errors]),
  id: "checks/secrets",
  input: Schema.Null,
  replay: "idempotent" as const,
  success: Schema.Boolean,
  version: 1,
};

test("known secrets are scrubbed from stored messages and refused in identifiers", async () => {
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      const token = Redacted.value(yield* Secret.get("token"));
      const checks = yield* Checks;
      yield* checks
        .assert("safe-id", Effect.succeed(false), { message: token })
        .pipe(Effect.catchTag("AssertionFailed", () => Effect.void));
      yield* checks
        .assert(token, Effect.succeed(true), { message: "safe" })
        .pipe(
          Effect.catchTag("TaskRuntimeError", (error) => {
            expect(error.code).toBe("SecretInOutput");
            return Effect.void;
          })
        );
      yield* checks
        .assert("crash", Effect.die(token), { message: token })
        .pipe(Effect.catchCause(() => Effect.void));
      return true;
    })
  ).provide(layer);
  const result = await Effect.runPromise(Task.test(task, { input: null }));
  expect(result.checks.map((row) => row.status)).toEqual(["Failed", "Error"]);
  expect(JSON.stringify(result.checks)).not.toContain(canary);
});

test("a secret learned by a predicate is scrubbed again at completion", async () => {
  const task = Task.make(spec, () =>
    Effect.gen(function* () {
      yield* (yield* Checks).assert(
        "late",
        Secret.get("token").pipe(Effect.as(true)),
        { message: canary }
      );
      return true;
    })
  ).provide(layer);
  const result = await Effect.runPromise(Task.test(task, { input: null }));
  expect(result.checks[0]?.status).toBe("Passed");
  expect(JSON.stringify(result.checks)).not.toContain(canary);
});
