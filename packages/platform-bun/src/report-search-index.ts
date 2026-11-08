import type { Database } from "bun:sqlite";

import { Schema } from "effect";

const projection = `SELECT r.sequence,root.principal,g.sourceRunId,root.kind,root.targetId,
  json_extract(s.sourceJson,'$.targetKind'),json_extract(s.sourceJson,'$.targetId'),
  json_extract(s.sourceJson,'$.scope'),json_extract(p.planJson,'$['||g.attachmentIndex||'].attachmentId'),
  json_extract(p.planJson,'$['||g.attachmentIndex||'].reporterId'),r.createdAt,r.groupId
  FROM host_reports r JOIN host_report_groups g ON g.groupId=r.groupId
  JOIN host_report_sources s ON s.sourceId=g.sourceId
  JOIN host_report_plans p ON p.runId=g.sourceRunId
  JOIN host_runs root ON root.runId=g.sourceRunId`;
const columns =
  "sequence,principal,sourceRunId,rootKind,rootTargetId,sourceTargetKind,sourceTargetId,scope,attachmentId,reporterId,createdAt,groupId";

/** Called in the host migration transaction. New generations use the same insert projection. */
export function createReportSearchIndex(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS host_report_search (
      sequence INTEGER PRIMARY KEY REFERENCES host_reports(sequence), principal TEXT NOT NULL,
      sourceRunId TEXT NOT NULL, rootKind TEXT NOT NULL, rootTargetId TEXT NOT NULL,
      sourceTargetKind TEXT NOT NULL, sourceTargetId TEXT NOT NULL, scope TEXT NOT NULL,
      attachmentId TEXT NOT NULL, reporterId TEXT NOT NULL, createdAt TEXT NOT NULL, groupId TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS host_report_search_principal ON host_report_search(principal,sequence);
    CREATE INDEX IF NOT EXISTS host_report_search_run ON host_report_search(principal,sourceRunId,sequence);
    CREATE INDEX IF NOT EXISTS host_report_search_root ON host_report_search(principal,rootKind,rootTargetId,sequence);
    CREATE INDEX IF NOT EXISTS host_report_search_source ON host_report_search(principal,sourceTargetKind,sourceTargetId,sequence);
    CREATE INDEX IF NOT EXISTS host_report_search_reporter ON host_report_search(principal,reporterId,sequence);
    CREATE INDEX IF NOT EXISTS host_report_search_attachment ON host_report_search(principal,attachmentId,sequence);
    CREATE INDEX IF NOT EXISTS host_reports_group_sequence ON host_reports(groupId,sequence);
    CREATE TABLE IF NOT EXISTS host_report_search_tags (
      principal TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,
      sequence INTEGER NOT NULL REFERENCES host_reports(sequence),
      PRIMARY KEY(principal,key,value,sequence)
    ) WITHOUT ROWID;
  `);
  const { maximum } = Schema.decodeUnknownSync(
    Schema.Struct({ maximum: Schema.Int })
  )(
    database
      .query("SELECT COALESCE(MAX(sequence),0) maximum FROM host_report_search")
      .get()
  );
  database
    .query(
      `INSERT INTO host_report_search(${columns}) ${projection} WHERE r.sequence>?`
    )
    .run(maximum);
  database
    .query(`INSERT INTO host_report_search_tags SELECT q.principal,t.key,t.value,q.sequence
    FROM host_report_search q JOIN host_run_tags t ON t.runId=q.sourceRunId AND t.principal=q.principal
    WHERE q.sequence>?`)
    .run(maximum);
  return (id: string) => {
    database
      .query(
        `INSERT INTO host_report_search(${columns}) ${projection} WHERE r.reportId=?`
      )
      .run(id);
    database
      .query(`INSERT INTO host_report_search_tags SELECT q.principal,t.key,t.value,q.sequence
      FROM host_reports r JOIN host_report_search q ON q.sequence=r.sequence
      JOIN host_run_tags t ON t.runId=q.sourceRunId AND t.principal=q.principal WHERE r.reportId=?`)
      .run(id);
  };
}
