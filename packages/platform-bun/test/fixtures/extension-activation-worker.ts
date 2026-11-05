import { Database } from "bun:sqlite";
import path from "node:path";

import { Effect } from "effect";

import { createExtensionJournal } from "../../src/extension-journal.ts";
import { RepositoryLease, ownershipLayer } from "../../src/ownership.ts";

const repository = process.argv.at(2);
const phase = process.argv.at(3);
if (!repository || !phase) {
  throw new Error("Missing repository/phase");
}
await Effect.runPromise(
  Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const database = new Database(
      path.join(repository, ".effectory/state.sqlite")
    );
    const journal = createExtensionJournal(database, repository, lease);
    const operation = journal.next();
    if (!operation) {
      return yield* Effect.die("Missing operation");
    }
    journal.start(operation.snapshot.operationId, "owner");
    journal.begin(operation.snapshot.operationId, "owner", "b".repeat(64));
    if (phase === "intent") {
      process.kill(process.pid, "SIGKILL");
    }
    journal.publish((boundary) => {
      if (phase === boundary) {
        process.kill(process.pid, "SIGKILL");
      }
    });
    return yield* Effect.die(
      "Expected to die at the requested activation boundary"
    );
  }).pipe(
    Effect.provide(
      ownershipLayer(path.join(repository, ".effectory/state.sqlite.owner"))
    )
  )
);
