import { writeFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";

import { ownershipLayer } from "../../src/ownership.ts";
import { retargetVaultFence } from "../../src/upgrade-vault-fence.ts";

const [repository, planId, targetBuild, priorPlan, priorBuild, action, stage] =
  process.argv.slice(2);
if (
  !repository ||
  !planId ||
  !targetBuild ||
  !priorPlan ||
  !priorBuild ||
  (action !== "Protect" && action !== "Abort") ||
  !stage
) {
  throw new Error("Missing format-2 crash fixture arguments");
}
await Effect.runPromise(
  retargetVaultFence(
    repository,
    { planId, targetBuild },
    { planId: priorPlan, targetBuild: priorBuild },
    action,
    (name) => {
      if (name === stage) {
        writeFileSync(path.join(repository, "..", "checkpoint"), name);
        process.kill(process.pid, "SIGKILL");
      }
    }
  ).pipe(
    Effect.provide(
      ownershipLayer(`${repository}/.effectory/state.sqlite.owner`)
    )
  )
);
throw new Error("Crash checkpoint was not reached");
