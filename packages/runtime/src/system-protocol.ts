import { Schema } from "effect";

import { Id } from "./history-protocol.ts";

export const DrainRequest = Schema.Struct({
  gracePeriodMs: Schema.Int.check(
    Schema.isBetween({ maximum: 30_000, minimum: 0 })
  ),
  instanceId: Id,
  requestKey: Id,
});
export const DrainReceipt = Schema.Struct({
  deadline: Schema.Finite,
  instanceId: Id,
  requestKey: Id,
  status: Schema.Literal("Draining"),
});
export const DaemonState = Schema.Struct({
  drain: Schema.NullOr(DrainReceipt),
  instanceId: Id,
  startedAt: Schema.String,
});
export const DiagnosticFinding = Schema.Struct({
  code: Id,
  message: Schema.String,
  severity: Schema.Literals(["Info", "Warning", "Error"]),
});
export const DiagnosticReport = Schema.Struct({
  checkedAt: Schema.String,
  counts: Schema.Struct({
    activeRuns: Schema.Int,
    openWaitsLowerBound: Schema.Int,
    pendingDeliveriesLowerBound: Schema.Int,
    storageFailures: Schema.Int,
    telemetryWriteFailures: Schema.Int,
  }),
  findings: Schema.Array(DiagnosticFinding).check(Schema.isMaxLength(32)),
  healthy: Schema.Boolean,
  storage: Schema.Struct({
    availableBytes: Schema.Finite,
    freePages: Schema.Int,
    pageCount: Schema.Int,
    pageSize: Schema.Int,
  }),
});
