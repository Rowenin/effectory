import { Schema } from "effect";

import { Cursor, Id, PageLimit } from "./history-protocol.ts";
import { RunStatus, ScheduleProvenance } from "./protocol.ts";

export const ScheduleState = Schema.Literals([
  "Active",
  "Blocked",
  "Paused",
  "Removed",
]);
export const ScheduleError = Schema.Struct({
  at: Schema.String,
  code: Schema.String,
  message: Schema.String,
});
export const MissedRange = Schema.Struct({
  count: Schema.Int,
  fromSlot: Schema.String,
  generation: Schema.Int,
  reason: Schema.Literals([
    "Overlap",
    "Paused",
    "Downtime",
    "Late",
    "AdmissionFailed",
  ]),
  saturated: Schema.Boolean,
  scheduleId: Id,
  toSlot: Schema.String,
});
export const ScheduleSummary = Schema.Struct({
  blockedBy: Schema.NullOr(Schema.Struct({ runId: Id, status: RunStatus })),
  cron: Schema.String,
  generation: Schema.Int,
  lastError: Schema.NullOr(ScheduleError),
  lastMissed: Schema.NullOr(MissedRange),
  lastRun: Schema.NullOr(
    Schema.Struct({ runId: Id, scheduledFor: Schema.String, status: RunStatus })
  ),
  nextScheduledAt: Schema.NullOr(Schema.String),
  scheduleId: Id,
  state: ScheduleState,
  timeZone: Schema.String,
  workflowId: Id,
});
export const ScheduleDescription = Schema.Struct({
  ...ScheduleSummary.fields,
  catchUp: Schema.Union([
    Schema.Literal("skip"),
    Schema.Struct({ latestWithin: Schema.String }),
  ]),
  description: Schema.NullOr(Schema.String),
  input: Schema.Json,
  pause: Schema.NullOr(
    Schema.Struct({
      actor: Id,
      at: Schema.String,
      reason: Schema.NullOr(Schema.String),
    })
  ),
  revision: Id,
});
export const ScheduleListRequest = Schema.Struct({
  cursor: Schema.optionalKey(Cursor),
  limit: Schema.optionalKey(PageLimit),
  state: Schema.optionalKey(ScheduleState),
  workflowId: Schema.optionalKey(Id),
});
export const ScheduleList = Schema.Struct({
  cursor: Schema.NullOr(Cursor),
  items: Schema.Array(ScheduleSummary).check(Schema.isMaxLength(200)),
  snapshot: Schema.Int,
});
export const ScheduleHistoryRequest = Schema.Struct({
  cursor: Schema.optionalKey(Cursor),
  limit: Schema.optionalKey(PageLimit),
  scheduleId: Id,
});
export const ScheduleHistoryEntry = Schema.Union([
  Schema.TaggedStruct("Missed", MissedRange.fields),
  Schema.TaggedStruct("Admitted", {
    ...ScheduleProvenance.fields,
    runId: Id,
    status: RunStatus,
  }),
]);
export const ScheduleHistory = Schema.Struct({
  cursor: Schema.NullOr(Cursor),
  items: Schema.Array(ScheduleHistoryEntry).check(Schema.isMaxLength(200)),
  snapshot: Schema.Int,
});
export const SchedulePauseRequest = Schema.Struct({
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
  requestKey: Id,
  scheduleId: Id,
});
export const ScheduleResumeRequest = Schema.Struct({
  requestKey: Id,
  scheduleId: Id,
});
export const ScheduleReceipt = Schema.Struct({
  acceptedAt: Schema.String,
  actor: Id,
  changed: Schema.Boolean,
  generation: Schema.Int,
  operation: Schema.Literals(["Pause", "Resume"]),
  paused: Schema.Boolean,
  requestKey: Id,
  scheduleId: Id,
});
export const SchedulerStatus = Schema.Struct({
  activeSchedules: Schema.Int,
  blockedSchedules: Schema.Int,
  lastError: Schema.NullOr(ScheduleError),
  pausedSchedules: Schema.Int,
  revision: Schema.NullOr(Id),
  state: Schema.Literals(["Running", "Draining", "Stopped"]),
});
