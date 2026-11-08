import { Effect, Layer } from "effect";

import { Lake } from "./lake.ts";

/** The dependent Layer's Scope closes the worker before its shared Lake. */
export const automaticRetentionLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const lake = yield* Lake;
    yield* lake.automaticMaintenance.pipe(
      Effect.catch(() =>
        Effect.logWarning("Automatic retention maintenance will retry").pipe(
          Effect.as(false)
        )
      ),
      Effect.flatMap((busy) => Effect.sleep(busy ? "20 millis" : "1 second")),
      Effect.forever,
      Effect.forkScoped
    );
  })
);
