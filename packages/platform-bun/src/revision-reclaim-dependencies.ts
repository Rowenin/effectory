import type { Database } from "bun:sqlite";

import { Digest } from "@effectory/runtime/extension-protocol";
import { RunStatus, WaitKind, WaitStatus } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import { inspectionBudget } from "./inspection-budget.ts";
import { inspectReclaimExtensions } from "./revision-reclaim-extensions.ts";
import { revisionReclaimError } from "./revision-reclaim-record.ts";
import { inspectReclaimReports } from "./revision-reclaim-reports.ts";
import { reclaimDecode } from "./revision-reclaim-scan.ts";
import type { ProtectRevision } from "./revision-reclaim-scan.ts";
import { inspectUpgradeMaintenance } from "./upgrade-maintenance.ts";
import { inspectUpgradeOutbox } from "./upgrade-outbox.ts";
import { inspectUpgradeRecovery } from "./upgrade-recovery.ts";
import { unsupportedUpgradeWork, upgradeScanner } from "./upgrade-scan.ts";

const Count = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })
);
const Positive = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 })
);
const Text = Schema.NonEmptyString;
const Header = { owner: Text, position: Positive, runId: Text };
const RunRow = Schema.Struct({
  kind: Schema.Literals(["task", "workflow"]),
  position: Positive,
  principal: Text,
  revision: Digest,
  runId: Text,
  status: RunStatus,
});
const ScheduleRow = Schema.Struct({
  activeRunId: Schema.NullOr(Text),
  owner: Schema.NullOr(Text),
  pendingSlot: Schema.NullOr(Schema.Finite),
  position: Positive,
  removed: Schema.Literals([0, 1]),
  revision: Digest,
  scheduleId: Text,
});

/** Only call on the lease-owned private inspection copy, never a live store. */
export function inspectReclaimDependencies(
  database: Database,
  retained: readonly string[],
  active: string | null,
  budget = inspectionBudget("Revision dependency inspection")
) {
  return Effect.gen(function* () {
    const scanner = upgradeScanner(database, budget);
    const protections = new Map<
      string,
      {
        count: number;
        reasons: Map<
          Parameters<ProtectRevision>[1],
          { count: number; examples: string[] }
        >;
      }
    >();
    const inventory = new Set(retained);
    const protect: ProtectRevision = (revision, kind, id) => {
      if (!Schema.is(Digest)(revision) || !inventory.has(revision)) {
        throw unsupportedUpgradeWork(
          "revision dependency without a retained bundle"
        );
      }
      const group = protections.get(revision) ?? {
        count: 0,
        reasons: new Map(),
      };
      const reason = group.reasons.get(kind) ?? { count: 0, examples: [] };
      if (group.count < 20) {
        reason.examples.push(id);
      }
      reason.count += 1;
      group.count += 1;
      group.reasons.set(kind, reason);
      protections.set(revision, group);
    };
    const tables = yield* Effect.try({
      catch: () => unsupportedUpgradeWork("revision dependency tables"),
      try: () => {
        const names = [
          "host_runs",
          "host_invocations",
          "host_attempts",
          "host_attempt_windows",
          "host_waits",
          "host_fences",
          "host_workflow_invocations",
          "host_schedules",
          "host_scheduler",
          "host_reports",
          "host_report_groups",
          "host_report_sources",
          "host_report_plans",
          "host_report_cancellations",
          "extension_operations",
          "extension_activation",
        ];
        const statement = database.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
        );
        try {
          return new Set(names.filter((name) => statement.get(name) !== null));
        } finally {
          statement.finalize();
        }
      },
    });
    if (
      ![
        "host_runs",
        "host_invocations",
        "host_attempts",
        "host_waits",
        "host_fences",
        "host_workflow_invocations",
      ].every((name) => tables.has(name))
    ) {
      return yield* unsupportedUpgradeWork(
        "incomplete retained execution inventory"
      );
    }
    yield* Effect.try({
      catch: () => unsupportedUpgradeWork("active revision dependency"),
      try: () => {
        budget.visit("active revision", active);
        if (active !== null) {
          protect(active, "Active", "active.json");
        }
      },
    });
    // An accepted family deletion may intentionally have removed only part of
    // its rows. Route the operator to that recovery before validating owners.
    const maintenance = yield* inspectUpgradeMaintenance(database, budget);
    if (maintenance.counts.retirement > 0) {
      return yield* revisionReclaimError(
        "Conflict",
        "Run-family deletion is pending; resume that operation before revision reclamation"
      );
    }
    yield* scanner.scan(
      "retained runs",
      `SELECT rowid position,runId,revision,status,kind,principal FROM host_runs WHERE /* after */ ORDER BY rowid LIMIT ?`,
      (raw) => {
        const row = reclaimDecode(RunRow, raw);
        protect(row.revision, "Run", row.runId);
      }
    );
    const scanOwned = <S extends Schema.Codec<unknown, unknown, never, never>>(
      table: string,
      sql: string,
      schema: S
    ) =>
      tables.has(table)
        ? scanner.scan(
            table,
            sql,
            (raw) => {
              reclaimDecode(schema, raw);
            },
            "d.rowid"
          )
        : Effect.void;
    yield* scanOwned(
      "host_invocations",
      `SELECT d.rowid position,d.runId,r.runId owner,d.nodeId,d.engineId FROM host_invocations d LEFT JOIN host_runs r ON r.runId=d.runId WHERE /* after */ ORDER BY d.rowid LIMIT ?`,
      Schema.Struct({ ...Header, engineId: Text, nodeId: Text })
    );
    yield* scanOwned(
      "host_attempts",
      `SELECT d.rowid position,d.runId,r.runId owner,i.nodeId invocation,d.nodeId,d.activityAttempt,d.entries,d.startedAt FROM host_attempts d LEFT JOIN host_runs r ON r.runId=d.runId LEFT JOIN host_invocations i ON i.runId=d.runId AND i.nodeId=d.nodeId WHERE /* after */ ORDER BY d.rowid LIMIT ?`,
      Schema.Struct({
        ...Header,
        activityAttempt: Positive,
        entries: Positive,
        invocation: Text,
        nodeId: Text,
        startedAt: Schema.Finite,
      })
    );
    yield* scanOwned(
      "host_attempt_windows",
      `SELECT d.rowid position,d.runId,r.runId owner,i.nodeId invocation,a.activityAttempt attempt,d.nodeId,d.windowStartedAt,d.lastEnteredAt,d.timeout,d.deadline,d.taskVersion FROM host_attempt_windows d LEFT JOIN host_runs r ON r.runId=d.runId LEFT JOIN host_invocations i ON i.runId=d.runId AND i.nodeId=d.nodeId LEFT JOIN host_attempts a ON a.runId=d.runId AND a.nodeId=d.nodeId AND a.activityAttempt=d.attempt WHERE /* after */ ORDER BY d.rowid LIMIT ?`,
      Schema.Struct({
        ...Header,
        attempt: Positive,
        deadline: Schema.NullOr(Schema.Finite),
        invocation: Text,
        lastEnteredAt: Schema.Finite,
        nodeId: Text,
        taskVersion: Positive,
        timeout: Schema.NullOr(Schema.Finite),
        windowStartedAt: Schema.Finite,
      })
    );
    yield* scanOwned(
      "host_waits",
      `SELECT d.rowid position,d.runId,r.runId owner,d.waitId,d.nodeId,d.kind,d.status,d.deadline FROM host_waits d LEFT JOIN host_runs r ON r.runId=d.runId WHERE /* after */ ORDER BY d.rowid LIMIT ?`,
      Schema.Struct({
        ...Header,
        deadline: Schema.Finite,
        kind: WaitKind,
        nodeId: Text,
        status: WaitStatus,
        waitId: Text,
      })
    );
    yield* scanOwned(
      "host_fences",
      `SELECT d.rowid position,d.runId,r.runId owner,d.requestedAt FROM host_fences d LEFT JOIN host_runs r ON r.runId=d.runId WHERE /* after */ ORDER BY d.rowid LIMIT ?`,
      Schema.Struct({ ...Header, requestedAt: Schema.Finite })
    );
    yield* scanOwned(
      "host_workflow_invocations",
      `SELECT d.rowid position,d.runId,r.runId owner,d.invocationId,d.targetId,d.entered FROM host_workflow_invocations d LEFT JOIN host_runs r ON r.runId=d.runId WHERE /* after */ ORDER BY d.rowid LIMIT ?`,
      Schema.Struct({
        ...Header,
        entered: Schema.Literals([0, 1]),
        invocationId: Text,
        targetId: Text,
      })
    );
    yield* inspectReclaimReports(scanner, tables);
    if (tables.has("host_schedules") !== tables.has("host_scheduler")) {
      return yield* unsupportedUpgradeWork("partial scheduler inventory");
    }
    if (tables.has("host_schedules")) {
      yield* scanner.scan(
        "schedule dependencies",
        `SELECT s.identity position,s.scheduleId,s.revision,s.removed,s.pendingSlot,s.activeRunId,r.runId owner FROM host_schedules s LEFT JOIN host_runs r ON r.runId=s.activeRunId WHERE /* after */ ORDER BY s.identity LIMIT ?`,
        (raw) => {
          const row = reclaimDecode(ScheduleRow, raw);
          if (row.activeRunId !== null && row.owner !== row.activeRunId) {
            throw unsupportedUpgradeWork("schedule active run ownership");
          }
          if (row.removed === 0 || row.pendingSlot !== null) {
            protect(row.revision, "Schedule", row.scheduleId);
          }
        }
      );
      let schedulerCount = 0;
      yield* scanner.scan(
        "scheduler dependency",
        `SELECT singleton position,generation,revision FROM host_scheduler WHERE /* after */ ORDER BY singleton LIMIT ?`,
        (raw) => {
          const row = reclaimDecode(
            Schema.Struct({
              generation: Count,
              position: Schema.Literal(1),
              revision: Schema.NullOr(Digest),
            }),
            raw
          );
          schedulerCount += 1;
          if (row.revision !== null) {
            protect(row.revision, "Scheduler", "host_scheduler");
          }
        }
      );
      if (schedulerCount !== 1) {
        return yield* unsupportedUpgradeWork("missing scheduler singleton");
      }
    }
    yield* inspectUpgradeRecovery(database, budget);
    yield* inspectUpgradeOutbox(database, budget);
    yield* inspectReclaimExtensions(scanner, tables, active, protect);
    return {
      ...budget.snapshot,
      protected: [...protections]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([revision, group]) => ({
          examplesTruncated: group.count > 20,
          reasons: [...group.reasons].map(([kind, reason]) => ({
            kind,
            ...reason,
          })),
          revision,
        })),
    };
  });
}
