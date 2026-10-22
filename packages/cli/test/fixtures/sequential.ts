import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";

const workflow = Workflow.make("EffectoryCliRestartProof", {
  error: Schema.String,
  idempotencyKey: (input) => input.requestId,
  payload: { baseUrl: Schema.String, requestId: Schema.String },
  success: Schema.String,
});

export default {
  description:
    "Sequential loopback activity commit barrier for process acceptance tests",
  implementation: workflow.toLayer((input) =>
    Effect.gen(function* implementation() {
      const first = yield* Activity.make({
        error: Schema.String,
        execute: Effect.tryPromise({
          catch: String,
          try: async (signal) => {
            const response = await fetch(`${input.baseUrl}/first`, { signal });
            return response.text();
          },
        }),
        name: "first",
        success: Schema.String,
      });
      // Entering the second request proves the first Activity reply committed.
      yield* Activity.make({
        error: Schema.String,
        execute: Effect.tryPromise({
          catch: String,
          try: async (signal) => {
            const response = await fetch(`${input.baseUrl}/blocked`, {
              signal,
            });
            return response.text();
          },
        }),
        name: "second",
        success: Schema.String,
      });
      return first;
    })
  ),
  workflow,
};
