import { Digest } from "@effectory/runtime/extension-protocol";
import { ReportProvenance, RunStatus } from "@effectory/runtime/protocol";
import {
  ReportCancelSourceReceipt,
  ReportRecord,
} from "@effectory/runtime/report-protocol";
import { SourceIdentity } from "@offtree/effectory-sdk/internal/report-record";
import { Effect, Schema } from "effect";

import { ReportPlan, ReportPlanEntry } from "./report-plan.ts";
import { reportGroupId, reportId, reportStatus } from "./report-records.ts";
import { reportSourceId } from "./report-sources.ts";
import { reclaimDecode } from "./revision-reclaim-scan.ts";
import type { ReclaimScanner } from "./revision-reclaim-scan.ts";
import { unsupportedUpgradeWork } from "./upgrade-scan.ts";

const Positive = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 })
);
const Count = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })
);
const Text = Schema.NonEmptyString;
const nullableText = Schema.NullOr(Text);
const reportTables = [
  "host_reports",
  "host_report_groups",
  "host_report_sources",
  "host_report_plans",
  "host_report_cancellations",
];

export function inspectReclaimReports(
  scanner: ReclaimScanner,
  tables: ReadonlySet<string>
) {
  return Effect.gen(function* () {
    const count = reportTables.filter((table) => tables.has(table)).length;
    if (count === 0) {
      return;
    }
    if (count !== reportTables.length) {
      return yield* unsupportedUpgradeWork(
        "partial report dependency inventory"
      );
    }
    // Validate the reverse edge too: removing a report record must not turn its
    // retained execution into an apparently ordinary independent task run.
    yield* scanner.scan(
      "report run ownership",
      `SELECT r.rowid position,r.runId,r.reportJson,r.admissionLane,d.reportId,d.reportRunId FROM host_runs r LEFT JOIN host_reports d ON d.reportId=json_extract(r.reportJson,'$.reportId') WHERE /* after */ ORDER BY r.rowid LIMIT ?`,
      (raw) => {
        const row = reclaimDecode(
          Schema.Struct({
            admissionLane: Text,
            position: Positive,
            reportId: nullableText,
            reportJson: Schema.NullOr(Schema.String),
            reportRunId: nullableText,
            runId: Text,
          }),
          raw
        );
        if (row.reportJson !== null) {
          const provenance = reclaimDecode(
            ReportProvenance,
            JSON.parse(row.reportJson)
          );
          if (
            row.admissionLane !== "report" ||
            row.reportId !== provenance.reportId ||
            row.reportRunId !== row.runId
          ) {
            throw unsupportedUpgradeWork(
              "retained report run without its record"
            );
          }
        } else if (row.admissionLane === "report") {
          throw unsupportedUpgradeWork("report run without provenance");
        }
      },
      "r.rowid"
    );
    yield* scanner.scan(
      "report plans",
      `SELECT p.rowid position,p.runId,r.runId owner,p.planJson FROM host_report_plans p LEFT JOIN host_runs r ON r.runId=p.runId WHERE /* after */ ORDER BY p.rowid LIMIT ?`,
      (raw) => {
        const row = reclaimDecode(
          Schema.Struct({
            owner: Text,
            planJson: Schema.String,
            position: Positive,
            runId: Text,
          }),
          raw
        );
        reclaimDecode(ReportPlan, JSON.parse(row.planJson));
      },
      "p.rowid"
    );
    yield* scanner.scan(
      "report source ownership",
      `SELECT s.sourceSeq position,s.sourceId,s.sourceRunId,s.invocationId,s.sourceJson,s.phase,r.runId owner,r.revision,r.kind,r.targetId,i.engineId taskInvocation,w.invocationId workflowInvocation FROM host_report_sources s LEFT JOIN host_runs r ON r.runId=s.sourceRunId LEFT JOIN host_invocations i ON i.runId=s.sourceRunId AND i.engineId=s.invocationId LEFT JOIN host_workflow_invocations w ON w.runId=s.sourceRunId AND w.invocationId=s.invocationId WHERE /* after */ ORDER BY s.sourceSeq LIMIT ?`,
      (raw) => {
        const row = reclaimDecode(
          Schema.Struct({
            invocationId: nullableText,
            kind: Schema.Literals(["task", "workflow"]),
            owner: Text,
            phase: Schema.Literals(["Armed", "Ready", "Materialized"]),
            position: Positive,
            revision: Digest,
            sourceId: Text,
            sourceJson: Schema.String,
            sourceRunId: Text,
            targetId: Text,
            taskInvocation: nullableText,
            workflowInvocation: nullableText,
          }),
          raw
        );
        const source = reclaimDecode(
          SourceIdentity,
          JSON.parse(row.sourceJson)
        );
        if (
          row.sourceId !== reportSourceId(row.sourceRunId, row.invocationId) ||
          source.runId !== row.sourceRunId ||
          source.revision !== row.revision ||
          source.invocationId !== row.invocationId ||
          (row.invocationId === null
            ? source.scope !== "run" ||
              source.targetKind !== row.kind ||
              source.targetId !== row.targetId
            : source.scope !== "invocation" ||
              (source.targetKind === "task"
                ? row.taskInvocation
                : row.workflowInvocation) !== row.invocationId)
        ) {
          throw unsupportedUpgradeWork("report source identity");
        }
      }
    );
    yield* scanner.scan(
      "report group ownership",
      `SELECT g.rowid position,g.groupId,g.sourceRunId,g.latestGeneration,s.sourceRunId sourceOwner,s.sourceJson,json_extract(p.planJson, '$[' || g.attachmentIndex || ']') entryJson,latest.reportId latestId FROM host_report_groups g LEFT JOIN host_report_sources s ON s.sourceId=g.sourceId LEFT JOIN host_report_plans p ON p.runId=g.sourceRunId LEFT JOIN host_reports latest ON latest.groupId=g.groupId AND latest.generation=g.latestGeneration WHERE /* after */ ORDER BY g.rowid LIMIT ?`,
      (raw) => {
        const row = reclaimDecode(
          Schema.Struct({
            entryJson: Schema.String,
            groupId: Text,
            latestGeneration: Positive,
            latestId: Text,
            position: Positive,
            sourceJson: Schema.String,
            sourceOwner: Text,
            sourceRunId: Text,
          }),
          raw
        );
        const source = reclaimDecode(
          SourceIdentity,
          JSON.parse(row.sourceJson)
        );
        const entry = reclaimDecode(ReportPlanEntry, JSON.parse(row.entryJson));
        if (
          row.sourceRunId !== row.sourceOwner ||
          row.groupId !==
            reportGroupId(
              row.sourceRunId,
              source.invocationId,
              entry.attachmentId
            ) ||
          row.latestId !== reportId(row.groupId, row.latestGeneration) ||
          entry.scope !== source.scope ||
          entry.targetId !== source.targetId ||
          entry.targetKind !== source.targetKind ||
          entry.targetVersion !== source.targetVersion
        ) {
          throw unsupportedUpgradeWork("report group identity");
        }
      },
      "g.rowid"
    );
    yield* scanner.scan(
      "report generation ownership",
      `SELECT d.sequence position,d.reportId,d.groupId,d.generation,d.status,d.reportRunId,g.sourceRunId,g.latestGeneration,s.invocationId,root.principal,root.revision,r.runId reportOwner,r.principal reportPrincipal,r.revision reportRevision,r.status reportStatus,r.reportJson FROM host_reports d LEFT JOIN host_report_groups g ON g.groupId=d.groupId LEFT JOIN host_report_sources s ON s.sourceId=g.sourceId LEFT JOIN host_runs root ON root.runId=g.sourceRunId LEFT JOIN host_runs r ON r.runId=d.reportRunId WHERE /* after */ ORDER BY d.sequence LIMIT ?`,
      (raw) => {
        const row = reclaimDecode(
          Schema.Struct({
            generation: Positive,
            groupId: Text,
            invocationId: nullableText,
            latestGeneration: Positive,
            position: Positive,
            principal: Text,
            reportId: Text,
            reportJson: Schema.NullOr(Schema.String),
            reportOwner: nullableText,
            reportPrincipal: nullableText,
            reportRevision: Schema.NullOr(Digest),
            reportRunId: nullableText,
            reportStatus: Schema.NullOr(RunStatus),
            revision: Digest,
            sourceRunId: Text,
            status: ReportRecord.fields.status,
          }),
          raw
        );
        if (
          row.generation > row.latestGeneration ||
          row.reportId !== reportId(row.groupId, row.generation)
        ) {
          throw unsupportedUpgradeWork("report generation identity");
        }
        if (row.reportRunId !== null) {
          if (
            row.reportOwner !== row.reportRunId ||
            row.reportPrincipal !== row.principal ||
            row.reportRevision !== row.revision ||
            row.reportStatus === null ||
            reportStatus(row.reportStatus) !== row.status ||
            row.reportJson === null
          ) {
            throw unsupportedUpgradeWork("report execution ownership");
          }
          const provenance = reclaimDecode(
            ReportProvenance,
            JSON.parse(row.reportJson)
          );
          if (
            provenance.reportId !== row.reportId ||
            provenance.sourceRunId !== row.sourceRunId ||
            provenance.sourceInvocationId !== row.invocationId ||
            provenance.generation !== row.generation
          ) {
            throw unsupportedUpgradeWork("report execution provenance");
          }
        } else if (
          ["Running", "NeedsAttention", "Succeeded"].includes(row.status)
        ) {
          throw unsupportedUpgradeWork("report execution missing");
        }
      }
    );
    yield* scanner.scan(
      "report cancellation ownership",
      `SELECT c.rowid position,c.sourceRunId,c.actor,c.requestKey,c.reason,c.receiptJson,c.maximum,c.position progress,r.runId owner FROM host_report_cancellations c LEFT JOIN host_runs r ON r.runId=c.sourceRunId WHERE /* after */ ORDER BY c.rowid LIMIT ?`,
      (raw) => {
        const row = reclaimDecode(
          Schema.Struct({
            actor: Text,
            maximum: Count,
            owner: Text,
            position: Positive,
            progress: Count,
            reason: Schema.NullOr(Schema.String),
            receiptJson: Schema.String,
            requestKey: Text,
            sourceRunId: Text,
          }),
          raw
        );
        const receipt = reclaimDecode(
          ReportCancelSourceReceipt,
          JSON.parse(row.receiptJson)
        );
        if (
          row.progress > row.maximum ||
          receipt.sourceRunId !== row.sourceRunId ||
          receipt.actor !== row.actor ||
          receipt.requestKey !== row.requestKey ||
          receipt.reason !== row.reason
        ) {
          throw unsupportedUpgradeWork(
            "report cancellation progress or receipt"
          );
        }
      },
      "c.rowid"
    );
  });
}
