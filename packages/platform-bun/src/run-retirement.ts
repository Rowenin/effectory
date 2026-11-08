import type { Database } from "bun:sqlite";

import { OperationError } from "@effectory/runtime/protocol";
import { Schema } from "effect";

export const terminalSql =
  "'Succeeded','Failed','Rejected','TimedOut','Cancelled'";
export const RetirementInstant = Schema.String.check(
  Schema.makeFilter(
    (value: string) => {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) && date.toISOString() === value;
    },
    { expected: "canonical UTC timestamp including milliseconds" }
  )
);
export const RetirementReceipt = Schema.Struct({
  completedAt: RetirementInstant,
  deletedRows: Schema.Record(Schema.String, Schema.Int),
  planId: Schema.String,
  retiredFamilies: Schema.Int,
  retiredRuns: Schema.Int,
  startedAt: RetirementInstant,
});
export const RetiredRun = Schema.Struct({
  acceptedAt: RetirementInstant,
  completedAt: RetirementInstant,
  kind: Schema.Literals(["task", "workflow"]),
  planId: Schema.String,
  retiredAt: RetirementInstant,
  revision: Schema.String,
  runId: Schema.String,
  sourceRunId: Schema.String,
  status: Schema.Literals([
    "Succeeded",
    "Failed",
    "Rejected",
    "TimedOut",
    "Cancelled",
  ]),
  targetId: Schema.String,
});
export const retirementError = (
  code: OperationError["code"],
  message: string
) => new OperationError({ code, message });
export const retiredHint = (id: string) =>
  `Run ${id} was retired; inspect with run reclaim inspect ${id}.`;

/** Also initialized by standalone lake fixtures; contains no foreign keys to host state. */
export function initializeRetiredRuns(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS host_retired_runs (
      runId TEXT PRIMARY KEY, sourceRunId TEXT NOT NULL, principal TEXT NOT NULL,
      admissionLane TEXT NOT NULL, requestKey TEXT NOT NULL, fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (${terminalSql})), recordJson TEXT NOT NULL, scheduleJson TEXT,
      UNIQUE(principal,admissionLane,requestKey)
    );
    CREATE TABLE IF NOT EXISTS host_retired_targets (
      kind TEXT NOT NULL, id TEXT NOT NULL, principal TEXT NOT NULL, sourceRunId TEXT NOT NULL,
      PRIMARY KEY(kind,id,principal)
    );
    CREATE TABLE IF NOT EXISTS host_retirement_epoch (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL);
    INSERT OR IGNORE INTO host_retirement_epoch VALUES(1,0);
  `);
}
export function initializeRunRetirement(db: Database) {
  initializeRetiredRuns(db);
  db.run(`
    CREATE TABLE IF NOT EXISTS host_run_completions (runId TEXT PRIMARY KEY, completedAt TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS host_run_completed AFTER UPDATE OF status ON host_runs
    WHEN NEW.status IN (${terminalSql}) AND OLD.status NOT IN (${terminalSql}) BEGIN
      INSERT OR IGNORE INTO host_run_completions VALUES(NEW.runId,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    END;
    CREATE INDEX IF NOT EXISTS host_completion_time ON host_run_completions(completedAt,runId);
    CREATE TABLE IF NOT EXISTS host_retirement_plans (
      planId TEXT PRIMARY KEY, repositoryId TEXT NOT NULL, principal TEXT NOT NULL, format INTEGER NOT NULL,
      createdAt TEXT NOT NULL, expiresAt REAL NOT NULL, state TEXT NOT NULL,
      summaryJson TEXT NOT NULL, startedAt TEXT, receiptJson TEXT
    );
    CREATE TABLE IF NOT EXISTS host_retirement_families (
      planId TEXT NOT NULL, sourceRunId TEXT NOT NULL, fingerprint TEXT NOT NULL,
      PRIMARY KEY(planId,sourceRunId)
    );
    CREATE TABLE IF NOT EXISTS host_retirement_members (
      planId TEXT NOT NULL, runId TEXT NOT NULL, sourceRunId TEXT NOT NULL,
      PRIMARY KEY(planId,runId)
    );
    CREATE TABLE IF NOT EXISTS host_retirement_native (
      planId TEXT NOT NULL, entityType TEXT NOT NULL, entityId TEXT NOT NULL,
      PRIMARY KEY(planId,entityType,entityId)
    );
    CREATE TABLE IF NOT EXISTS host_retirement_counts (
      planId TEXT NOT NULL, category TEXT NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY(planId,category)
    );
    INSERT OR IGNORE INTO host_run_completions
      SELECT r.runId,MIN(e.at) FROM host_runs r JOIN host_events e ON e.runId=r.runId
      WHERE r.status IN (${terminalSql}) AND e.tag='RunStatus'
        AND json_extract(e.payloadJson,'$.status') IN (${terminalSql})
      GROUP BY r.runId HAVING COUNT(*)=1 AND MIN(json_extract(e.payloadJson,'$.status'))=r.status;
  `);
}
export function retirementEpoch(db: Database) {
  return Schema.decodeUnknownSync(Schema.Struct({ epoch: Schema.Int }))(
    db.query("SELECT epoch FROM host_retirement_epoch WHERE id=1").get()
  ).epoch;
}
export function retiredRun(db: Database, id: string, principal?: string) {
  const raw = db
    .query<{ recordJson: string }, [string, string | null, string | null]>(
      "SELECT recordJson FROM host_retired_runs WHERE runId=? AND (? IS NULL OR principal=?)"
    )
    .get(id, principal ?? null, principal ?? null);
  return raw
    ? Schema.decodeUnknownSync(RetiredRun)(JSON.parse(raw.recordJson))
    : null;
}
export function refuseRetired(
  db: Database,
  kind: string,
  id: string,
  principal: string,
  mutation = false
) {
  const raw = db
    .query<{ sourceRunId: string }, [string, string, string]>(
      "SELECT sourceRunId FROM host_retired_targets WHERE kind=? AND id=? AND principal=?"
    )
    .get(kind, id, principal);
  if (raw) {
    throw retirementError(
      mutation ? "Conflict" : "NotFound",
      retiredHint(raw.sourceRunId)
    );
  }
}
export function refuseRetiredSubmission(
  db: Database,
  principal: string,
  namespace: string,
  key: string,
  fingerprint: string
) {
  const row = db
    .query<{ runId: string; fingerprint: string }, [string, string, string]>(
      "SELECT runId,fingerprint FROM host_retired_runs WHERE principal=? AND admissionLane=? AND requestKey=?"
    )
    .get(principal, namespace, key);
  if (row) {
    throw retirementError(
      "Conflict",
      row.fingerprint === fingerprint
        ? `${retiredHint(row.runId)} Use a new request key only to intentionally start another run.`
        : "Request key was used for another submission"
    );
  }
}
