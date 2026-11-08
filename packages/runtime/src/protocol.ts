import { CheckSettings } from "@offtree/effectory-sdk/internal/check-schema";
import { Provenance } from "@offtree/effectory-sdk/internal/report-record";
import { SelectionDecision } from "@offtree/effectory-sdk/internal/report-selection-schema";
/* oxlint-disable no-redeclare */
// Schemas share their names with their decoded types in TypeScript's separate namespaces.
import { Occurrence } from "@offtree/effectory-sdk/internal/schedule-occurrence";
import { RunTags } from "@offtree/effectory-sdk/RunTags";
import { Effect, Schema } from "effect";

export const RunStatus = Schema.Literals([
  "Queued",
  "Running",
  "Waiting",
  "Retrying",
  "Cancelling",
  "NeedsAttention",
  "Succeeded",
  "Failed",
  "Rejected",
  "TimedOut",
  "Cancelled",
]);
export type RunStatus = typeof RunStatus.Type;
export const terminal = new Set<RunStatus>([
  "Succeeded",
  "Failed",
  "Rejected",
  "TimedOut",
  "Cancelled",
]);

export const ScheduleProvenance = Occurrence;
export const ReportProvenance = Provenance;

export const Run = Schema.Struct({
  acceptedAt: Schema.String,
  checks: Schema.optionalKey(CheckSettings),
  engineId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.Json),
  input: Schema.Json,
  kind: Schema.Literals(["task", "workflow"]),
  lastSequence: Schema.Int,
  report: Schema.optionalKey(ReportProvenance),
  reportSelection: Schema.optionalKey(SelectionDecision),
  requestKey: Schema.String,
  result: Schema.NullOr(Schema.Json),
  revision: Schema.String,
  runId: Schema.String,
  schedule: Schema.optionalKey(ScheduleProvenance),
  status: RunStatus,
  tags: RunTags.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => ({})))),
  targetId: Schema.String,
});
export type Run = typeof Run.Type;

export const WaitKind = Schema.Literals(["approval", "input", "signal"]);
export const WaitStatus = Schema.Literals([
  "Open",
  "Approved",
  "Rejected",
  "Responded",
  "Signaled",
  "TimedOut",
  "Cancelled",
]);
export const Wait = Schema.Struct({
  context: Schema.Json,
  deadline: Schema.Finite,
  kind: WaitKind,
  nodeId: Schema.String,
  openedAt: Schema.String,
  payload: Schema.NullOr(Schema.Json),
  prompt: Schema.NullOr(Schema.String),
  runId: Schema.String,
  schema: Schema.NullOr(Schema.Json),
  status: WaitStatus,
  waitId: Schema.String,
});
export type Wait = typeof Wait.Type;

export const WaitOperation = Schema.Literals([
  "approve",
  "reject",
  "respond",
  "signal",
]);
export type WaitOperation = typeof WaitOperation.Type;
export const WaitReceipt = Schema.Struct({
  actor: Schema.String,
  continuation: Schema.Literal("Queued"),
  outcome: WaitStatus,
  requestKey: Schema.String,
  runId: Schema.String,
  settledAt: Schema.String,
  waitId: Schema.String,
});
export type WaitReceipt = typeof WaitReceipt.Type;

export const Event = Schema.Struct({
  at: Schema.String,
  payload: Schema.Json,
  runId: Schema.String,
  sequence: Schema.Int,
  tag: Schema.String,
});
export type Event = typeof Event.Type;

export const Outbox = Schema.Struct({
  id: Schema.Int,
  kind: Schema.Literals(["Dispatch", "Settle", "Cancel"]),
  runId: Schema.String,
  waitId: Schema.NullOr(Schema.String),
});
export type Outbox = typeof Outbox.Type;

/* oxlint-disable unicorn/throw-new-error */
export class OperationError extends Schema.TaggedError<
  OperationError,
  { readonly brand: unique symbol }
>()("OperationError", {
  code: Schema.Literals([
    "InvalidInput",
    "NotFound",
    "Unauthorized",
    "Conflict",
    "RevisionUnavailable",
    "Unavailable",
    "CursorExpired",
    "WrongWaitKind",
    "WaitClosed",
    "LimitExceeded",
    "QueryBudgetExceeded",
    "ContentUnavailable",
    "StorageFull",
  ]),
  message: Schema.String,
}) {}

export const CancellationRequest = Schema.Struct({
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
  requestKey: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  runId: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
});
export const CancellationReceipt = Schema.Struct({
  acceptedAt: Schema.String,
  actor: Schema.String,
  reason: Schema.NullOr(Schema.String),
  requestKey: Schema.String,
  runId: Schema.String,
  status: RunStatus,
});
