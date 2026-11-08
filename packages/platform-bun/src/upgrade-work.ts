import type { Database } from "bun:sqlite";

import { RunStatus, terminal } from "@effectory/runtime/protocol";
import { ReportRecord } from "@effectory/runtime/report-protocol";
import { Effect, Schema } from "effect";

import { unsupportedUpgradeWork, upgradeScanner } from "./upgrade-scan.ts";

const Text = Schema.String.check(Schema.isMaxLength(4096));
const Position = Schema.Int;
const Owner = {
  position: Position,
  revision: Text,
  runId: Text,
};
const RunRow = Schema.Struct({ ...Owner, status: RunStatus });
const ReportRow = Schema.Struct({
  ...Owner,
  reportId: Text,
  status: ReportRecord.fields.status,
});
const SourceRow = Schema.Struct({
  ...Owner,
  phase: Schema.Literals(["Armed", "Ready", "Materialized"]),
  sourceId: Text,
});
const CancelRow = Schema.Struct({
  ...Owner,
  batchId: Text,
  maximum: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  progress: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const ScheduleRow = Schema.Struct({
  pendingSlot: Schema.NullOr(Schema.Finite),
  position: Position,
  revision: Text,
  scheduleId: Text,
});

export const emptyUpgradeWork = () => ({
  reportCancellations: 0,
  reportSources: 0,
  reports: 0,
  runs: 0,
  scheduledAdmissions: 0,
});
export type UpgradeWorkCounts = ReturnType<typeof emptyUpgradeWork>;

const decode = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  raw: unknown
) => Schema.decodeUnknownSync(schema)(raw, { onExcessProperty: "error" });

/**
 * Offline plan inventory. Every visited header counts against the shared budget,
 * including settled rows: LIMIT after a status filter would not bound SQL work.
 * Payloads/results are not loaded. Queries page by primary integer position and
 * join only unique owner keys. No application registry or engine is constructed.
 */
export function inspectUpgradeWork(database: Database) {
  return Effect.gen(function* () {
    const tables = yield* Effect.try({
      catch: () => unsupportedUpgradeWork("execution inventory"),
      try: () => {
        const names = [
          "host_runs",
          "host_reports",
          "host_report_groups",
          "host_report_sources",
          "host_report_cancellations",
          "host_schedules",
        ];
        return new Set(
          names.filter(
            (name) =>
              database
                .query(
                  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
                )
                .get(name) !== null
          )
        );
      },
    });
    if (tables.size > 0 && !tables.has("host_runs")) {
      return yield* unsupportedUpgradeWork("execution inventory owner table");
    }
    if (
      [
        "host_reports",
        "host_report_groups",
        "host_report_sources",
        "host_report_cancellations",
      ].some((name) => tables.has(name)) &&
      ![
        "host_reports",
        "host_report_groups",
        "host_report_sources",
        "host_report_cancellations",
      ].every((name) => tables.has(name))
    ) {
      return yield* unsupportedUpgradeWork("partial report inventory");
    }
    const scanner = upgradeScanner(database);
    const counts = emptyUpgradeWork();
    const revisions = new Map<
      string,
      {
        counts: UpgradeWorkCounts;
        examples: { category: keyof UpgradeWorkCounts; id: string }[];
      }
    >();
    const record = (
      category: keyof UpgradeWorkCounts,
      revision: string,
      id: string
    ) => {
      const group = revisions.get(revision) ?? {
        counts: emptyUpgradeWork(),
        examples: [],
      };
      group.counts[category] += 1;
      counts[category] += 1;
      if (group.examples.length < 20) {
        group.examples.push({ category, id });
      }
      revisions.set(revision, group);
      if (revisions.size > 128) {
        throw unsupportedUpgradeWork("execution inventory revision limit");
      }
    };
    if (tables.has("host_runs")) {
      yield* scanner.scan(
        "run inventory",
        `SELECT rowid position,runId,revision,status FROM host_runs WHERE /* after */ ORDER BY rowid LIMIT ?`,
        (raw) => {
          const row = decode(RunRow, raw);
          if (!terminal.has(row.status)) {
            record("runs", row.revision, row.runId);
          }
        }
      );
    }
    if (tables.has("host_reports")) {
      yield* scanner.scan(
        "report inventory",
        `SELECT r.sequence position,r.reportId,r.status,root.runId,root.revision
        FROM host_reports r LEFT JOIN host_report_groups g ON g.groupId=r.groupId
        LEFT JOIN host_runs root ON root.runId=g.sourceRunId
        WHERE /* after */ ORDER BY r.sequence LIMIT ?`,
        (raw) => {
          const row = decode(ReportRow, raw);
          if (
            ["WaitingSource", "Queued", "Running", "NeedsAttention"].includes(
              row.status
            )
          ) {
            record("reports", row.revision, row.reportId);
          }
        }
      );
      yield* scanner.scan(
        "report source inventory",
        `SELECT s.sourceSeq position,s.sourceId,s.phase,root.runId,root.revision
        FROM host_report_sources s LEFT JOIN host_runs root ON root.runId=s.sourceRunId
        WHERE /* after */ ORDER BY s.sourceSeq LIMIT ?`,
        (raw) => {
          const row = decode(SourceRow, raw);
          if (row.phase !== "Materialized") {
            record("reportSources", row.revision, row.sourceId);
          }
        }
      );
      yield* scanner.scan(
        "report cancellation inventory",
        `SELECT c.rowid position,c.batchId,c.maximum,c.position progress,root.runId,root.revision
        FROM host_report_cancellations c LEFT JOIN host_runs root ON root.runId=c.sourceRunId
        WHERE /* after */ ORDER BY c.rowid LIMIT ?`,
        (raw) => {
          const row = decode(CancelRow, raw);
          if (row.progress > row.maximum) {
            throw unsupportedUpgradeWork("report cancellation progress");
          }
          if (row.progress < row.maximum) {
            record("reportCancellations", row.revision, row.batchId);
          }
        },
        "c.rowid"
      );
    }
    if (tables.has("host_schedules")) {
      yield* scanner.scan(
        "scheduled admission inventory",
        `SELECT identity position,scheduleId,revision,pendingSlot
        FROM host_schedules WHERE /* after */ ORDER BY identity LIMIT ?`,
        (raw) => {
          const row = decode(ScheduleRow, raw);
          if (row.pendingSlot !== null) {
            record("scheduledAdmissions", row.revision, row.scheduleId);
          }
        }
      );
    }
    return {
      ...scanner.totals,
      counts,
      revisions: [...revisions]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([revision, group]) => ({
          ...group,
          examplesTruncated:
            Object.values(group.counts).reduce((sum, count) => sum + count, 0) >
            group.examples.length,
          revision,
        })),
    };
  });
}
