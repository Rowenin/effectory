import path from "node:path";

import { Effect } from "effect";

import { ownershipLayer } from "../../src/ownership.ts";
import { reclaimRevisionFiles } from "../../src/revision-reclaim-executor.ts";
import { makeReclaimJournal } from "../../src/revision-reclaim-journal.ts";

const [repository, planId, boundary] = process.argv.slice(2);
if (!repository || !planId || !boundary) {
  throw new Error("Missing reclamation fixture arguments");
}
const step = (name: string) =>
  Effect.sync(() => {
    if (name === boundary) {
      process.kill(process.pid, "SIGKILL");
    }
  });
await Effect.runPromise(
  Effect.gen(function* () {
    const journal = yield* makeReclaimJournal(repository, step);
    yield* journal.accept(planId, "c".repeat(64), "a".repeat(64), Date.now());
    yield* reclaimRevisionFiles(repository, planId, "a".repeat(64), step);
  }).pipe(
    Effect.provide(
      ownershipLayer(path.join(repository, ".effectory/state.sqlite.owner"))
    )
  )
);
