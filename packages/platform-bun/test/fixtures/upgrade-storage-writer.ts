import { Database } from "bun:sqlite";

const [filename, mode] = process.argv.slice(2);
if (!filename) {
  throw new Error("Missing database path");
}
const db = new Database(filename);
db.exec(
  "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; CREATE TABLE marker(value TEXT NOT NULL); INSERT INTO marker VALUES('checkpointed'); PRAGMA wal_checkpoint(TRUNCATE)"
);
if (mode === "reused") {
  db.exec(
    "CREATE TABLE padding(value BLOB); INSERT INTO padding VALUES(zeroblob(100000)); PRAGMA wal_checkpoint(RESTART)"
  );
}
db.exec("UPDATE marker SET value='committed-before-kill'");
// Deliberately leave the committed WAL and SHM without closing/checkpointing.
process.kill(process.pid, "SIGKILL");
