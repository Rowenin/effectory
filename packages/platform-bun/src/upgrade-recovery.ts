import type { Database } from "bun:sqlite";

import { OperationError } from "@effectory/runtime/protocol";
import { RecoveryReceipt } from "@effectory/runtime/recovery-protocol";
import { Cause, Effect, Exit, Schema } from "effect";

import type { InspectionBudget } from "./inspection-budget.ts";
import { unsupportedUpgradeWork, upgradeScanner } from "./upgrade-scan.ts";

const Positive = Schema.Int.check(Schema.isGreaterThan(0));
const Owner = Schema.Struct({
  attempt: Positive,
  invocation: Schema.String,
  nodeId: Schema.String,
  owner: Schema.String,
  position: Schema.Int,
  runId: Schema.String,
});
const Hold = Schema.Struct({
  ...Owner.fields,
  authorizationId: Schema.NullOr(Schema.String),
  authorizedRun: Schema.NullOr(Schema.String),
  entries: Positive,
  entry: Positive,
  state: Schema.Literals(["Open", "Consumed", "Superseded"]),
});
const Generation = Schema.Struct({
  acceptedSeq: Positive,
  actor: Schema.String,
  id: Schema.String,
  owner: Schema.String,
  position: Schema.Int,
  receiptJson: Schema.String,
  requestKey: Schema.String,
  runId: Schema.String,
});
const Obligation = Schema.Struct({
  ...Owner.fields,
  acceptedSeq: Positive,
  closed: Schema.Literals([0, 1]),
  gateAttempt: Schema.NullOr(Positive),
  gateNode: Schema.NullOr(Schema.String),
  gateRun: Schema.NullOr(Schema.String),
  gateSeq: Positive,
  generationRun: Schema.String,
});
const tables = [
  "host_recovery_clock",
  "host_recovery_holds",
  "host_recovery_gates",
  "host_recovery_generations",
  "host_recovery_gate_obligations",
  "host_attempt_windows",
];

/** Does not construct createRecoveryStore, migrate tables, or consume authorization. */
export function inspectUpgradeRecovery(
  database: Database,
  budget?: InspectionBudget
) {
  return Effect.gen(function* () {
    const clock = yield* Effect.try({
      catch: (cause) =>
        cause instanceof OperationError
          ? cause
          : unsupportedUpgradeWork("manual recovery storage"),
      try: () => {
        const present = tables.filter(
          (name) =>
            database
              .query(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
              )
              .get(name) !== null
        );
        if (present.length === 0) {
          return null;
        }
        if (present.length !== tables.length) {
          throw unsupportedUpgradeWork("partial manual recovery storage");
        }
        const decoded = Schema.decodeUnknownExit(
          Schema.Array(
            Schema.Struct({
              sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
              singleton: Schema.Literal(1),
            })
          )
        )(database.query("SELECT * FROM host_recovery_clock LIMIT 2").all(), {
          onExcessProperty: "error",
        });
        if (Exit.isFailure(decoded)) {
          throw Cause.squash(decoded.cause);
        }
        const rows = decoded.value;
        if (
          rows.length !== 1 ||
          !rows[0] ||
          !Number.isSafeInteger(rows[0].sequence)
        ) {
          throw unsupportedUpgradeWork("manual recovery sequence");
        }
        budget?.visit("manual recovery clock", rows[0]);
        return rows[0].sequence;
      },
    });
    const scanner = upgradeScanner(database, budget);
    const counts = { authorizations: 0, continuations: 0, gates: 0, holds: 0 };
    if (clock === null) {
      return { ...scanner.totals, counts };
    }
    yield* scanner.scan(
      "manual recovery authorizations",
      `
      SELECT g.rowid position,g.id,g.runId,g.actor,g.requestKey,g.acceptedSeq,g.receiptJson,r.runId owner
      FROM host_recovery_generations g LEFT JOIN host_runs r ON r.runId=g.runId
      WHERE /* after */ ORDER BY g.rowid LIMIT ?`,
      (raw) => {
        const row = Schema.decodeUnknownSync(Generation)(raw, {
          onExcessProperty: "error",
        });
        const receipt = Schema.decodeUnknownSync(RecoveryReceipt)(
          JSON.parse(row.receiptJson),
          { onExcessProperty: "error" }
        );
        if (
          row.acceptedSeq > clock ||
          receipt.authorizationId !== row.id ||
          receipt.runId !== row.runId ||
          receipt.actor !== row.actor ||
          receipt.requestKey !== row.requestKey
        ) {
          throw unsupportedUpgradeWork("manual recovery authorization receipt");
        }
      }
    );
    yield* scanner.scan(
      "manual recovery holds",
      `
      SELECT h.id position,h.runId,h.nodeId,h.attempt,h.entry,h.authorizationId,h.state,
        r.runId owner,i.nodeId invocation,a.entries,g.runId authorizedRun
      FROM host_recovery_holds h LEFT JOIN host_runs r ON r.runId=h.runId
      LEFT JOIN host_invocations i ON i.runId=h.runId AND i.nodeId=h.nodeId
      LEFT JOIN host_attempts a ON a.runId=h.runId AND a.nodeId=h.nodeId AND a.activityAttempt=h.attempt
      LEFT JOIN host_recovery_generations g ON g.id=h.authorizationId
      WHERE /* after */ ORDER BY h.id LIMIT ?`,
      (raw) => {
        const row = Schema.decodeUnknownSync(Hold)(raw, {
          onExcessProperty: "error",
        });
        if (
          row.position > clock ||
          row.entry > row.entries ||
          (row.authorizationId !== null && row.authorizedRun !== row.runId) ||
          (row.state === "Consumed" &&
            (row.authorizationId === null || row.entries <= row.entry)) ||
          (row.state === "Open" && row.entries !== row.entry)
        ) {
          throw unsupportedUpgradeWork("manual recovery hold ownership");
        }
        if (row.state === "Open") {
          if (row.authorizationId === null) {
            counts.holds += 1;
          } else {
            counts.authorizations += 1;
          }
        }
      }
    );
    yield* scanner.scan(
      "manual recovery gates",
      `
      SELECT g.sequence position,g.runId,g.nodeId,g.attempt,r.runId owner,i.nodeId invocation
      FROM host_recovery_gates g LEFT JOIN host_runs r ON r.runId=g.runId
      LEFT JOIN host_invocations i ON i.runId=g.runId AND i.nodeId=g.nodeId
      WHERE /* after */ ORDER BY g.sequence LIMIT ?`,
      (raw) => {
        const row = Schema.decodeUnknownSync(Owner)(raw, {
          onExcessProperty: "error",
        });
        if (row.position < 1 || row.position > clock) {
          throw unsupportedUpgradeWork("manual recovery gate sequence");
        }
        counts.gates += 1;
      }
    );
    yield* scanner.scan(
      "manual recovery continuations",
      `
      SELECT o.rowid position,o.runId,o.nodeId,o.attempt,o.gateSeq,o.closed,
        r.runId owner,i.nodeId invocation,g.runId generationRun,g.acceptedSeq,
        gate.runId gateRun,gate.nodeId gateNode,gate.attempt gateAttempt
      FROM host_recovery_gate_obligations o LEFT JOIN host_runs r ON r.runId=o.runId
      LEFT JOIN host_invocations i ON i.runId=o.runId AND i.nodeId=o.nodeId
      LEFT JOIN host_recovery_generations g ON g.id=o.generation
      LEFT JOIN host_recovery_gates gate ON gate.sequence=o.gateSeq
      WHERE /* after */ ORDER BY o.rowid LIMIT ?`,
      (raw) => {
        const row = Schema.decodeUnknownSync(Obligation)(raw, {
          onExcessProperty: "error",
        });
        if (
          row.generationRun !== row.runId ||
          row.gateSeq >= row.acceptedSeq ||
          row.acceptedSeq > clock ||
          (row.closed === 0 &&
            (row.gateRun !== row.runId ||
              row.gateNode !== row.nodeId ||
              row.gateAttempt !== row.attempt))
        ) {
          throw unsupportedUpgradeWork(
            "manual recovery continuation ownership"
          );
        }
        if (row.closed === 0) {
          counts.continuations += 1;
        }
      }
    );
    return { ...scanner.totals, counts };
  });
}
