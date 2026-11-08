import { Effect } from "effect";

import { reclaimRevisions } from "../../src/revision-reclaim-commands.ts";

const [repository, planId, boundary] = process.argv.slice(2);
if (!repository || !planId || !boundary) {
  throw new Error("Missing reclamation command fixture arguments");
}
await Effect.runPromise(
  reclaimRevisions(repository, { kind: "Apply", planId }, (name) =>
    Effect.sync(() => {
      if (name === boundary) {
        process.kill(process.pid, "SIGKILL");
      }
    })
  )
);
