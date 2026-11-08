import { writeFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";

import { ownershipLayer } from "../../src/ownership.ts";
import { resumeRuntimeUpgrade } from "../../src/upgrade-executor.ts";
import { makeUpgradeJournal } from "../../src/upgrade-journal.ts";
import { executorTestPolicy } from "./upgrade-executor-policy.ts";

const [repository, planId, stage] = process.argv.slice(2);
if (!repository || !planId || !stage) {
  throw new Error("Missing crash fixture arguments");
}
await Effect.runPromise(
  Effect.gen(function* () {
    const journal = yield* makeUpgradeJournal(repository);
    const saved = yield* journal.inspect(planId);
    if (saved._tag !== "Accepted") {
      throw new Error("Fixture was not accepted");
    }
    yield* resumeRuntimeUpgrade(
      repository,
      saved.transition,
      executorTestPolicy(saved.transition.plan),
      (name) =>
        Effect.sync(() => {
          if (name === stage) {
            writeFileSync(path.join(repository, "..", "checkpoint"), name);
            process.kill(process.pid, "SIGKILL");
          }
        })
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ownershipLayer(path.join(repository, ".effectory/state.sqlite.owner"))
    )
  )
);
throw new Error("Crash checkpoint was not reached");
