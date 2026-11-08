import { PathPreview } from "@offtree/effectory-sdk/internal/report-history";
import {
  Execution,
  RecordStatus,
  SourceIdentity,
} from "@offtree/effectory-sdk/internal/report-record";
import { RunTags } from "@offtree/effectory-sdk/RunTags";
import { Schema } from "effect";

import { Cursor, Id, PageLimit, RunOutput } from "./history-protocol.ts";
import { RunStatus } from "./protocol.ts";

export const ReportRecord = Schema.Struct({
  attachmentId: Id,
  createdAt: Schema.String,
  error: Schema.NullOr(Schema.Json),
  execution: Execution,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  groupId: Id,
  notApplicableReason: Schema.NullOr(
    Schema.Literals(["NotStarted", "NoNativeExecution", "OutcomeExcluded"])
  ),
  pathPreview: Schema.NullOr(PathPreview),
  reportId: Id,
  reportProviderId: Schema.NullOr(Id),
  reportRunId: Schema.NullOr(Id),
  reportRunStatus: Schema.NullOr(RunStatus),
  reportTaskId: Id,
  reportTaskVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  settledAt: Schema.NullOr(Schema.String),
  source: SourceIdentity,
  status: RecordStatus,
});
export const ReportSearchRequest = Schema.Struct({
  attachmentId: Schema.optionalKey(Id),
  createdAfter: Schema.optionalKey(Id),
  createdBefore: Schema.optionalKey(Id),
  cursor: Schema.optionalKey(Cursor),
  history: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PageLimit),
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  reporterId: Schema.optionalKey(Id),
  runId: Schema.optionalKey(Id),
  scope: Schema.optionalKey(Schema.Literals(["run", "invocation"])),
  sourceWorkflowId: Schema.optionalKey(Id),
  statuses: Schema.optionalKey(
    Schema.Array(RecordStatus).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8)
    )
  ),
  tags: Schema.optionalKey(RunTags),
  taskId: Schema.optionalKey(Id),
  workflowId: Schema.optionalKey(Id),
});
const {
  error: _error,
  execution: _execution,
  ...searchFields
} = ReportRecord.fields;
export const ReportSearchItem = Schema.Struct({
  ...searchFields,
  root: Schema.Struct({
    acceptedAt: Schema.String,
    kind: Schema.Literals(["task", "workflow"]),
    tags: RunTags,
    targetId: Id,
  }),
});
export const ReportSearchPage = Schema.Struct({
  cursor: Schema.NullOr(Cursor),
  items: Schema.Array(ReportSearchItem).check(Schema.isMaxLength(200)),
  scanLimited: Schema.Boolean,
  snapshot: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const ReportRetryRequest = Schema.Struct({
  reportId: Id,
  requestKey: Id,
});
export const ReportCancelSingleRequest = Schema.Struct({
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
  reportId: Id,
  requestKey: Id,
});
export const ReportCancelReceipt = Schema.Struct({
  acceptedAt: Schema.String,
  actor: Schema.String,
  reason: Schema.NullOr(Schema.String),
  replayed: Schema.Boolean,
  reportId: Id,
  reportRunId: Schema.NullOr(Id),
  requestKey: Id,
  status: RecordStatus,
});

export const ReportCancelSourceRequest = Schema.Struct({
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
  requestKey: Id,
  sourceRunId: Id,
});
export const ReportCancelSourceReceipt = Schema.Struct({
  acceptedAt: Schema.String,
  actor: Schema.String,
  reason: Schema.NullOr(Schema.String),
  replayed: Schema.Boolean,
  requestKey: Id,
  sourceRunId: Id,
});

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ReportAggregate = Schema.Struct({
  Cancelled: Count,
  Failed: Count,
  NeedsAttention: Count,
  NotApplicable: Count,
  Queued: Count,
  Running: Count,
  Succeeded: Count,
  WaitingSource: Count,
  observedAt: Schema.String,
  sourceTerminal: Schema.Boolean,
  total: Count,
});
export const RunReportsRequest = Schema.Struct({
  cursor: Schema.optionalKey(Cursor),
  history: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PageLimit),
  runId: Id,
});
export const RunReportsPage = Schema.Struct({
  aggregate: ReportAggregate,
  cursor: Schema.NullOr(Cursor),
  items: Schema.Array(ReportRecord).check(Schema.isMaxLength(200)),
  snapshot: Count,
});
export const ReportGetReply = Schema.Struct({
  content: Schema.NullOr(
    Schema.Struct({ data: Schema.Json, markdown: Schema.String })
  ),
  record: ReportRecord,
});
export const ReportRetryReply = Schema.Struct({
  record: ReportRecord,
  replayed: Schema.Boolean,
});
export const ReportCancelRequest = Schema.Union([
  ReportCancelSingleRequest,
  ReportCancelSourceRequest,
]);
export const ReportCancellationReceipt = Schema.Union([
  ReportCancelReceipt,
  ReportCancelSourceReceipt,
]);

export const RunSummarizeReply = Schema.Struct({
  data: Schema.Struct({
    failures: Schema.Array(
      Schema.Struct({
        invocationId: Id,
        pathPreview: PathPreview,
        status: RunOutput.fields.status,
        taskId: Id,
      })
    ).check(Schema.isMaxLength(20)),
    invocations: Schema.Struct({
      Cancelled: Count,
      Failed: Count,
      Pending: Count,
      Rejected: Count,
      Succeeded: Count,
      Suspended: Count,
      TimedOut: Count,
      total: Count,
    }),
    observedAt: Schema.String,
    reports: ReportAggregate,
    runId: Id,
    sampleTruncated: Schema.Boolean,
    status: RunStatus,
  }),
  markdown: Schema.String,
});

export const ReportSystemStatus = Schema.Struct({
  counts: Schema.Struct({
    Cancelled: Count,
    Failed: Count,
    NeedsAttention: Count,
    NotApplicable: Count,
    Queued: Count,
    Running: Count,
    Succeeded: Count,
    WaitingSource: Count,
    total: Count,
  }),
  lowerBound: Schema.Boolean,
});
