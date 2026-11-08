/* oxlint-disable no-loop-func -- Each SQL closure is executed and awaited before advancing its cursor. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { Effect, Schema } from "effect";

import {
  RetiredRun,
  RetirementInstant,
  RetirementReceipt,
  retirementError,
} from "./run-retirement.ts";
import { storageError } from "./storage-error.ts";

export const retirementSql = <A>(body: () => A) =>
  Effect.try({
    catch: (cause) =>
      storageError(cause, "Run reclamation storage operation failed"),
    try: body,
  });
const memberSql = `SELECT r.runId FROM host_runs r WHERE r.runId=? UNION SELECT reportRunId FROM host_reports r JOIN host_report_groups g ON g.groupId=r.groupId WHERE g.sourceRunId=? AND reportRunId IS NOT NULL`;
const Rows = Schema.Struct({
  acceptedAt: RetirementInstant,
  admissionLane: Schema.String,
  completedAt: Schema.NullOr(RetirementInstant),
  engineId: Schema.NullOr(Schema.String),
  fingerprint: Schema.String,
  kind: Schema.String,
  principal: Schema.String,
  requestKey: Schema.String,
  revision: Schema.String,
  runId: Schema.String,
  sourceRunId: Schema.String,
  status: Schema.String,
  targetId: Schema.String,
});
export interface RetirementSelector {
  readonly runId?: string;
  readonly completedBefore?: string;
  readonly target?: string;
}
function selectorCutoff(selector: RetirementSelector) {
  if (
    (selector.runId === undefined) ===
      (selector.completedBefore === undefined) ||
    (selector.target !== undefined && selector.runId !== undefined)
  ) {
    throw retirementError(
      "InvalidInput",
      "Choose --run or --completed-before; --target applies only to the date selector"
    );
  }
  const cutoff =
    selector.completedBefore === undefined
      ? null
      : Date.parse(selector.completedBefore);
  if (
    cutoff !== null &&
    (!Number.isFinite(cutoff) ||
      !/^(?:[0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(
        selector.completedBefore ?? ""
      ))
  ) {
    throw retirementError(
      "InvalidInput",
      "Completion cutoff must be an ISO instant"
    );
  }
  return cutoff;
}
export interface RetirementFamily {
  readonly sourceRunId: string;
  readonly completedAt: string;
  readonly runs: number;
  readonly reports: number;
  readonly fingerprint: string;
}
export interface RetirementSummary {
  readonly planId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly families: readonly RetirementFamily[];
  readonly protected: Readonly<Record<string, number>>;
  readonly hasMore: boolean;
  readonly categories: Readonly<Record<string, number>>;
  readonly estimatedPayloadBytes: number;
  readonly consequence: string;
}
export const RetirementSummarySchema = Schema.Struct({
  categories: Schema.Record(Schema.String, Schema.Int),
  consequence: Schema.String,
  createdAt: RetirementInstant,
  estimatedPayloadBytes: Schema.Finite,
  expiresAt: RetirementInstant,
  families: Schema.Array(
    Schema.Struct({
      completedAt: RetirementInstant,
      fingerprint: Schema.String,
      reports: Schema.Int,
      runs: Schema.Int,
      sourceRunId: Schema.String,
    })
  ),
  hasMore: Schema.Boolean,
  planId: Schema.String,
  protected: Schema.Record(Schema.String, Schema.Int),
});
const members = (db: Database, root: string, after: string) =>
  Schema.decodeUnknownSync(Schema.Array(Rows))(
    db
      .query(
        `SELECT r.runId,? sourceRunId,r.principal,r.admissionLane,r.requestKey,r.fingerprint,r.engineId,r.kind,r.targetId,r.revision,r.status,r.acceptedAt,c.completedAt FROM host_runs r LEFT JOIN host_run_completions c ON c.runId=r.runId WHERE r.runId IN (${memberSql}) AND r.runId>? ORDER BY r.runId LIMIT 256`
      )
      .all(root, root, root, after)
  );
const projection = (runId: string) =>
  `runId IN (SELECT runId FROM host_retirement_members WHERE planId='${runId}')`;
// planId is generated internally as a UUID; callers never interpolate user input.
export function retirementDeletionSteps(planId: string) {
  if (!/^[\da-f-]{36}$/u.test(planId)) {
    throw retirementError("InvalidInput", "Invalid reclamation plan id");
  }
  const scope = projection(planId);
  const roots = `SELECT sourceRunId FROM host_retirement_families WHERE planId='${planId}'`;
  const reports = `SELECT r.sequence FROM host_reports r JOIN host_report_groups g ON g.groupId=r.groupId WHERE g.sourceRunId IN (${roots})`;
  const targets = `SELECT id FROM host_retired_targets WHERE sourceRunId IN (${roots})`;
  return [
    [
      "host_receipts",
      `waitId IN (SELECT waitId FROM host_waits WHERE ${scope})`,
    ],
    [
      "host_report_receipts",
      `subjectId IN (${targets}) OR subjectId IN (SELECT groupId FROM host_report_groups WHERE sourceRunId IN (${roots})) OR subjectId IN (SELECT reportId FROM host_reports WHERE sequence IN (${reports}))`,
    ],
    ["host_report_search_tags", `sequence IN (${reports})`],
    ["host_report_search", `sequence IN (${reports})`],
    ["lake_report_holds", `sourceRunId IN (${roots})`],
    ["host_reports", `sequence IN (${reports})`],
    ["host_report_groups", `sourceRunId IN (${roots})`],
    ["host_report_sources", `sourceRunId IN (${roots})`],
    ["host_report_cancellations", `sourceRunId IN (${roots})`],
    ...[
      "host_report_plans",
      "host_report_paths",
      "host_cancellation_receipts",
      "host_waits",
      "host_fences",
      "host_outbox",
      "host_attempts",
      "host_attempt_windows",
      "host_recovery_holds",
      "host_recovery_gates",
      "host_recovery_gate_obligations",
      "host_recovery_generations",
      "host_events",
      "host_checks",
      "host_check_budget",
      "host_telemetry_budget",
      "host_workflow_invocations",
      "host_invocations",
      "host_run_tags",
      "host_run_completions",
    ].map((table) => [table, scope]),
    [
      "lake_consumer_pins",
      `consumerRunId IN (SELECT runId FROM host_retirement_members WHERE planId='${planId}')`,
    ],
    ["lake_pin_cleanup", scope],
    ["host_runs", scope],
  ] as readonly (readonly string[])[];
}
export function createRetirementStore(
  db: Database,
  repositoryId: string,
  principal: string
) {
  const family = (root: string, capture?: string) =>
    Effect.gen(function* () {
      const hash = createHash("sha256");
      let after = "";
      let completed = "";
      let count = 0;
      let reason: string | null = null;
      let reportCount = 0;
      for (;;) {
        const page = yield* retirementSql(() => members(db, root, after));
        if (!page.length) {
          break;
        }
        yield* retirementSql(() =>
          db.transaction(() => {
            for (const row of page) {
              if (row.principal !== principal) {
                throw retirementError("NotFound", "Run was not found");
              }
              hash.update(JSON.stringify(row));
              count += 1;
              after = row.runId;
              if (
                ![
                  "Succeeded",
                  "Failed",
                  "Rejected",
                  "TimedOut",
                  "Cancelled",
                ].includes(row.status)
              ) {
                reason = "UnfinishedRun";
              } else if (row.completedAt === null) {
                reason ??= "UnknownCompletion";
              } else {
                completed =
                  Date.parse(completed) > Date.parse(row.completedAt)
                    ? completed
                    : row.completedAt;
              }
              if (
                db
                  .query(
                    "SELECT 1 FROM host_outbox WHERE runId=? AND delivered=0 LIMIT 1"
                  )
                  .get(row.runId)
              ) {
                reason ??= "PendingOutbox";
              }
              if (
                db
                  .query(
                    "SELECT 1 FROM host_recovery_holds WHERE runId=? AND state='Open' UNION ALL SELECT 1 FROM host_recovery_gate_obligations WHERE runId=? AND closed=0 LIMIT 1"
                  )
                  .get(row.runId, row.runId)
              ) {
                reason ??= "PendingRecovery";
              }
              if (capture) {
                db.query(
                  "INSERT INTO host_retirement_members VALUES(?,?,?)"
                ).run(capture, row.runId, root);
              }
            }
          })()
        );
        yield* Effect.yieldNow;
      }
      let seq = 0;
      for (;;) {
        const page = yield* retirementSql(() =>
          db
            .query<
              {
                sequence: number;
                reportId: string;
                groupId: string;
                generation: number;
                reportRunId: string | null;
                status: string;
                settledAt: string | null;
              },
              [string, number]
            >(
              "SELECT r.sequence,r.reportId,r.groupId,r.generation,r.reportRunId,r.status,r.settledAt FROM host_reports r JOIN host_report_groups g ON g.groupId=r.groupId WHERE g.sourceRunId=? AND r.sequence>? ORDER BY r.sequence LIMIT 256"
            )
            .all(root, seq)
        );
        if (!page.length) {
          break;
        }
        for (const row of page) {
          hash.update(JSON.stringify(row));
          reportCount += 1;
          seq = row.sequence;
          if (
            ["WaitingSource", "Queued", "Running", "NeedsAttention"].includes(
              row.status
            )
          ) {
            reason = "PendingReports";
          }
          if (row.settledAt) {
            const settledAt = yield* retirementSql(() =>
              Schema.decodeUnknownSync(RetirementInstant)(row.settledAt)
            );
            completed =
              Date.parse(completed) > Date.parse(settledAt)
                ? completed
                : settledAt;
          } else if (
            !["WaitingSource", "Queued", "Running", "NeedsAttention"].includes(
              row.status
            )
          ) {
            reason ??= "UnknownCompletion";
          }
        }
        yield* Effect.yieldNow;
      }
      return {
        reason,
        summary: {
          completedAt: completed,
          fingerprint: hash.digest("hex"),
          reports: reportCount,
          runs: count,
          sourceRunId: root,
        } satisfies RetirementFamily,
      };
    });
  const load = (id: string) => {
    const row = db
      .query<
        {
          planId: string;
          repositoryId: string;
          principal: string;
          format: number;
          expiresAt: number;
          state: string;
          summaryJson: string;
          startedAt: string | null;
          receiptJson: string | null;
        },
        [string, string]
      >("SELECT * FROM host_retirement_plans WHERE planId=? AND principal=?")
      .get(id, principal);
    if (!row) {
      throw retirementError("NotFound", "Reclamation plan was not found");
    }
    if (row.repositoryId !== repositoryId || row.format !== 1) {
      throw retirementError(
        "Conflict",
        "Reclamation plan belongs to another repository or storage format"
      );
    }
    if (!["Building", "Planned", "Applying", "Complete"].includes(row.state)) {
      throw retirementError("Unavailable", "Invalid reclamation plan state");
    }
    if (row.state !== "Building") {
      const summary = Schema.decodeUnknownSync(RetirementSummarySchema)(
        JSON.parse(row.summaryJson)
      );
      if (summary.planId !== id) {
        throw retirementError(
          "Unavailable",
          "Reclamation manifest identity is invalid"
        );
      }
    }
    return row;
  };
  const inventory = (planId: string) =>
    Effect.gen(function* () {
      const categories: Record<string, number> = {};
      let estimatedPayloadBytes = 0;
      for (const step of retirementDeletionSteps(planId)) {
        const [table, where] = step;
        if (!table || !where) {
          continue;
        }
        const exists = yield* retirementSql(() =>
          db
            .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
            .get(table)
        );
        if (!exists) {
          continue;
        }
        const columns = yield* retirementSql(() =>
          db
            .query<{ name: string; type: string }, []>(
              `PRAGMA table_info(${table})`
            )
            .all()
            .filter((c) => c.type === "TEXT")
            .map((c) => `COALESCE(length(CAST(${c.name} AS BLOB)),0)`)
        );
        if (table === "host_report_search_tags") {
          const total = yield* retirementSql(() =>
            db
              .query<{ count: number; bytes: number }, []>(
                `SELECT COUNT(*) count,COALESCE(SUM(${columns.join("+") || "0"}),0) bytes FROM ${table} WHERE ${where}`
              )
              .get()
          );
          categories[table] = total?.count ?? 0;
          estimatedPayloadBytes += total?.bytes ?? 0;
          yield* Effect.yieldNow;
          continue;
        }
        let after = 0;
        let count = 0;
        for (;;) {
          const page = yield* retirementSql(() =>
            db
              .query<{ position: number; bytes: number }, [number]>(
                `SELECT rowid position,${columns.join("+") || "0"} bytes FROM ${table} WHERE (${where}) AND rowid>? ORDER BY rowid LIMIT 256`
              )
              .all(after)
          );
          if (!page.length) {
            break;
          }
          for (const row of page) {
            after = row.position;
            count += 1;
            estimatedPayloadBytes += row.bytes;
          }
          yield* Effect.yieldNow;
        }
        categories[table] = count;
      }
      return { categories, estimatedPayloadBytes };
    });
  const plan = (selector: RetirementSelector) =>
    Effect.gen(function* () {
      const cutoff = yield* retirementSql(() => selectorCutoff(selector));
      const selectedRunId = selector.runId;
      if (selectedRunId !== undefined) {
        const row = yield* retirementSql(() =>
          db
            .query<
              { admissionLane: string; reportJson: string | null },
              [string, string]
            >(
              "SELECT admissionLane,reportJson FROM host_runs WHERE runId=? AND principal=?"
            )
            .get(selectedRunId, principal)
        );
        if (!row) {
          return yield* retirementError("NotFound", "Run was not found");
        }
        if (row.admissionLane === "report") {
          return yield* retirementError(
            "InvalidInput",
            `Select the source run instead: ${String(JSON.parse(row.reportJson ?? "{}").sourceRunId)}`
          );
        }
      }
      const planId = crypto.randomUUID();
      yield* retirementSql(() =>
        db
          .query(
            "INSERT INTO host_retirement_plans VALUES(?,?,?,1,?,0,'Building','{}',NULL,NULL)"
          )
          .run(planId, repositoryId, principal, new Date().toISOString())
      );
      const candidates: RetirementFamily[] = [];
      const protectedCounts: Record<string, number> = {};
      let after = "";
      let hasMore = false;
      for (;;) {
        const page = yield* retirementSql(() =>
          db
            .query<
              { runId: string },
              [
                string,
                string,
                string | null,
                string | null,
                string | null,
                string | null,
              ]
            >(
              "SELECT runId FROM host_runs WHERE principal=? AND admissionLane!='report' AND runId>? AND (? IS NULL OR runId=?) AND (? IS NULL OR targetId=?) ORDER BY runId LIMIT 128"
            )
            .all(
              principal,
              after,
              selector.runId ?? null,
              selector.runId ?? null,
              selector.target ?? null,
              selector.target ?? null
            )
        );
        if (!page.length) {
          break;
        }
        for (const row of page) {
          after = row.runId;
          const info = yield* family(row.runId);
          if (info.reason) {
            protectedCounts[info.reason] =
              (protectedCounts[info.reason] ?? 0) + 1;
            continue;
          }
          if (
            cutoff !== null &&
            Date.parse(info.summary.completedAt) >= cutoff
          ) {
            continue;
          }
          candidates.push(info.summary);
          candidates.sort(
            (a, b) =>
              Date.parse(a.completedAt) - Date.parse(b.completedAt) ||
              a.sourceRunId.localeCompare(b.sourceRunId)
          );
          if (candidates.length > 100) {
            candidates.pop();
            hasMore = true;
          }
        }
        yield* Effect.yieldNow;
      }
      for (const candidate of candidates) {
        yield* family(candidate.sourceRunId, planId);
        yield* retirementSql(() =>
          db
            .query("INSERT INTO host_retirement_families VALUES(?,?,?)")
            .run(planId, candidate.sourceRunId, candidate.fingerprint)
        );
      }
      const counts = yield* inventory(planId);
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 900_000).toISOString();
      const summary: RetirementSummary = {
        createdAt,
        expiresAt,
        families: candidates,
        hasMore,
        planId,
        protected: protectedCounts,
        ...counts,
        consequence:
          "Removes run diagnostics and report content; permanently ends regeneration for these report families. Artifact content is retained. Logical bytes are not physical space recoverable.",
      };
      yield* retirementSql(() =>
        db
          .query(
            "UPDATE host_retirement_plans SET state='Planned',createdAt=?,expiresAt=?,summaryJson=? WHERE planId=?"
          )
          .run(
            createdAt,
            Date.parse(expiresAt),
            JSON.stringify(summary),
            planId
          )
      );
      return summary;
    });
  const validate = (planId: string) =>
    Effect.gen(function* () {
      const row = yield* retirementSql(() => load(planId));
      if (row.state === "Complete" || row.state === "Applying") {
        return row;
      }
      if (row.state !== "Planned" || row.expiresAt <= Date.now()) {
        return yield* retirementError(
          "Conflict",
          "Reclamation plan expired or incomplete; preview again"
        );
      }
      const families = yield* retirementSql(() =>
        db
          .query<{ sourceRunId: string; fingerprint: string }, [string]>(
            "SELECT sourceRunId,fingerprint FROM host_retirement_families WHERE planId=?"
          )
          .all(planId)
      );
      for (const expected of families) {
        const actual = yield* family(expected.sourceRunId);
        if (
          actual.reason ||
          actual.summary.fingerprint !== expected.fingerprint
        ) {
          return yield* retirementError(
            "Conflict",
            "Reclamation family changed; preview again"
          );
        }
      }
      return row;
    });
  const begin = (planId: string) =>
    db
      .transaction(() => {
        const row = load(planId);
        if (row.state !== "Planned") {
          return;
        }
        const now = new Date().toISOString();
        // Bounded iteration, one transaction: no author code, async work, or message-store calls.
        let after = "";
        for (;;) {
          const batch = db
            .query<{ runId: string; sourceRunId: string }, [string, string]>(
              "SELECT runId,sourceRunId FROM host_retirement_members WHERE planId=? AND runId>? ORDER BY runId LIMIT 256"
            )
            .all(planId, after);
          if (!batch.length) {
            break;
          }
          for (const item of batch) {
            const member = Schema.decodeUnknownSync(Rows)(
              db
                .query(
                  `SELECT r.*,? sourceRunId,c.completedAt FROM host_runs r JOIN host_run_completions c ON c.runId=r.runId WHERE r.runId=?`
                )
                .get(item.sourceRunId, item.runId)
            );
            const record = Schema.decodeUnknownSync(RetiredRun)({
              ...member,
              planId,
              retiredAt: now,
            });
            db.query(
              "INSERT INTO host_retired_runs SELECT ?,?,?,?,?,?,?,?,scheduleJson FROM host_runs WHERE runId=?"
            ).run(
              member.runId,
              member.sourceRunId,
              principal,
              member.admissionLane,
              member.requestKey,
              member.fingerprint,
              member.status,
              JSON.stringify(record),
              member.runId
            );
            db.query(
              "INSERT INTO host_retired_targets VALUES('run',?,?,?)"
            ).run(member.runId, principal, member.sourceRunId);
            db.query(
              "INSERT OR IGNORE INTO host_retired_targets SELECT 'wait',waitId,?,? FROM host_waits WHERE runId=?"
            ).run(principal, member.sourceRunId, member.runId);
            if (member.engineId) {
              db.query(
                "INSERT OR IGNORE INTO host_retirement_native VALUES(?,'Workflow/EffectoryExecution/v1',?)"
              ).run(planId, member.engineId);
            }
            db.query(
              "INSERT OR IGNORE INTO host_retirement_native SELECT ?,'Workflow/EffectoryTask/v1',engineId FROM host_invocations WHERE runId=?"
            ).run(planId, member.runId);
            after = member.runId;
          }
        }
        db.query(
          "INSERT OR IGNORE INTO host_retired_targets SELECT 'report',r.reportId,?,g.sourceRunId FROM host_reports r JOIN host_report_groups g ON g.groupId=r.groupId JOIN host_retirement_families f ON f.sourceRunId=g.sourceRunId WHERE f.planId=?"
        ).run(principal, planId);
        db.query(
          "INSERT OR IGNORE INTO host_retired_targets SELECT 'report-group',g.groupId,?,g.sourceRunId FROM host_report_groups g JOIN host_retirement_families f ON f.sourceRunId=g.sourceRunId WHERE f.planId=?"
        ).run(principal, planId);
        db.query(
          "INSERT OR IGNORE INTO host_retirement_native SELECT planId,'Workflow/-/DurableClock',entityId FROM host_retirement_native WHERE planId=?"
        ).run(planId);
        db.query(
          "UPDATE host_retirement_plans SET state='Applying',startedAt=? WHERE planId=?"
        ).run(now, planId);
        db.exec("UPDATE host_retirement_epoch SET epoch=epoch+1 WHERE id=1");
      })
      .immediate();
  const deleteBatch = (planId: string, table: string, where: string) =>
    db
      .transaction(() => {
        if (
          !db
            .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
            .get(table)
        ) {
          return 0;
        }
        const key =
          table === "host_report_search_tags"
            ? "(principal,key,value,sequence)"
            : "rowid";
        const columns =
          table === "host_report_search_tags"
            ? "principal,key,value,sequence"
            : "rowid";
        const result = db
          .query(
            `DELETE FROM ${table} WHERE ${key} IN (SELECT ${columns} FROM ${table} WHERE ${where} LIMIT 256)`
          )
          .run();
        if (result.changes) {
          db.query(
            "INSERT INTO host_retirement_counts VALUES(?,?,?) ON CONFLICT(planId,category) DO UPDATE SET count=count+excluded.count"
          ).run(planId, table, result.changes);
        }
        return result.changes;
      })
      .immediate();
  const complete = (planId: string) =>
    db
      .transaction(() => {
        const row = load(planId);
        const counts = Object.fromEntries(
          db
            .query<{ category: string; count: number }, [string]>(
              "SELECT category,count FROM host_retirement_counts WHERE planId=?"
            )
            .all(planId)
            .map((r) => [r.category, r.count])
        );
        const summary = Schema.decodeUnknownSync(RetirementSummarySchema)(
          JSON.parse(row.summaryJson)
        );
        const receipt = Schema.decodeUnknownSync(RetirementReceipt)({
          completedAt: new Date().toISOString(),
          deletedRows: counts,
          planId,
          retiredFamilies: summary.families.length,
          retiredRuns: summary.families.reduce((n, f) => n + f.runs, 0),
          startedAt: row.startedAt,
        });
        db.query(
          "UPDATE host_retirement_plans SET state='Complete',receiptJson=? WHERE planId=?"
        ).run(JSON.stringify(receipt), planId);
        db.query("DELETE FROM host_retirement_members WHERE planId=?").run(
          planId
        );
        db.query("DELETE FROM host_retirement_families WHERE planId=?").run(
          planId
        );
        return receipt;
      })
      .immediate();
  return { begin, complete, deleteBatch, load, plan, validate };
}
