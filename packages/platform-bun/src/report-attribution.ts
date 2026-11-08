import type { Database } from "bun:sqlite";

/** Private path projections: the same transaction as the original record, including lake writes. */
export function installReportAttribution(database: Database) {
  database.run(`
    CREATE TABLE IF NOT EXISTS host_report_paths (
      runId TEXT NOT NULL, kind TEXT NOT NULL, position INTEGER NOT NULL,
      path TEXT, bytes INTEGER NOT NULL, diagnostic INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(runId,kind,position)
    );
    CREATE TRIGGER IF NOT EXISTS host_report_task_path AFTER INSERT ON host_invocations BEGIN
      INSERT INTO host_report_paths VALUES (NEW.runId,'invocations',NEW.rowid,NEW.nodeId,length(CAST(NEW.nodeId AS BLOB)),0);
    END;
    CREATE TRIGGER IF NOT EXISTS host_report_event_path AFTER INSERT ON host_events BEGIN
      INSERT INTO host_report_paths(runId,kind,position,path,bytes,diagnostic)
      SELECT NEW.runId,'events',NEW.sequence,path,COALESCE(length(CAST(path AS BLOB)),0),NEW.tag='TelemetryTruncated'
      FROM (SELECT CASE
        WHEN NEW.tag='ArtifactPublished' THEN json_extract(NEW.payloadJson,'$.invocationPath')
        WHEN NEW.tag IN ('WaitOpened','WaitSettled') THEN (SELECT nodeId FROM host_waits WHERE waitId=json_extract(NEW.payloadJson,'$.waitId'))
        WHEN NEW.tag IN ('AttemptStarted','RetryScheduled','NeedsAttention','Log','Progress') THEN json_extract(NEW.payloadJson,'$.nodeId')
        ELSE NULL END AS path);
    END;
  `);
}
