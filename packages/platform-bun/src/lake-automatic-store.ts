import type { Database } from "bun:sqlite";

import type { AutomaticReclamationStatus } from "@effectory/runtime/lake-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { reclamationReceipt } from "./lake-reclamation.ts";

export const AutomaticState = Schema.Struct({
  changedAt: Schema.NullOr(Schema.String),
  checkpoint: Schema.NullOr(Schema.String),
  cleanupError: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  enabled: Schema.Int,
  generation: Schema.Int,
  lastBatchAt: Schema.NullOr(Schema.String),
  lastPlanId: Schema.NullOr(Schema.String),
  nextAt: Schema.Finite,
  scanError: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
});

export function initializeAutomaticRetention(database: Database) {
  database
    .transaction(() => {
      database.exec(`
      CREATE TABLE IF NOT EXISTS lake_automatic_state (
        id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
        nextAt REAL NOT NULL DEFAULT 0, changedAt TEXT, startedAt TEXT, completedAt TEXT, checkpoint TEXT, lastPlanId TEXT, lastBatchAt TEXT,
        scanError TEXT, cleanupError TEXT
      );
      INSERT OR IGNORE INTO lake_automatic_state(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS lake_retention_identities (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, principal TEXT NOT NULL, artifactId TEXT NOT NULL UNIQUE, epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS lake_retention_identity_order ON lake_retention_identities(principal,sequence);
      CREATE TRIGGER IF NOT EXISTS lake_retention_identity_insert AFTER INSERT ON lake_records BEGIN
        INSERT INTO lake_retention_identities(principal,artifactId,epoch) VALUES(NEW.principal,NEW.artifactId,1)
        ON CONFLICT(artifactId) DO UPDATE SET epoch=epoch+1;
      END;
      CREATE TRIGGER IF NOT EXISTS lake_retention_identity_update AFTER UPDATE OF reclaimedAt,retentionJson,committedAtMillis ON lake_records BEGIN
        UPDATE lake_retention_identities SET epoch=epoch+1 WHERE artifactId=NEW.artifactId;
      END;
      CREATE TRIGGER IF NOT EXISTS lake_retention_identity_delete AFTER DELETE ON lake_records BEGIN
        UPDATE lake_retention_identities SET epoch=epoch+1 WHERE artifactId=OLD.artifactId;
      END;
      INSERT OR IGNORE INTO lake_retention_identities(principal,artifactId)
        SELECT principal,artifactId FROM lake_records GROUP BY artifactId;
    `);
    })
    .immediate();
}

export function automaticState(database: Database) {
  return Schema.decodeUnknownSync(AutomaticState)(
    database.query("SELECT * FROM lake_automatic_state WHERE id=1").get()
  );
}

const ErrorRecord = Schema.Struct({
  at: Schema.String,
  code: OperationError.fields.code,
  message: Schema.String,
  planId: Schema.optionalKey(Schema.String),
});
const CleanupFailure = Schema.Struct({
  failedAt: Schema.NullOr(Schema.Finite),
  planId: Schema.String,
});
export function automaticStatus(
  database: Database,
  volatile: readonly (typeof ErrorRecord.Type)[] = []
): AutomaticReclamationStatus {
  const state = automaticState(database);
  const failures: (typeof ErrorRecord.Type)[] = Schema.decodeUnknownSync(
    Schema.Array(CleanupFailure)
  )(
    database
      .query(
        "SELECT planId,failedAt FROM lake_reclamation_unlinks WHERE state='Pending' AND lastError IS NOT NULL ORDER BY failedAt DESC,id DESC LIMIT 2"
      )
      .all()
  ).map((row) => ({
    at: new Date(row.failedAt ?? 0).toISOString(),
    code: "Unavailable" as const,
    message: `Committed reclamation cleanup remains pending; retry lake reclaim apply ${row.planId}`,
    planId: row.planId,
  }));
  for (const value of [state.scanError, state.cleanupError]) {
    if (value !== null) {
      failures.push(Schema.decodeUnknownSync(ErrorRecord)(JSON.parse(value)));
    }
  }
  failures.push(...volatile);
  failures.sort((a, b) => b.at.localeCompare(a.at));
  const [first] = failures;
  return {
    changedAt: state.changedAt,
    enabled: state.enabled === 1,
    lastBatch:
      state.lastPlanId === null || state.lastBatchAt === null
        ? null
        : {
            committedAt: state.lastBatchAt,
            receipt: reclamationReceipt(database, state.lastPlanId),
          },
    lastError: first
      ? {
          ...first,
          message:
            first.message +
            (failures.length > 1
              ? "; additional maintenance failures remain"
              : ""),
        }
      : null,
    lastSweepCompletedAt: state.completedAt,
    lastSweepStartedAt: state.startedAt,
  };
}
