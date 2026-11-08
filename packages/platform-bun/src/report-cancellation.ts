import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { OperationError } from "@effectory/runtime/protocol";
import {
  ReportCancelSourceRequest,
  ReportCancelSourceReceipt,
} from "@effectory/runtime/report-protocol";
import type { ReportCancelSingleRequest } from "@effectory/runtime/report-protocol";
import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import { Schema } from "effect";

import { authorizeRun } from "./inspection.ts";

const Batch = Schema.Struct({
  actor: Schema.String,
  batchId: Schema.String,
  maximum: Schema.Int,
  position: Schema.Int,
  reason: Schema.NullOr(Schema.String),
  sourceRunId: Schema.String,
});

/** A sequence fence fixes membership without copying up to 160,000 report IDs. */
export function createReportCancellation(database: Database) {
  database.run(`CREATE TABLE IF NOT EXISTS host_report_cancellations (
    batchId TEXT PRIMARY KEY, sourceRunId TEXT NOT NULL REFERENCES host_runs(runId),
    actor TEXT NOT NULL, requestKey TEXT NOT NULL, reason TEXT, maximum INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0, receiptJson TEXT NOT NULL,
    UNIQUE(sourceRunId, actor, requestKey)
  );
  CREATE INDEX IF NOT EXISTS host_report_cancellations_source ON host_report_cancellations(sourceRunId, maximum);
  CREATE INDEX IF NOT EXISTS host_report_cancellations_pending ON host_report_cancellations(batchId) WHERE position < maximum;`);
  return {
    accept: (value: typeof ReportCancelSourceRequest.Type, actor: string) =>
      database.transaction(() => {
        if (!Schema.is(ReportCancelSourceRequest)(value)) {
          throw new OperationError({
            code: "InvalidInput",
            message: "Invalid report cancellation request",
          });
        }
        const request = Schema.decodeSync(ReportCancelSourceRequest)(value, {
          onExcessProperty: "error",
        });
        authorizeRun(database, request.sourceRunId, actor);
        const reason = request.reason ?? null;
        const prior = database
          .query(
            "SELECT reason, receiptJson FROM host_report_cancellations WHERE sourceRunId = ? AND actor = ? AND requestKey = ?"
          )
          .get(request.sourceRunId, actor, request.requestKey);
        if (prior !== null) {
          const row = Schema.decodeUnknownSync(
            Schema.Struct({
              reason: Schema.NullOr(Schema.String),
              receiptJson: Schema.String,
            })
          )(prior);
          if (row.reason !== reason) {
            throw new OperationError({
              code: "Conflict",
              message: "Report cancellation key was used with another reason",
            });
          }
          return {
            ...Schema.decodeUnknownSync(ReportCancelSourceReceipt)(
              JSON.parse(row.receiptJson)
            ),
            replayed: true,
          };
        }
        // Sequence numbers never rewind within this store. New invocations and
        // retries receive larger numbers and cannot join an accepted selection.
        const { maximum } = Schema.decodeUnknownSync(
          Schema.Struct({ maximum: Schema.Int })
        )(
          database
            .query(
              "SELECT COALESCE(MAX(r.sequence),0) AS maximum FROM host_reports r JOIN host_report_groups g ON g.groupId = r.groupId WHERE g.sourceRunId = ? AND r.generation = g.latestGeneration AND r.status IN ('WaitingSource','Queued','Running','NeedsAttention')"
            )
            .get(request.sourceRunId)
        );
        const result = ReportCancelSourceReceipt.make({
          acceptedAt: new Date().toISOString(),
          actor,
          reason,
          replayed: false,
          requestKey: request.requestKey,
          sourceRunId: request.sourceRunId,
        });
        const batchId = createHash("sha256")
          .update(
            canonical([
              "report-cancel-source/v1",
              actor,
              request.sourceRunId,
              request.requestKey,
            ])
          )
          .digest("hex");
        database
          .query(
            "INSERT INTO host_report_cancellations(batchId,sourceRunId,actor,requestKey,reason,maximum,receiptJson) VALUES (?,?,?,?,?,?,?)"
          )
          .run(
            batchId,
            request.sourceRunId,
            actor,
            request.requestKey,
            reason,
            maximum,
            canonical(result)
          );
        return result;
      })(),
    drain: (
      cancel: (
        request: typeof ReportCancelSingleRequest.Type,
        actor: string
      ) => unknown
    ) =>
      database.transaction(() => {
        const raw = database
          .query(
            "SELECT * FROM host_report_cancellations WHERE position < maximum ORDER BY batchId LIMIT 1"
          )
          .get();
        if (raw === null) {
          return 0;
        }
        const batch = Schema.decodeUnknownSync(Batch)(raw);
        const rows = Schema.decodeUnknownSync(
          Schema.Array(
            Schema.Struct({ reportId: Schema.String, sequence: Schema.Int })
          )
        )(
          database
            .query(`SELECT r.reportId, r.sequence FROM host_reports r JOIN host_report_groups g ON g.groupId = r.groupId
            WHERE g.sourceRunId = ? AND r.sequence > ? AND r.sequence <= ?
              AND r.status IN ('WaitingSource','Queued','Running','NeedsAttention')
            ORDER BY r.sequence LIMIT 200`)
            .all(batch.sourceRunId, batch.position, batch.maximum)
        );
        for (const row of rows) {
          cancel(
            {
              reportId: row.reportId,
              requestKey: batch.batchId,
              ...(batch.reason === null ? {} : { reason: batch.reason }),
            },
            batch.actor
          );
        }
        database
          .query(
            "UPDATE host_report_cancellations SET position = ? WHERE batchId = ?"
          )
          .run(
            rows.length < 200
              ? batch.maximum
              : (rows.at(-1)?.sequence ?? batch.maximum),
            batch.batchId
          );
        return rows.length;
      })(),
  };
}
