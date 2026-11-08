import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { OperationError, terminal } from "@effectory/runtime/protocol";
import type { Run, CancellationRequest } from "@effectory/runtime/protocol";
import {
  ReportRecord,
  ReportRetryRequest,
  ReportCancelSingleRequest,
  ReportCancelReceipt,
} from "@effectory/runtime/report-protocol";
import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import { SourceIdentity } from "@offtree/effectory-sdk/internal/report-record";
import { Schema } from "effect";

import { createReportCancellation } from "./report-cancellation.ts";
import { ReportPlanEntry } from "./report-plan.ts";
import type { EncodedReportPlan } from "./report-plan.ts";
import { createReportSearchIndex } from "./report-search-index.ts";
import { refuseRetired } from "./run-retirement.ts";

const hash = (tuple: Schema.Json) =>
  createHash("sha256").update(canonical(tuple)).digest("hex");
export const reportGroupId = (
  runId: string,
  invocationId: string | null,
  attachmentId: string
) => hash(["report-group/v1", runId, invocationId, attachmentId]);
export const reportId = (groupId: string, generation: number) =>
  hash(["report-generation/v1", groupId, generation]);
const unavailable = () =>
  new OperationError({
    code: "Unavailable",
    message: "Pinned report attachment is unavailable",
  });
const notFound = () =>
  new OperationError({ code: "NotFound", message: "Report was not found" });
const Row = Schema.Struct({
  attachmentIndex: Schema.Int,
  createdAt: Schema.String,
  entryJson: Schema.String,
  failureCategory: Schema.NullOr(
    Schema.Literals(["Domain", "Host", "Defect", "Control"])
  ),
  generation: Schema.Int,
  groupId: Schema.String,
  ineligibleReason: ReportRecord.fields.notApplicableReason,
  latestGeneration: Schema.Int,
  notApplicableReason: ReportRecord.fields.notApplicableReason,
  observationError: Schema.NullOr(Schema.String),
  pathText: Schema.NullOr(Schema.String),
  principal: Schema.String,
  reportId: Schema.String,
  reportRunId: Schema.NullOr(Schema.String),
  settledAt: Schema.NullOr(Schema.String),
  sourceId: Schema.String,
  sourceJson: Schema.String,
  status: ReportRecord.fields.status,
});
const selection = `SELECT r.*, g.attachmentIndex, g.latestGeneration, g.sourceId,
  s.sourceJson, s.failureCategory, s.ineligibleReason, s.observationError, json_extract(p.planJson, '$[' || g.attachmentIndex || ']') AS entryJson, root.principal,
  COALESCE((SELECT substr(i.nodeId, 1, 2049) FROM host_invocations i WHERE i.runId = s.sourceRunId AND i.engineId = s.invocationId),
    (SELECT substr(w.path, 1, 2049) FROM host_workflow_invocations w WHERE w.runId = s.sourceRunId AND w.invocationId = s.invocationId)) AS pathText
  FROM host_reports r JOIN host_report_groups g ON g.groupId = r.groupId
  JOIN host_report_sources s ON s.sourceId = g.sourceId
  JOIN host_report_plans p ON p.runId = s.sourceRunId
  JOIN host_runs root ON root.runId = s.sourceRunId`;

export function reportStatus(
  status: Run["status"]
): (typeof ReportRecord.Type)["status"] {
  switch (status) {
    case "Queued": {
      return "Queued";
    }
    case "NeedsAttention": {
      return "NeedsAttention";
    }
    case "Succeeded": {
      return "Succeeded";
    }
    case "Cancelled": {
      return "Cancelled";
    }
    case "Failed":
    case "Rejected":
    case "TimedOut": {
      return "Failed";
    }
    default: {
      return "Running";
    }
  }
}

/** Compact generation records reference a single source and its immutable plan. */
export function createReportRecords(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS host_report_groups (
      groupId TEXT PRIMARY KEY, sourceId TEXT NOT NULL REFERENCES host_report_sources(sourceId),
      sourceRunId TEXT NOT NULL REFERENCES host_runs(runId), attachmentIndex INTEGER NOT NULL,
      latestGeneration INTEGER NOT NULL DEFAULT 1, UNIQUE(sourceId, attachmentIndex)
    );
    CREATE INDEX IF NOT EXISTS host_report_groups_source ON host_report_groups(sourceRunId, sourceId);
    CREATE TABLE IF NOT EXISTS host_reports (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, reportId TEXT NOT NULL UNIQUE,
      groupId TEXT NOT NULL REFERENCES host_report_groups(groupId), generation INTEGER NOT NULL,
      reportRunId TEXT UNIQUE REFERENCES host_runs(runId), status TEXT NOT NULL,
      notApplicableReason TEXT, createdAt TEXT NOT NULL, queuedAt TEXT, settledAt TEXT,
      UNIQUE(groupId, generation)
    );
    CREATE INDEX IF NOT EXISTS host_reports_pending ON host_reports(status, groupId, queuedAt, sequence);
    CREATE TABLE IF NOT EXISTS host_report_rotation (id INTEGER PRIMARY KEY CHECK(id = 1), sourceRunId TEXT NOT NULL);
    INSERT OR IGNORE INTO host_report_rotation VALUES (1, '');
    CREATE TABLE IF NOT EXISTS host_report_receipts (
      operation TEXT NOT NULL, subjectId TEXT NOT NULL, principal TEXT NOT NULL,
      requestKey TEXT NOT NULL, fingerprint TEXT NOT NULL, receiptJson TEXT NOT NULL,
      PRIMARY KEY(operation, subjectId, principal, requestKey)
    );
  `);
  const indexReport = createReportSearchIndex(database);
  const cancellation = createReportCancellation(database);
  const load = (id: string, principal?: string) => {
    const raw = database
      .query(
        `${selection} WHERE r.reportId = ? AND (? IS NULL OR root.principal = ?)`
      )
      .get(id, principal ?? null, principal ?? null);
    if (!raw) {
      if (principal !== undefined) {
        refuseRetired(database, "report", id, principal);
      }
      throw notFound();
    }
    const row = Schema.decodeUnknownSync(Row)(raw);
    const source = Schema.decodeUnknownSync(SourceIdentity)(
      JSON.parse(row.sourceJson)
    );
    const entry = Schema.decodeUnknownSync(ReportPlanEntry)(
      JSON.parse(row.entryJson)
    );
    return { entry, row, source };
  };
  const get = (
    id: string,
    getRun: (runId: string) => Pick<Run, "status" | "error">,
    principal?: string
  ) => {
    const { entry, row, source } = load(id, principal);
    const run = row.reportRunId === null ? null : getRun(row.reportRunId);
    const path = row.pathText === null ? null : [...row.pathText];
    return ReportRecord.make({
      attachmentId: entry.attachmentId,
      createdAt: row.createdAt,
      error:
        run?.error ??
        (row.observationError === null
          ? null
          : { code: "Unavailable", message: row.observationError }),
      execution: entry.execution,
      generation: row.generation,
      groupId: row.groupId,
      notApplicableReason: row.notApplicableReason,
      pathPreview:
        path === null
          ? null
          : {
              text: path.slice(0, 2048).join(""),
              truncated: path.length > 2048,
            },
      reportId: row.reportId,
      reportProviderId: entry.reporterProviderId,
      reportRunId: row.reportRunId,
      reportRunStatus: run?.status ?? null,
      reportTaskId: entry.reporterId,
      reportTaskVersion: entry.reporterVersion,
      settledAt: row.settledAt,
      source,
      status: run === null ? row.status : reportStatus(run.status),
    });
  };
  const receipt = (
    operation: string,
    subject: string,
    actor: string,
    key: string,
    fingerprint: string
  ) => {
    const raw = database
      .query(
        "SELECT fingerprint,receiptJson FROM host_report_receipts WHERE operation = ? AND subjectId = ? AND principal = ? AND requestKey = ?"
      )
      .get(operation, subject, actor, key);
    if (!raw) {
      return null;
    }
    const row = Schema.decodeUnknownSync(
      Schema.Struct({ fingerprint: Schema.String, receiptJson: Schema.String })
    )(raw);
    if (row.fingerprint !== fingerprint) {
      throw new OperationError({
        code: "Conflict",
        message: "Report request key was used for different arguments",
      });
    }
    return row.receiptJson;
  };
  const saveReceipt = (
    operation: string,
    subject: string,
    actor: string,
    key: string,
    fingerprint: string,
    value: Schema.Json
  ) => {
    database
      .query("INSERT INTO host_report_receipts VALUES (?,?,?,?,?,?)")
      .run(operation, subject, actor, key, fingerprint, canonical(value));
  };
  return {
    arm: (
      sourceId: string,
      source: typeof SourceIdentity.Type,
      entries: EncodedReportPlan,
      createdAt: string
    ) => {
      for (const [index, entry] of entries.entries()) {
        if (
          entry.scope !== source.scope ||
          entry.targetId !== source.targetId ||
          entry.targetKind !== source.targetKind ||
          entry.targetVersion !== source.targetVersion
        ) {
          continue;
        }
        const group = reportGroupId(
          source.runId,
          source.invocationId,
          entry.attachmentId
        );
        database
          .query(
            "INSERT OR IGNORE INTO host_report_groups(groupId,sourceId,sourceRunId,attachmentIndex) VALUES (?,?,?,?)"
          )
          .run(group, sourceId, source.runId, index);
        const inserted = database
          .query(
            "INSERT OR IGNORE INTO host_reports(reportId,groupId,generation,status,createdAt) VALUES (?,?,1,'WaitingSource',?) RETURNING reportId"
          )
          .get(reportId(group, 1), group, createdAt);
        if (inserted !== null) {
          indexReport(reportId(group, 1));
        }
      }
    },
    bind: (id: string, run: Run) => {
      const changed = database
        .query(
          "UPDATE host_reports SET reportRunId = ? WHERE reportId = ? AND status = 'Queued' AND reportRunId IS NULL"
        )
        .run(run.runId, id);
      if (changed.changes !== 1) {
        throw new OperationError({
          code: "Conflict",
          message: "Report admission changed",
        });
      }
      const { source } = load(id);
      database
        .query("UPDATE host_report_rotation SET sourceRunId = ? WHERE id = 1")
        .run(source.runId);
    },
    cancel: (
      value: typeof ReportCancelSingleRequest.Type,
      actor: string,
      getRun: (id: string) => Run,
      cancel: (
        request: typeof CancellationRequest.Type,
        actor: string
      ) => unknown
    ) =>
      database.transaction(() => {
        if (!Schema.is(ReportCancelSingleRequest)(value)) {
          throw new OperationError({
            code: "InvalidInput",
            message: "Invalid report cancellation request",
          });
        }
        const request = Schema.decodeUnknownSync(ReportCancelSingleRequest)(
          value,
          { onExcessProperty: "error" }
        );
        const current = get(request.reportId, getRun, actor);
        const reason = request.reason ?? null;
        const fingerprint = canonical({ reason });
        const prior = receipt(
          "cancel",
          request.reportId,
          actor,
          request.requestKey,
          fingerprint
        );
        if (prior !== null) {
          return {
            ...Schema.decodeUnknownSync(ReportCancelReceipt)(JSON.parse(prior)),
            replayed: true,
          };
        }
        if (
          !["Succeeded", "Failed", "Cancelled", "NotApplicable"].includes(
            current.status
          )
        ) {
          if (current.reportRunId === null) {
            database
              .query(
                "UPDATE host_reports SET status = 'Cancelled', settledAt = ? WHERE reportId = ?"
              )
              .run(new Date().toISOString(), request.reportId);
          } else {
            cancel(
              {
                requestKey: hash([
                  "report-cancel/v1",
                  request.reportId,
                  request.requestKey,
                ]),
                runId: current.reportRunId,
                ...(reason === null ? {} : { reason }),
              },
              actor
            );
          }
        }
        const updated = get(request.reportId, getRun, actor);
        const response = ReportCancelReceipt.make({
          acceptedAt: new Date().toISOString(),
          actor,
          reason,
          replayed: false,
          reportId: request.reportId,
          reportRunId: updated.reportRunId,
          requestKey: request.requestKey,
          status: updated.status,
        });
        saveReceipt(
          "cancel",
          request.reportId,
          actor,
          request.requestKey,
          fingerprint,
          response
        );
        return response;
      })(),
    cancellation,
    candidate: () => {
      const { sourceRunId } = Schema.decodeUnknownSync(
        Schema.Struct({ sourceRunId: Schema.String })
      )(
        database
          .query("SELECT sourceRunId FROM host_report_rotation WHERE id = 1")
          .get()
      );
      const query =
        database.query(`SELECT g.sourceRunId FROM host_reports r JOIN host_report_groups g ON g.groupId = r.groupId
        WHERE r.status = 'Queued' AND r.reportRunId IS NULL
          AND NOT EXISTS (SELECT 1 FROM host_report_cancellations c WHERE c.sourceRunId = g.sourceRunId AND c.position < c.maximum AND r.sequence <= c.maximum)
          AND g.sourceRunId > ?
        ORDER BY g.sourceRunId LIMIT 1`);
      const raw = query.get(sourceRunId) ?? query.get("");
      if (!raw) {
        return null;
      }
      const chosen = Schema.decodeUnknownSync(
        Schema.Struct({ sourceRunId: Schema.String })
      )(raw).sourceRunId;
      const row = database
        .query(`SELECT r.reportId FROM host_reports r JOIN host_report_groups g ON g.groupId = r.groupId
        WHERE r.status = 'Queued' AND r.reportRunId IS NULL
          AND NOT EXISTS (SELECT 1 FROM host_report_cancellations c WHERE c.sourceRunId = g.sourceRunId AND c.position < c.maximum AND r.sequence <= c.maximum)
          AND g.sourceRunId = ? ORDER BY r.queuedAt, r.sequence LIMIT 1`)
        .get(chosen);
      return Schema.decodeUnknownSync(
        Schema.Struct({ reportId: Schema.String })
      )(row).reportId;
    },
    get,
    ids: (runId: string) =>
      Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ reportId: Schema.String }))
      )(
        database
          .query(
            "SELECT r.reportId FROM host_reports r JOIN host_report_groups g ON g.groupId = r.groupId WHERE g.sourceRunId = ? ORDER BY r.sequence LIMIT 200"
          )
          .all(runId)
      ).map((row) => row.reportId),
    load,
    materialize: (
      sourceId: string,
      source: typeof SourceIdentity.Type,
      ineligible: "NotStarted" | "NoNativeExecution" | null,
      entries: EncodedReportPlan
    ) => {
      const groups = Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({ attachmentIndex: Schema.Int, groupId: Schema.String })
        )
      )(
        database
          .query(
            "SELECT attachmentIndex, groupId FROM host_report_groups WHERE sourceId = ?"
          )
          .all(sourceId)
      );
      const at = new Date().toISOString();
      for (const group of groups) {
        const entry = entries[group.attachmentIndex];
        if (!entry) {
          throw unavailable();
        }
        const reason =
          ineligible ??
          (source.status !== null && entry.on.includes(source.status)
            ? null
            : "OutcomeExcluded");
        database
          .query(
            "UPDATE host_reports SET status = ?, notApplicableReason = ?, queuedAt = ?, settledAt = ? WHERE groupId = ? AND status = 'WaitingSource'"
          )
          .run(
            reason === null ? "Queued" : "NotApplicable",
            reason,
            reason === null ? at : null,
            reason === null ? null : at,
            group.groupId
          );
      }
    },
    project: (run: Run) => {
      database
        .query(
          "UPDATE host_reports SET status = ?, settledAt = CASE WHEN ? THEN COALESCE(settledAt, ?) ELSE settledAt END WHERE reportRunId = ?"
        )
        .run(
          reportStatus(run.status),
          terminal.has(run.status) ? 1 : 0,
          new Date().toISOString(),
          run.runId
        );
    },
    retry: (
      value: typeof ReportRetryRequest.Type,
      actor: string,
      getRun: (id: string) => Run,
      assertExecutable: (revision: string) => void
    ) =>
      database.transaction(() => {
        if (!Schema.is(ReportRetryRequest)(value)) {
          throw new OperationError({
            code: "InvalidInput",
            message: "Invalid report retry request",
          });
        }
        const request = Schema.decodeUnknownSync(ReportRetryRequest)(value, {
          onExcessProperty: "error",
        });
        const current = get(request.reportId, getRun, actor);
        const { entry, row, source } = load(request.reportId, actor);
        const fingerprint = canonical({ reportId: request.reportId });
        const prior = receipt(
          "retry",
          row.groupId,
          actor,
          request.requestKey,
          fingerprint
        );
        if (prior !== null) {
          const saved = Schema.decodeUnknownSync(
            Schema.Struct({ reportId: Schema.String })
          )(JSON.parse(prior));
          return { record: get(saved.reportId, getRun, actor), replayed: true };
        }
        assertExecutable(source.revision);
        if (row.generation !== row.latestGeneration) {
          throw new OperationError({
            code: "Conflict",
            message: `Retry requires the latest report: ${reportId(row.groupId, row.latestGeneration)}`,
          });
        }
        if (!["Succeeded", "Failed", "Cancelled"].includes(current.status)) {
          throw new OperationError({
            code: "Conflict",
            message:
              "Only a succeeded, failed or cancelled report can be retried",
          });
        }
        const generation = row.generation + 1;
        if (!Number.isSafeInteger(generation)) {
          throw new OperationError({
            code: "LimitExceeded",
            message: "Report generation limit reached",
          });
        }
        const id = reportId(row.groupId, generation);
        const reason =
          row.ineligibleReason ??
          (source.status !== null && !entry.on.includes(source.status)
            ? "OutcomeExcluded"
            : null);
        let status: (typeof ReportRecord.Type)["status"] = "Queued";
        if (reason !== null) {
          status = "NotApplicable";
        } else if (source.status === null) {
          status = "WaitingSource";
        }
        const at = new Date().toISOString();
        database
          .query(
            "INSERT INTO host_reports(reportId,groupId,generation,status,notApplicableReason,createdAt,queuedAt,settledAt) VALUES (?,?,?,?,?,?,?,?)"
          )
          .run(
            id,
            row.groupId,
            generation,
            status,
            reason,
            at,
            status === "Queued" ? at : null,
            status === "NotApplicable" ? at : null
          );
        indexReport(id);
        database
          .query(
            "UPDATE host_report_groups SET latestGeneration = ? WHERE groupId = ?"
          )
          .run(generation, row.groupId);
        saveReceipt(
          "retry",
          row.groupId,
          actor,
          request.requestKey,
          fingerprint,
          { reportId: id }
        );
        return { record: get(id, getRun, actor), replayed: false };
      })(),
  };
}
