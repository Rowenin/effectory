import { Database } from "bun:sqlite";

import { Effect } from "effect";

import { createStore } from "../../src/host-store.ts";

const [filename, fault] = process.argv.slice(2);
if (filename === undefined) {
  throw new Error("Missing database path");
}
const db = new Database(filename);
const store = createStore(db, {
  assertActive: () => {
    /* The isolated child owns this fixture. */
  },
  token: "killed-writer",
});
db.run("PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)");
const run = Effect.runSync(
  store.submit(
    { input: null, kind: "task", requestKey: "run", targetId: "source" },
    "b".repeat(64),
    "owner"
  )
);
Effect.runSync(store.project(run.runId, "Succeeded", null));
if (fault === "orphan") {
  db.run("PRAGMA foreign_keys=OFF; UPDATE host_outbox SET runId='absent'");
}
// Leave committed state in WAL, with no checkpoint or orderly connection close.
process.kill(process.pid, "SIGKILL");
