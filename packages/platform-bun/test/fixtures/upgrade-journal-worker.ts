import { writeFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";

import { ownershipLayer } from "../../src/ownership.ts";
import { makeUpgradeJournal } from "../../src/upgrade-journal.ts";

const [root, planId, digest, stage, marker] = process.argv.slice(2);
if (!root || !planId || !digest || !stage || !marker) {
  throw new Error("Missing journal fixture arguments");
}
const build = "b".repeat(64);
let checkpoints = 0;
await Effect.runPromise(
  Effect.gen(function* () {
    const journal = yield* makeUpgradeJournal(root, (name) => {
      if (name === "checkpoint-published") {
        checkpoints += 1;
      }
      return name === stage || (stage === "complete" && checkpoints === 4)
        ? Effect.sync(() => writeFileSync(marker, name)).pipe(
            Effect.andThen(Effect.never)
          )
        : Effect.void;
    });
    yield* journal.accept(
      {
        planDigest: digest,
        planId,
        recoveryDigest: "a".repeat(64),
        sourceIdentity: "a".repeat(64),
        targetBuild: build,
      },
      150
    );
    yield* journal.checkpoint(
      planId,
      build,
      { completedStep: "credentials", phase: "Fenced" },
      151
    );
    yield* journal.checkpoint(
      planId,
      build,
      { completedStep: "vault", phase: "Migrating" },
      152
    );
    yield* journal.checkpoint(
      planId,
      build,
      { completedStep: "extensions", phase: "Publishing" },
      153
    );
    yield* journal.checkpoint(
      planId,
      build,
      { completedStep: "metadata", phase: "Complete" },
      154
    );
    yield* journal.release(planId, build);
  }).pipe(
    Effect.provide(
      ownershipLayer(path.join(root, ".effectory", "state.sqlite.owner"))
    )
  )
);
