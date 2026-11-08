import { writeFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";

import { ownershipLayer } from "../../src/ownership.ts";
import { createUpgradeRecoveryCopy } from "../../src/upgrade-copy.ts";

const [source, destination, planId, stage, marker] = process.argv.slice(2);
if (
  source === undefined ||
  destination === undefined ||
  planId === undefined ||
  stage === undefined ||
  marker === undefined
) {
  throw new Error("Missing recovery-copy fixture arguments");
}
await Effect.runPromise(
  createUpgradeRecoveryCopy(source, destination, planId, (current) =>
    current === stage
      ? Effect.sync(() => writeFileSync(marker, current)).pipe(
          Effect.andThen(Effect.never)
        )
      : Effect.void
  ).pipe(
    Effect.scoped,
    Effect.provide(
      ownershipLayer(path.join(source, ".effectory", "state.sqlite.owner"))
    )
  )
);
