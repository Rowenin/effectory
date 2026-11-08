import {
  Application,
  AssertionFailed,
  Checks,
  Task,
} from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

const Verify = Task.make(
  {
    error: AssertionFailed,
    id: "example/verify",
    input: Schema.Struct({ actual: Schema.Int, expected: Schema.Int }),
    replay: "idempotent",
    success: Schema.Boolean,
    version: 1,
  },
  ({ actual, expected }) =>
    Effect.gen(function* () {
      const checks = yield* Checks;
      yield* checks.assert(
        "instance-count",
        Effect.succeed(actual === expected),
        {
          message: "Instance count must match the deployment target",
        }
      );
      yield* checks.assert(
        "spare-capacity",
        Effect.succeed(actual > expected),
        {
          message: "Spare capacity is available",
          severity: "low",
        }
      );
      return true;
    })
);

export default Application.make({
  tasks: [Verify],
}) satisfies Application.Application<never>;
