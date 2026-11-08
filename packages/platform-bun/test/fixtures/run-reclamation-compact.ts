import { writeFileSync } from "node:fs";

import { Effect } from "effect";

import { reclaimRuns } from "../../src/run-reclamation.ts";

const [repository, ready, completed] = process.argv.slice(2);
if (!repository || !ready || !completed) {
  throw new Error("Missing compaction fixture arguments");
}
await Effect.runPromise(
  reclaimRuns(repository, { kind: "compact" }, (stage) =>
    Effect.sync(() => {
      if (stage === "before-compact") {
        writeFileSync(ready, "ready");
      }
      if (stage === "after-compact") {
        writeFileSync(completed, "complete");
      }
    })
  )
);
