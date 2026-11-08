import type { Database } from "bun:sqlite";

import { terminal, RunStatus } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { initializeRetiredRuns } from "./run-retirement.ts";

const unfinished = [...terminal].map((value) => `'${value}'`).join(",");
export const unsettledReports =
  "'WaitingSource','Queued','Running','NeedsAttention'";

/** Projection maintained in the same transaction as every report transition. */
export function initializeReadProtection(database: Database) {
  initializeRetiredRuns(database);
  database
    .transaction(() => {
      database.exec(`
      CREATE TABLE IF NOT EXISTS lake_consumer_pins (
        consumerRunId TEXT NOT NULL, sequence INTEGER NOT NULL REFERENCES lake_records(sequence),
        PRIMARY KEY(consumerRunId,sequence)
      );
      CREATE INDEX IF NOT EXISTS lake_consumer_version ON lake_consumer_pins(sequence,consumerRunId);
    `);
      database.exec(
        "CREATE TABLE IF NOT EXISTS lake_report_holds (sequence INTEGER PRIMARY KEY, sourceRunId TEXT NOT NULL); CREATE INDEX IF NOT EXISTS lake_report_source ON lake_report_holds(sourceRunId,sequence)"
      );
      database.exec(
        "CREATE TABLE IF NOT EXISTS lake_pin_cleanup (runId TEXT PRIMARY KEY)"
      );
      if (
        database
          .query(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_runs'"
          )
          .get()
      ) {
        database.exec(`
        CREATE TRIGGER IF NOT EXISTS lake_consumer_terminal AFTER UPDATE OF status ON host_runs
        WHEN NEW.status IN (${unfinished}) BEGIN
          INSERT OR IGNORE INTO lake_pin_cleanup SELECT NEW.runId
            WHERE EXISTS(SELECT 1 FROM lake_consumer_pins WHERE consumerRunId=NEW.runId);
        END;
        INSERT OR IGNORE INTO lake_pin_cleanup SELECT DISTINCT p.consumerRunId
          FROM lake_consumer_pins p JOIN host_runs h ON h.runId=p.consumerRunId
          WHERE h.status IN (${unfinished});
      `);
      }
      // HostStore creates report tables before the lake. Small standalone lake
      // fixtures predating reports are also supported.
      if (
        !database
          .query(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_reports'"
          )
          .get()
      ) {
        return;
      }
      database.exec(`
      CREATE TABLE IF NOT EXISTS lake_report_holds (
        sequence INTEGER PRIMARY KEY REFERENCES host_reports(sequence) ON DELETE CASCADE,
        sourceRunId TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lake_report_source ON lake_report_holds(sourceRunId,sequence);
      CREATE TRIGGER IF NOT EXISTS lake_report_insert AFTER INSERT ON host_reports
      WHEN NEW.status IN (${unsettledReports}) BEGIN
        INSERT INTO lake_report_holds SELECT NEW.sequence,sourceRunId FROM host_report_groups WHERE groupId=NEW.groupId;
      END;
      CREATE TRIGGER IF NOT EXISTS lake_report_update AFTER UPDATE OF status,groupId ON host_reports BEGIN
        DELETE FROM lake_report_holds WHERE sequence=NEW.sequence;
        INSERT INTO lake_report_holds SELECT NEW.sequence,sourceRunId FROM host_report_groups
          WHERE groupId=NEW.groupId AND NEW.status IN (${unsettledReports});
      END;
      CREATE TRIGGER IF NOT EXISTS lake_report_delete AFTER DELETE ON host_reports BEGIN
        DELETE FROM lake_report_holds WHERE sequence=OLD.sequence;
      END;
      INSERT OR IGNORE INTO lake_report_holds
        SELECT r.sequence,g.sourceRunId FROM host_reports r JOIN host_report_groups g ON g.groupId=r.groupId
        WHERE r.status IN (${unsettledReports});
    `);
    })
    .immediate();
}
export function reportHolds(database: Database, sourceRunId: string) {
  return Boolean(
    database
      .query("SELECT 1 FROM lake_report_holds WHERE sourceRunId=? LIMIT 1")
      .get(sourceRunId)
  );
}
export function versionProtection(database: Database, sequence: number) {
  const raw = database
    .query(`SELECT json_extract(r.metadataJson,'$.runId') AS runId,COALESCE(h.status,retired.status) status
    FROM lake_records r LEFT JOIN host_runs h ON h.runId=json_extract(r.metadataJson,'$.runId') LEFT JOIN host_retired_runs retired ON retired.runId=json_extract(r.metadataJson,'$.runId') AND retired.principal=r.principal AND json_extract(retired.recordJson,'$.status')=retired.status WHERE r.sequence=?`)
    .get(sequence);
  const producer = Schema.decodeUnknownSync(
    Schema.Struct({ runId: Schema.String, status: Schema.NullOr(RunStatus) })
  )(raw);
  const consumers = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ consumerRunId: Schema.String }))
  )(
    database
      .query(`
    SELECT p.consumerRunId FROM lake_consumer_pins p LEFT JOIN host_runs h ON h.runId=p.consumerRunId
    WHERE p.sequence=? AND (h.status IS NULL OR h.status NOT IN (${unfinished})) ORDER BY p.consumerRunId LIMIT 21`)
      .all(sequence)
  );
  const count = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Int }))(
    database
      .query(`
    SELECT COUNT(*) AS value FROM lake_consumer_pins p LEFT JOIN host_runs h ON h.runId=p.consumerRunId
    WHERE p.sequence=? AND (h.status IS NULL OR h.status NOT IN (${unfinished}))`)
      .get(sequence)
  ).value;
  return {
    consumerRunCount: count,
    consumerRunIds: consumers.slice(0, 20).map((row) => row.consumerRunId),
    producerRunId:
      producer.status === null || !terminal.has(producer.status)
        ? producer.runId
        : null,
    reportSourceRunId: reportHolds(database, producer.runId)
      ? producer.runId
      : null,
    truncated: count > 20,
  };
}
export const isProtected = (protection: ReturnType<typeof versionProtection>) =>
  protection.producerRunId !== null ||
  protection.consumerRunCount > 0 ||
  protection.reportSourceRunId !== null;

/** Remove at most one small batch; unknown consumers remain conservatively held. */
export function cleanupReadPins(database: Database) {
  database
    .transaction(() => {
      const raw = database
        .query("SELECT runId FROM lake_pin_cleanup ORDER BY runId LIMIT 1")
        .get();
      if (!raw) {
        return;
      }
      const { runId } = Schema.decodeUnknownSync(
        Schema.Struct({ runId: Schema.String })
      )(raw);
      // Re-check current terminal state; missing or unexpectedly resumed runs stay protected.
      database
        .query(`DELETE FROM lake_consumer_pins WHERE rowid IN (
      SELECT p.rowid FROM lake_consumer_pins p JOIN host_runs h ON h.runId=p.consumerRunId
      WHERE p.consumerRunId=? AND h.status IN (${unfinished}) LIMIT 256
    )`)
        .run(runId);
      database
        .query(`DELETE FROM lake_pin_cleanup WHERE runId=? AND (
      NOT EXISTS(SELECT 1 FROM lake_consumer_pins WHERE consumerRunId=?) OR
      NOT EXISTS(SELECT 1 FROM host_runs WHERE runId=? AND status IN (${unfinished}))
    )`)
        .run(runId, runId, runId);
    })
    .immediate();
}

/** Boolean worker check: never enumerate or count all consumers of a popular version. */
export function versionIsProtected(database: Database, sequence: number) {
  return Boolean(
    database
      .query(`
    SELECT 1 FROM lake_records r LEFT JOIN host_runs h ON h.runId=json_extract(r.metadataJson,'$.runId') LEFT JOIN host_retired_runs retired ON retired.runId=json_extract(r.metadataJson,'$.runId') AND retired.principal=r.principal AND json_extract(retired.recordJson,'$.status')=retired.status
    WHERE r.sequence=? AND (
      COALESCE(h.status,retired.status) IS NULL OR COALESCE(h.status,retired.status) NOT IN (${unfinished}) OR
      EXISTS(SELECT 1 FROM lake_consumer_pins p LEFT JOIN host_runs c ON c.runId=p.consumerRunId
        WHERE p.sequence=r.sequence AND (c.status IS NULL OR c.status NOT IN (${unfinished}))) OR
      EXISTS(SELECT 1 FROM lake_report_holds hold WHERE hold.sourceRunId=json_extract(r.metadataJson,'$.runId'))
    ) LIMIT 1
  `)
      .get(sequence)
  );
}
