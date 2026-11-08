import type { Database } from "bun:sqlite";

import { OperationError } from "@effectory/runtime/protocol";
import { Schema } from "effect";

export const RetentionPolicy = Schema.Struct({
  maxAgeMillis: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  maxVersions: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});

export function initializeRetention(database: Database) {
  const columns = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ name: Schema.String }))
  )(database.query("PRAGMA table_info(lake_records)").all());
  const names = new Set(columns.map((column) => column.name));
  database.transaction(() => {
    for (const [name, type] of [
      ["retentionJson", "TEXT"],
      ["committedAtMillis", "REAL NOT NULL DEFAULT 0"],
      ["reclaimedAt", "TEXT"],
      ["reclamationPlanId", "TEXT"],
    ] as const) {
      if (!names.has(name)) {
        database.exec(`ALTER TABLE lake_records ADD COLUMN ${name} ${type}`);
      }
    }
    if (!names.has("committedAtMillis")) {
      database.exec(
        "UPDATE lake_records SET committedAtMillis = ROUND((julianday(json_extract(metadataJson, '$.committedAt')) - 2440587.5) * 86400000)"
      );
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS lake_principal_sequence ON lake_records(principal, sequence);
      CREATE INDEX IF NOT EXISTS lake_retained_schema ON lake_records(principal, schemaId, sequence) WHERE reclaimedAt IS NULL;
      CREATE INDEX IF NOT EXISTS lake_retained_principal ON lake_records(principal, sequence) WHERE reclaimedAt IS NULL;
      CREATE INDEX IF NOT EXISTS lake_retained_digest ON lake_records(json_extract(metadataJson, '$.digest')) WHERE reclaimedAt IS NULL;
      CREATE INDEX IF NOT EXISTS lake_retained_identity ON lake_records(artifactId, version) WHERE reclaimedAt IS NULL;
      CREATE TABLE IF NOT EXISTS lake_reclamation_epochs (principal TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lake_reclamation_plans (
        planId TEXT PRIMARY KEY, principal TEXT NOT NULL, createdAt REAL NOT NULL, expiresAt REAL NOT NULL,
        requestJson TEXT NOT NULL, snapshot INTEGER NOT NULL, candidatesJson TEXT NOT NULL, summaryJson TEXT NOT NULL,
        receiptJson TEXT
      );
      CREATE INDEX IF NOT EXISTS lake_plan_actor ON lake_reclamation_plans(principal, expiresAt) WHERE receiptJson IS NULL;
      CREATE TABLE IF NOT EXISTS lake_reclamation_unlinks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, planId TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'Pending', started INTEGER NOT NULL DEFAULT 0, lastError TEXT,
        UNIQUE(planId, digest)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS lake_unlink_pending ON lake_reclamation_unlinks(digest) WHERE state = 'Pending';
    `);
    const unlinkColumns = database
      .query("PRAGMA table_info(lake_reclamation_unlinks)")
      .all() as { name: string }[];
    if (!unlinkColumns.some((column) => column.name === "failedAt")) {
      database.exec(
        "ALTER TABLE lake_reclamation_unlinks ADD COLUMN failedAt REAL"
      );
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS lake_unlink_queue ON lake_reclamation_unlinks(id) WHERE state='Pending';
      CREATE INDEX IF NOT EXISTS lake_unlink_errors ON lake_reclamation_unlinks(failedAt DESC,id DESC) WHERE state='Pending' AND lastError IS NOT NULL;
    `);
  })();
}

export function reclamationEpoch(
  database: Database,
  principal: string
): number {
  const row = database
    .query("SELECT epoch FROM lake_reclamation_epochs WHERE principal = ?")
    .get(principal);
  return row
    ? Schema.decodeUnknownSync(Schema.Struct({ epoch: Schema.Int }))(row).epoch
    : 0;
}

export function cursorSnapshot(
  value: Schema.Json,
  epoch: number,
  field: "sequence" | "version"
) {
  const decoded =
    typeof value === "number"
      ? { epoch: 0, value }
      : Schema.decodeUnknownSync(
          Schema.Struct({ epoch: Schema.Int, value: Schema.Int })
        )(value);
  if (decoded.epoch !== epoch) {
    throw new OperationError({
      code: "CursorExpired",
      message: `Lake ${field} cursor expired after reclamation; start a new listing`,
    });
  }
  return decoded.value;
}
