import { writeFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";

import { ownershipLayer } from "../../src/ownership.ts";
import { fileFence } from "../../src/upgrade-file-fence.ts";
import { vaultFence } from "../../src/upgrade-vault-fence.ts";

const [repository, planId, targetBuild, original, stage] =
  process.argv.slice(2);
if (
  repository === undefined ||
  planId === undefined ||
  targetBuild === undefined ||
  stage === undefined
) {
  throw new Error("Missing crash fixture arguments");
}
const checkpoint = (name: string) => {
  if (name === stage) {
    writeFileSync(path.join(repository, "..", "checkpoint"), name);
    process.kill(process.pid, "SIGKILL");
  }
};
const action = stage.startsWith("file-")
  ? fileFence(
      repository,
      "Credentials",
      { planId, targetBuild },
      "Protect",
      checkpoint
    )
  : vaultFence(
      repository,
      { planId, targetBuild },
      "Protect",
      original === "yes",
      checkpoint
    );
await Effect.runPromise(
  action.pipe(
    Effect.provide(
      ownershipLayer(`${repository}/.effectory/state.sqlite.owner`)
    )
  )
);
throw new Error("Crash checkpoint was not reached");
