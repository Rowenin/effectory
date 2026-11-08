/* oxlint-disable no-redeclare -- Effect schemas share value and type names. */
import { Schema } from "effect";

export const Severity = Schema.Literals(["low", "medium", "high"]);
export type Severity = typeof Severity.Type;
export const CheckOptions = Schema.Struct({
  failOn: Schema.optionalKey(Severity),
});
export const CheckSettings = Schema.Struct({ failOn: Severity });
export const CheckStatus = Schema.Literals([
  "Running",
  "Passed",
  "Failed",
  "Error",
  "Incomplete",
]);
export const CheckRecord = Schema.Struct({
  attempt: Schema.Int,
  durationMillis: Schema.NullOr(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  entry: Schema.Int,
  finishedAt: Schema.NullOr(Schema.String),
  id: Schema.String,
  message: Schema.String,
  nodeId: Schema.String,
  runId: Schema.String,
  sequence: Schema.Int,
  severity: Severity,
  startedAt: Schema.String,
  status: CheckStatus,
  taskId: Schema.String,
});
export type CheckRecord = typeof CheckRecord.Type;
export const checkLimits = {
  entry: 1000,
  recordBytes: 8192,
  rows: 10_000,
  runBytes: 16_777_216,
} as const;
export function checkSettings(value: unknown): typeof CheckSettings.Type {
  const decoded = Schema.decodeUnknownSync(CheckOptions)(value, {
    onExcessProperty: "error",
  });
  return Object.freeze({ failOn: decoded.failOn ?? "low" });
}
export function checkReservation(record: CheckRecord): number {
  return (
    new TextEncoder().encode(
      JSON.stringify({
        ...record,
        durationMillis: Number.MAX_SAFE_INTEGER,
        finishedAt: "+275760-09-13T00:00:00.000Z",
        message: record.message.length < 64 ? "x".repeat(64) : record.message,
        sequence: Number.MAX_SAFE_INTEGER,
        status: "Incomplete",
      })
    ).byteLength + 128
  );
}
