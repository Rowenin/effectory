import { Schema } from "effect";

import {
  Event,
  RunStatus,
  WaitKind,
  WaitStatus,
  ScheduleProvenance,
} from "./protocol.ts";

export const Id = Schema.NonEmptyString.check(Schema.isMaxLength(200));
export const PageLimit = Schema.Int.check(
  Schema.isBetween({ maximum: 200, minimum: 1 })
);
export const Cursor = Schema.String.check(Schema.isMaxLength(4096));
export const RunListRequest = Schema.Struct({
  createdAfter: Schema.optionalKey(Id),
  createdBefore: Schema.optionalKey(Id),
  cursor: Schema.optionalKey(Cursor),
  kind: Schema.optionalKey(Schema.Literals(["task", "workflow"])),
  limit: Schema.optionalKey(PageLimit),
  status: Schema.optionalKey(RunStatus),
  targetId: Schema.optionalKey(Id),
});
export const RunSummary = Schema.Struct({
  acceptedAt: Schema.String,
  kind: Schema.Literals(["task", "workflow"]),
  lastSequence: Schema.Int,
  revision: Id,
  runId: Id,
  schedule: Schema.optionalKey(ScheduleProvenance),
  status: RunStatus,
  targetId: Id,
});
export const RunPage = Schema.Struct({
  cursor: Schema.NullOr(Cursor),
  items: Schema.Array(RunSummary).check(Schema.isMaxLength(200)),
  snapshot: Schema.Int,
});
export const DefinitionListRequest = Schema.Struct({
  cursor: Schema.optionalKey(Cursor),
  limit: Schema.optionalKey(PageLimit),
  namespace: Schema.optionalKey(Id),
  revision: Schema.optionalKey(Id),
  search: Schema.optionalKey(Id),
});
export const DefinitionSummary = Schema.Struct({
  id: Id,
  kind: Schema.Literals(["task", "workflow"]),
  version: Schema.Int,
});
export const DefinitionPage = Schema.Struct({
  cursor: Schema.NullOr(Cursor),
  items: Schema.Array(DefinitionSummary).check(Schema.isMaxLength(200)),
  revision: Id,
});

export const RunWatchRequest = Schema.Struct({
  afterSequence: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  runId: Id,
});
export const RunWatchFrame = Schema.Union([
  Schema.TaggedStruct("Snapshot", { run: RunSummary }),
  Schema.TaggedStruct("Event", { event: Event }),
  Schema.TaggedStruct("Heartbeat", {
    at: Schema.String,
    lastSequence: Schema.Int,
    runId: Id,
  }),
]);

export const EventListRequest = Schema.Struct({
  afterSequence: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  cursor: Schema.optionalKey(Cursor),
  limit: Schema.optionalKey(PageLimit),
  runId: Id,
});
export const EventPage = Schema.Struct({
  cursor: Schema.NullOr(Cursor),
  items: Schema.Array(Event).check(Schema.isMaxLength(200)),
  snapshot: Schema.Int,
});
export const WaitListRequest = Schema.Struct({
  cursor: Schema.optionalKey(Cursor),
  kind: Schema.optionalKey(WaitKind),
  limit: Schema.optionalKey(PageLimit),
  runId: Schema.optionalKey(Id),
  status: Schema.optionalKey(Schema.Union([WaitStatus, Schema.Literal("all")])),
});
export const WaitSummary = Schema.Struct({
  deadline: Schema.Finite,
  kind: WaitKind,
  nodeId: Schema.String,
  openedAt: Schema.String,
  prompt: Schema.NullOr(Schema.String),
  runId: Id,
  status: WaitStatus,
  waitId: Id,
});
export const WaitPage = Schema.Struct({
  cursor: Schema.NullOr(Cursor),
  items: Schema.Array(WaitSummary).check(Schema.isMaxLength(200)),
  snapshot: Schema.Int,
});

export const LogLevel = Schema.Literals([
  "All",
  "Fatal",
  "Error",
  "Warn",
  "Info",
  "Debug",
  "Trace",
  "None",
]);
export const LogListRequest = Schema.Struct({
  cursor: Schema.optionalKey(Cursor),
  level: Schema.optionalKey(LogLevel),
  limit: Schema.optionalKey(PageLimit),
  nodeId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
  runId: Id,
});
export const LogPayload = Schema.Struct({
  attempt: Schema.Int,
  error: Schema.NullOr(Schema.Json),
  level: LogLevel,
  message: Schema.Json,
  nodeId: Schema.String,
});
export const LogEntry = Schema.Struct({
  ...LogPayload.fields,
  at: Schema.String,
  runId: Id,
  sequence: Schema.Int,
});
export const LogPage = Schema.Struct({
  cursor: Schema.NullOr(Cursor),
  items: Schema.Array(LogEntry).check(Schema.isMaxLength(200)),
  snapshot: Schema.Int,
});

export const OutputListRequest = Schema.Struct({
  cursor: Schema.optionalKey(Cursor),
  limit: Schema.optionalKey(PageLimit),
  nodeId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
  runId: Id,
});
export const RunOutput = Schema.Struct({
  error: Schema.NullOr(Schema.Json),
  nodeId: Schema.String,
  result: Schema.NullOr(Schema.Json),
  status: Schema.Literals([
    "Pending",
    "Suspended",
    "Succeeded",
    "Failed",
    "Rejected",
    "TimedOut",
    "Cancelled",
  ]),
  taskId: Id,
});
export const OutputPage = Schema.Struct({
  cursor: Schema.NullOr(Cursor),
  items: Schema.Array(RunOutput).check(Schema.isMaxLength(200)),
  snapshot: Schema.Int,
});
