import type { Database } from "bun:sqlite";

import {
  OperationError,
  RunStatus,
  terminal,
} from "@effectory/runtime/protocol";
import type { Run } from "@effectory/runtime/protocol";
import type { ReportRecord } from "@effectory/runtime/report-protocol";
import {
  ReportAggregate,
  ReportGetReply,
  RunReportsRequest,
} from "@effectory/runtime/report-protocol";
import { RecordStatus } from "@offtree/effectory-sdk/internal/report-record";
import { Schema } from "effect";

import { authorizeRun } from "./inspection.ts";
import type { createPagination } from "./pagination.ts";
import type { createReportRecords } from "./report-records.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const pageLimit = () =>
  new OperationError({
    code: "LimitExceeded",
    message: "Report inspection exceeds the 2 MiB response limit",
  });

export function createReportInspection(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  records: ReturnType<typeof createReportRecords>
) {
  const projectedRun = (id: string) => {
    const row = Schema.decodeUnknownSync(
      Schema.Struct({
        errorJson: Schema.NullOr(Schema.String),
        status: RunStatus,
      })
    )(
      database
        .query("SELECT status,errorJson FROM host_runs WHERE runId = ?")
        .get(id)
    );
    return {
      error:
        row.errorJson === null
          ? null
          : Schema.decodeUnknownSync(Schema.Json)(JSON.parse(row.errorJson)),
      status: row.status,
    };
  };
  const aggregate = (runId: string, principal: string) => {
    authorizeRun(database, runId, principal);
    const { status } = Schema.decodeUnknownSync(
      Schema.Struct({ status: RunStatus })
    )(
      database.query("SELECT status FROM host_runs WHERE runId = ?").get(runId)
    );
    const counts = {
      Cancelled: 0,
      Failed: 0,
      NeedsAttention: 0,
      NotApplicable: 0,
      Queued: 0,
      Running: 0,
      Succeeded: 0,
      WaitingSource: 0,
    };
    const rows = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ count: Count, status: RecordStatus }))
    )(
      database
        .query(`SELECT r.status, COUNT(*) AS count FROM host_report_groups g JOIN host_reports r
        ON r.groupId = g.groupId AND r.generation = g.latestGeneration WHERE g.sourceRunId = ? GROUP BY r.status`)
        .all(runId)
    );
    let total = 0;
    for (const row of rows) {
      counts[row.status] = row.count;
      total += row.count;
    }
    return ReportAggregate.make({
      ...counts,
      observedAt: new Date().toISOString(),
      sourceTerminal: terminal.has(status),
      total,
    });
  };
  return {
    aggregate,
    get: (id: string, principal: string, getRun: (id: string) => Run) => {
      const record = records.get(id, projectedRun, principal);
      const content =
        record.status === "Succeeded" && record.reportRunId !== null
          ? getRun(record.reportRunId).result
          : null;
      const response = Schema.decodeUnknownSync(ReportGetReply)({
        content,
        record,
      });
      if (Buffer.byteLength(JSON.stringify(response)) > 2_097_152) {
        throw pageLimit();
      }
      return response;
    },
    list: (value: typeof RunReportsRequest.Type, principal: string) => {
      const {
        cursor,
        runId,
        history = false,
        limit = 50,
      } = Schema.decodeSync(RunReportsRequest)(value, {
        onExcessProperty: "error",
      });
      authorizeRun(database, runId, principal);
      const scope = {
        kind: "reports",
        principal,
        query: { history, limit, runId },
      };
      const token = pages.read(scope, cursor);
      const snapshot =
        token === null
          ? Schema.decodeUnknownSync(Schema.Struct({ value: Count }))(
              database
                .query(
                  "SELECT COALESCE(MAX(sequence),0) AS value FROM host_reports"
                )
                .get()
            ).value
          : Schema.decodeUnknownSync(Count)(token.snapshot);
      const after =
        token === null ? 0 : Schema.decodeUnknownSync(Count)(token.position);
      // Latest membership is as of the first page. A new retry cannot replace a
      // row halfway through a traversal. Projected status and aggregates stay live.
      const rows = Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({ reportId: Schema.String, sequence: Count })
        )
      )(
        database
          .query(`SELECT r.reportId, r.sequence FROM host_report_groups g JOIN host_reports r ON r.groupId = g.groupId
          WHERE g.sourceRunId = ? AND r.sequence > ? AND r.sequence <= ?
            AND (? OR NOT EXISTS (SELECT 1 FROM host_reports newer WHERE newer.groupId = r.groupId AND newer.generation > r.generation AND newer.sequence <= ?))
          ORDER BY r.sequence LIMIT ?`)
          .all(runId, after, snapshot, history ? 1 : 0, snapshot, limit + 1)
      );
      const current = aggregate(runId, principal);
      const items: (typeof ReportRecord.Type)[] = [];
      let position = after;
      let more = false;
      // Include envelope and maximum signed-cursor overhead in the page budget.
      let bytes = Buffer.byteLength(JSON.stringify(current)) + 8192;
      for (const row of rows) {
        if (items.length === limit) {
          more = true;
          break;
        }
        const record = records.get(row.reportId, projectedRun, principal);
        bytes += Buffer.byteLength(JSON.stringify(record)) + 1;
        if (bytes > 2_097_152) {
          more = true;
          break;
        }
        items.push(record);
        position = row.sequence;
      }
      if (more && items.length === 0) {
        throw pageLimit();
      }
      return {
        aggregate: current,
        cursor: more
          ? pages.write(
              scope,
              snapshot,
              position,
              token?.expires ?? Date.now() + 3_600_000
            )
          : null,
        items,
        snapshot,
      };
    },
    system: () => {
      const counts = {
        Cancelled: 0,
        Failed: 0,
        NeedsAttention: 0,
        NotApplicable: 0,
        Queued: 0,
        Running: 0,
        Succeeded: 0,
        WaitingSource: 0,
        total: 0,
      };
      let lowerBound = false;
      for (const status of [
        "WaitingSource",
        "Queued",
        "Running",
        "NeedsAttention",
        "Succeeded",
        "Failed",
        "Cancelled",
        "NotApplicable",
      ] as const) {
        const { count } = Schema.decodeUnknownSync(
          Schema.Struct({ count: Count })
        )(
          database
            .query(
              `SELECT COUNT(*) AS count FROM (SELECT r.reportId FROM host_reports r JOIN host_report_groups g ON g.groupId = r.groupId AND g.latestGeneration = r.generation WHERE r.status = ? LIMIT 10001)`
            )
            .get(status)
        );
        counts[status] = Math.min(count, 10_000);
        counts.total += counts[status];
        lowerBound ||= count > 10_000;
      }
      return { counts, lowerBound };
    },
  };
}
