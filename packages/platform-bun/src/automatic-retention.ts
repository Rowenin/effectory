import { Effect, Layer } from "effect";

import { Lake } from "./lake.ts";

/** The dependent Layer's Scope closes the worker before its shared Lake. */
export const automaticRetentionLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const lake = yield* Lake;
    // automaticMaintenance records its own failures and never fails.
    yield* lake.automaticMaintenance.pipe(
      Effect.flatMap((busy) => Effect.sleep(busy ? "20 millis" : "1 second")),
      Effect.forever,
      Effect.forkScoped
    );
  })
);
