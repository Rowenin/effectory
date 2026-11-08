/* oxlint-disable eslint/no-redeclare -- Schema value and inferred type share a name. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import type { Run } from "@effectory/runtime/protocol";
import { terminal } from "@effectory/runtime/protocol";
import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import { SourceIdentity } from "@offtree/effectory-sdk/internal/report-record";
import { Schema } from "effect";

import { ReportPlan } from "./report-plan.ts";
import type { EncodedReportPlan } from "./report-plan.ts";
import { createReportRecords } from "./report-records.ts";

export { SourceIdentity } from "@offtree/effectory-sdk/internal/report-record";

export const FailureCategory = Schema.Literals([
  "Domain",
  "Host",
  "Defect",
  "Control",
]);
export type FailureCategory = typeof FailureCategory.Type;
export const IneligibleReason = Schema.Literals([
  "NotStarted",
  "NoNativeExecution",
]);
const StoredSource = Schema.Struct({
  createdAt: Schema.String,
  failureCategory: Schema.NullOr(FailureCategory),
  ineligibleReason: Schema.NullOr(IneligibleReason),
  invocationId: Schema.NullOr(Schema.String),
  observationError: Schema.NullOr(Schema.String),
  phase: Schema.Literals(["Armed", "Ready", "Materialized"]),
  sourceId: Schema.String,
  sourceJson: Schema.String,
  sourceRunId: Schema.String,
  sourceSeq: Schema.Int,
});
const PlanRow = Schema.Struct({ planJson: Schema.String });
const hash = (tuple: Schema.Json) =>
  createHash("sha256").update(canonical(tuple)).digest("hex");
export const reportSourceId = (runId: string, invocationId: string | null) =>
  hash(["report-source/v1", runId, invocationId]);

const readSource = (raw: unknown) => {
  const row = Schema.decodeUnknownSync(StoredSource)(raw);
  return {
    ...row,
    source: Schema.decodeUnknownSync(SourceIdentity)(
      JSON.parse(row.sourceJson)
    ),
  };
};

/** All mutation hooks run in the caller's host-store transaction and use its connection. */
export function createReportSources(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS host_workflow_invocations (
      invocationId TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES host_runs(runId),
      path TEXT NOT NULL, targetId TEXT NOT NULL, entered INTEGER NOT NULL DEFAULT 0,
      UNIQUE(runId,path)
    );
    CREATE TABLE IF NOT EXISTS host_report_plans (
      runId TEXT PRIMARY KEY REFERENCES host_runs(runId), planJson TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_report_sources (
      sourceSeq INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceId TEXT NOT NULL UNIQUE,
      sourceRunId TEXT NOT NULL REFERENCES host_runs(runId),
      invocationId TEXT,
      sourceJson TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'Armed',
      failureCategory TEXT,
      createdAt TEXT NOT NULL,
      ineligibleReason TEXT,
      observationError TEXT
    );
    CREATE INDEX IF NOT EXISTS host_report_sources_pending ON host_report_sources(phase, sourceSeq);
    CREATE INDEX IF NOT EXISTS host_report_sources_run ON host_report_sources(sourceRunId, sourceSeq);
    CREATE INDEX IF NOT EXISTS host_invocations_engine ON host_invocations(engineId);
    CREATE TABLE IF NOT EXISTS host_report_scan (
      id INTEGER PRIMARY KEY CHECK (id = 1), position INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO host_report_scan VALUES (1, 0);
  `);
  const records = createReportRecords(database);
  const plan = (runId: string): EncodedReportPlan => {
    const row = database
      .query("SELECT planJson FROM host_report_plans WHERE runId = ?")
      .get(runId);
    return row
      ? Schema.decodeUnknownSync(ReportPlan)(
          JSON.parse(Schema.decodeUnknownSync(PlanRow)(row).planJson)
        )
      : [];
  };
  const arm = (
    run: Run,
    invocationId: string | null,
    target: EncodedReportPlan[number],
    entries: EncodedReportPlan
  ) => {
    const source = SourceIdentity.make({
      invocationId,
      revision: run.revision,
      runId: run.runId,
      scope: invocationId === null ? "run" : "invocation",
      status: null,
      targetId: target.targetId,
      targetKind: target.targetKind,
      targetVersion: target.targetVersion,
    });
    const id = reportSourceId(run.runId, invocationId);
    const createdAt = new Date().toISOString();
    database
      .query(
        "INSERT OR IGNORE INTO host_report_sources(sourceId,sourceRunId,invocationId,sourceJson,createdAt) VALUES (?,?,?,?,?)"
      )
      .run(id, run.runId, invocationId, canonical(source), createdAt);
    records.arm(id, source, entries, createdAt);
  };
  return {
    advance: (position: number) => {
      database
        .query("UPDATE host_report_scan SET position = ? WHERE id = 1")
        .run(position);
    },
    capture: (run: Run, input: EncodedReportPlan) => {
      const entries = Schema.decodeUnknownSync(ReportPlan)(input, {
        onExcessProperty: "error",
      });
      if (entries.length === 0) {
        return;
      }
      database
        .query("INSERT INTO host_report_plans VALUES (?,?)")
        .run(run.runId, canonical(entries));
      const root = entries.find(
        (entry) =>
          entry.scope === "run" &&
          entry.targetId === run.targetId &&
          entry.targetKind === run.kind
      );
      if (root) {
        arm(run, null, root, entries);
      }
    },
    enterWorkflow: (runId: string, path: string) => {
      database
        .query(
          "UPDATE host_workflow_invocations SET entered=1 WHERE runId=? AND path=?"
        )
        .run(runId, path);
    },
    invocation: (run: Run, engineId: string, payload: Schema.Json) => {
      const entries = plan(run.runId);
      if (entries.length === 0) {
        return;
      }
      const { taskId } = Schema.decodeUnknownSync(
        Schema.Struct({ taskId: Schema.String })
      )(payload);
      const target = entries.find(
        (entry) =>
          entry.scope === "invocation" &&
          entry.targetKind === "task" &&
          entry.targetId === taskId
      );
      if (target) {
        arm(run, engineId, target, entries);
      }
    },
    invocationDetails: (sourceRunId: string, invocationId: string) =>
      Schema.decodeUnknownSync(
        Schema.Struct({ attemptCount: Schema.Int, nodeId: Schema.String })
      )(
        database
          .query(
            "SELECT nodeId, (SELECT COUNT(*) FROM host_attempts a WHERE a.runId = i.runId AND a.nodeId = i.nodeId) AS attemptCount FROM host_invocations i WHERE runId = ? AND engineId = ?"
          )
          .get(sourceRunId, invocationId)
      ),
    materialize: (sourceId: string) =>
      database.transaction(() => {
        const raw = database
          .query(
            "SELECT * FROM host_report_sources WHERE sourceId = ? AND phase = 'Ready'"
          )
          .get(sourceId);
        if (!raw) {
          return;
        }
        const row = readSource(raw);
        records.materialize(
          sourceId,
          row.source,
          row.ineligibleReason,
          plan(row.sourceRunId)
        );
        database
          .query(
            "UPDATE host_report_sources SET phase = 'Materialized' WHERE sourceId = ?"
          )
          .run(sourceId);
      })(),
    observationError: (sourceId: string, message: string | null) => {
      database
        .query(
          "UPDATE host_report_sources SET observationError = ? WHERE sourceId = ? AND phase = 'Armed'"
        )
        .run(message, sourceId);
    },
    pending: (phase: "Armed" | "Ready" | "Materialized", after = 0) =>
      database
        .query(
          "SELECT * FROM host_report_sources WHERE phase = ? AND sourceSeq > ? ORDER BY sourceSeq LIMIT 200"
        )
        .all(phase, after)
        .map(readSource),
    plan,
    project: (run: Run, category: FailureCategory | null) => {
      if (!terminal.has(run.status)) {
        return;
      }
      const id = reportSourceId(run.runId, null);
      database
        .query(
          "UPDATE host_report_sources SET sourceJson = json_set(sourceJson, '$.status', ?), failureCategory = ?, phase = 'Ready' WHERE sourceId = ? AND phase = 'Armed'"
        )
        .run(run.status, category, id);
    },
    records,
    scan: () => {
      const { position } = Schema.decodeUnknownSync(
        Schema.Struct({ position: Schema.Int })
      )(
        database
          .query("SELECT position FROM host_report_scan WHERE id = 1")
          .get()
      );
      const query = database.query(
        "SELECT * FROM host_report_sources WHERE phase = 'Armed' AND invocationId IS NOT NULL AND sourceSeq > ? ORDER BY sourceSeq LIMIT 200"
      );
      const rows = query.all(position);
      return (rows.length === 0 ? query.all(0) : rows).map(readSource);
    },
    settle: (
      sourceId: string,
      status: (typeof SourceIdentity.Type)["status"],
      category: FailureCategory | null,
      ineligibleReason: typeof IneligibleReason.Type | null
    ) => {
      database
        .query(
          "UPDATE host_report_sources SET sourceJson = json_set(sourceJson, '$.status', ?), failureCategory = ?, ineligibleReason = ?, observationError = NULL, phase = 'Ready' WHERE sourceId = ? AND invocationId IS NOT NULL AND phase = 'Armed'"
        )
        .run(status, category, ineligibleReason, sourceId);
    },
    workflow: (run: Run, path: string, targetId: string) => {
      const entries = plan(run.runId);
      const target = entries.find(
        (entry) =>
          entry.scope === "invocation" &&
          entry.targetKind === "workflow" &&
          entry.targetId === targetId
      );
      if (!target) {
        return;
      }
      const invocationId = hash(["workflow-invocation/v1", run.runId, path]);
      database
        .query(
          "INSERT OR IGNORE INTO host_workflow_invocations(invocationId,runId,path,targetId) VALUES (?,?,?,?)"
        )
        .run(invocationId, run.runId, path, targetId);
      arm(run, invocationId, target, entries);
    },
    workflowDetails: (runId: string, invocationId: string) =>
      Schema.decodeUnknownSync(
        Schema.Struct({ entered: Schema.Int, path: Schema.String })
      )(
        database
          .query(
            "SELECT path,entered FROM host_workflow_invocations WHERE runId=? AND invocationId=?"
          )
          .get(runId, invocationId)
      ),
  };
}
