import { Effect } from "effect";

import { reclaimRuns } from "../../src/run-reclamation.ts";

const [repository, planId, stage] = process.argv.slice(2);
if (!repository || !planId || !stage) {
  throw new Error("Missing retirement crash fixture arguments");
}
await Effect.runPromise(
  reclaimRuns(repository, { kind: "apply", planId }, (current) =>
    current === stage
      ? Effect.sync(() => {
          process.kill(process.pid, "SIGKILL");
        })
      : Effect.void
  )
);
