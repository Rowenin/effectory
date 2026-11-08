import { expect, test } from "bun:test";

import { Cause, Effect, Exit, Option } from "effect";

import { bindChecks, checksFor } from "../src/check-state.ts";
import { TaskRuntimeError } from "../src/errors.ts";
import { publicationLifetime } from "../src/publication-lifetime.ts";

const error = new TaskRuntimeError({
  code: "Unavailable",
  message: "Injected storage failure",
});
test("normal persistence failure wins over the predicate; interruption remains interruption", async () => {
  const runtime = {};
  const owner = publicationLifetime();
  owner.beginHandler();
  let finishes = 0;
  bindChecks(runtime, {
    failOn: "low",
    finish: () =>
      Effect.sync(() => {
        finishes += 1;
      }).pipe(Effect.andThen(Effect.fail(error))),
    start: () => Effect.succeed(1),
  });
  const checks = checksFor(runtime, owner);
  const failed = await Effect.runPromiseExit(
    checks.assert("failure", Effect.fail("predicate error"), {
      message: "safe",
    })
  );
  expect(
    Exit.isFailure(failed) &&
      Option.getOrUndefined(Cause.findErrorOption(failed.cause))
  ).toBe(error);
  const interrupted = await Effect.runPromiseExit(
    checks.assert("interrupt", Effect.interrupt, { message: "safe" })
  );
  expect(
    Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)
  ).toBe(true);
  expect(finishes).toBe(2);
  await Effect.runPromise(owner.close);
});
