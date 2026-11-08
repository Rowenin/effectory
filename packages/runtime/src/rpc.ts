import { CheckOptions } from "@offtree/effectory-sdk/internal/check-schema";
import { EncodedSelection } from "@offtree/effectory-sdk/internal/report-selection-schema";
import { RunTags } from "@offtree/effectory-sdk/RunTags";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { CheckListRequest, CheckPage } from "./check-protocol.ts";
import {
  OperationListRequest,
  OperationPage,
  Digest,
  ExtensionId,
  ExportName,
  GitHubSource,
  ExtensionInventory,
  ExtensionOutdatedRequest,
  ExtensionUpdatePage,
  ExtensionOperation,
  ExtensionSummary,
  LockedPackage,
} from "./extension-protocol.ts";
import {
  LogListRequest,
  LogPage,
  OutputListRequest,
  OutputPage,
  EventListRequest,
  EventPage,
  WaitListRequest,
  WaitPage,
  DefinitionListRequest,
  DefinitionPage,
  RunListRequest,
  RunPage,
} from "./history-protocol.ts";
import {
  Content,
  Query,
  QueryPage,
  VersionListRequest,
  VersionPage,
  AutomaticReclamationSet,
  AutomaticReclamationStatus,
  ReclamationRequest,
  ReclamationPlan,
  ReclamationApply,
  ReclamationReceipt,
} from "./lake-protocol.ts";
import {
  OperationError,
  Run,
  Wait,
  WaitReceipt,
  CancellationRequest,
  CancellationReceipt,
} from "./protocol.ts";
import {
  RecoveryAssessment,
  RecoveryAssessmentRequest,
  RecoveryReceipt,
  RecoveryRequest,
} from "./recovery-protocol.ts";
import {
  ReportSearchRequest,
  ReportSearchPage,
  ReportSystemStatus,
  RunReportsRequest,
  RunReportsPage,
  ReportGetReply,
  ReportRetryRequest,
  ReportRetryReply,
  ReportCancelRequest,
  ReportCancellationReceipt,
  RunSummarizeReply,
} from "./report-protocol.ts";
import {
  ScheduleListRequest,
  ScheduleList,
  ScheduleDescription,
  ScheduleHistoryRequest,
  ScheduleHistory,
  SchedulePauseRequest,
  ScheduleResumeRequest,
  ScheduleReceipt,
  SchedulerStatus,
} from "./schedule-protocol.ts";
import {
  DrainReceipt,
  DrainRequest,
  DaemonState,
  DiagnosticReport,
} from "./system-protocol.ts";
import * as VaultProtocol from "./vault-protocol.ts";
import { RunWatch } from "./watch-rpc.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(200));
const Definition = { id: Id, revision: Schema.optionalKey(Id) };
const Input = { ...Definition, input: Schema.Json };
const Submit = {
  ...Input,
  checks: Schema.optionalKey(CheckOptions),
  reportSelection: Schema.optionalKey(EncodedSelection),
  requestKey: Id,
  tags: Schema.optionalKey(RunTags),
};
const Decision = { requestKey: Id, waitId: Id };
export const Hello = Schema.Struct({
  clientVersion: Id,
  protocolMajor: Schema.Literal(1),
  repositoryId: Id,
});
export const ServerHello = Schema.Struct({
  capabilities: Schema.Array(Id).check(Schema.isMaxLength(64)),
  installedRegistryRevision: Digest,
  instanceId: Id,
  limits: Schema.Record(Schema.String, Schema.Int),
  protocolMajor: Schema.Literal(1),
  repositoryId: Id,
  revision: Id,
  serverVersion: Id,
});
const Validation = Schema.Struct({
  issues: Schema.Array(Schema.String),
  revision: Id,
  valid: Schema.Boolean,
});

export const ServerStatus = Schema.Struct({
  ...ServerHello.fields,
  daemon: DaemonState,
  observers: Schema.Int,
  readiness: Schema.Literals(["Ready", "Draining"]),
  reports: Schema.optionalKey(ReportSystemStatus),
  scheduler: SchedulerStatus,
});
export const ControlPlane = RpcGroup.make(
  Rpc.make("VaultList", {
    error: OperationError,
    payload: VaultProtocol.VaultRevision,
    success: VaultProtocol.VaultList,
  }),
  Rpc.make("VaultDescribe", {
    error: OperationError,
    payload: VaultProtocol.VaultRequest,
    success: VaultProtocol.VaultDescription,
  }),
  Rpc.make("VaultInit", {
    error: OperationError,
    payload: VaultProtocol.VaultRequest,
    success: VaultProtocol.VaultInitReceipt,
  }),
  Rpc.make("VaultPut", {
    error: OperationError,
    payload: VaultProtocol.VaultPutRequest,
    success: VaultProtocol.VaultMutationReceipt,
  }),
  Rpc.make("VaultDelete", {
    error: OperationError,
    payload: VaultProtocol.VaultDeleteRequest,
    success: VaultProtocol.VaultMutationReceipt,
  }),
  Rpc.make("VaultReveal", {
    error: OperationError,
    payload: VaultProtocol.VaultKeyRequest,
    success: VaultProtocol.VaultReveal,
  }),
  Rpc.make("ScheduleList", {
    error: OperationError,
    payload: ScheduleListRequest,
    success: ScheduleList,
  }),
  Rpc.make("ScheduleGet", {
    error: OperationError,
    payload: { scheduleId: Id },
    success: ScheduleDescription,
  }),
  Rpc.make("ScheduleHistory", {
    error: OperationError,
    payload: ScheduleHistoryRequest,
    success: ScheduleHistory,
  }),
  Rpc.make("SchedulePause", {
    error: OperationError,
    payload: SchedulePauseRequest,
    success: ScheduleReceipt,
  }),
  Rpc.make("ScheduleResume", {
    error: OperationError,
    payload: ScheduleResumeRequest,
    success: ScheduleReceipt,
  }),
  Rpc.make("ExtensionOutdated", {
    error: OperationError,
    payload: ExtensionOutdatedRequest,
    success: ExtensionUpdatePage,
  }),
  Rpc.make("ExtensionAdd", {
    error: OperationError,
    payload: {
      bindingName: Schema.optionalKey(ExportName),
      expectedRevision: Digest,
      requestKey: Id,
      source: GitHubSource,
      trust: Schema.Boolean,
    },
    success: ExtensionOperation,
  }),
  Rpc.make("ExtensionUpdate", {
    error: OperationError,
    payload: {
      expectedRevision: Digest,
      id: ExtensionId,
      ref: Id,
      requestKey: Id,
      trust: Schema.Boolean,
    },
    success: ExtensionOperation,
  }),
  Rpc.make("ExtensionRemove", {
    error: OperationError,
    payload: { expectedRevision: Digest, id: ExtensionId, requestKey: Id },
    success: ExtensionOperation,
  }),
  Rpc.make("ExtensionList", {
    error: OperationError,
    payload: {},
    success: ExtensionInventory,
  }),
  Rpc.make("ExtensionDescribe", {
    error: OperationError,
    payload: { id: ExtensionId },
    success: Schema.Struct({
      applicationRevision: Digest,
      installedRevision: Digest,
      package: LockedPackage,
      summary: ExtensionSummary,
    }),
  }),
  Rpc.make("OperationGet", {
    error: OperationError,
    payload: { operationId: Id },
    success: ExtensionOperation,
  }),
  Rpc.make("OperationList", {
    error: OperationError,
    payload: OperationListRequest,
    success: OperationPage,
  }),
  Rpc.make("SystemDrain", {
    error: OperationError,
    payload: DrainRequest,
    success: DrainReceipt,
  }),
  Rpc.make("SystemDoctor", {
    error: OperationError,
    payload: {},
    success: DiagnosticReport,
  }),
  Rpc.make("SystemHello", {
    error: OperationError,
    payload: Hello,
    success: ServerHello,
  }),
  Rpc.make("SystemStatus", {
    error: OperationError,
    payload: {},
    success: ServerStatus,
  }),
  Rpc.make("TaskList", {
    error: OperationError,
    payload: DefinitionListRequest,
    success: DefinitionPage,
  }),
  Rpc.make("TaskDescribe", {
    error: OperationError,
    payload: Definition,
    success: Schema.Json,
  }),
  Rpc.make("TaskValidate", {
    error: OperationError,
    payload: Input,
    success: Validation,
  }),
  Rpc.make("TaskRun", { error: OperationError, payload: Submit, success: Run }),
  Rpc.make("WorkflowList", {
    error: OperationError,
    payload: DefinitionListRequest,
    success: DefinitionPage,
  }),
  Rpc.make("WorkflowDescribe", {
    error: OperationError,
    payload: Definition,
    success: Schema.Json,
  }),
  Rpc.make("WorkflowValidate", {
    error: OperationError,
    payload: Input,
    success: Validation,
  }),
  Rpc.make("WorkflowPlan", {
    error: OperationError,
    payload: Input,
    success: Schema.Json,
  }),
  Rpc.make("WorkflowRun", {
    error: OperationError,
    payload: Submit,
    success: Run,
  }),
  RunWatch,
  Rpc.make("RunList", {
    error: OperationError,
    payload: RunListRequest,
    success: RunPage,
  }),
  Rpc.make("RunRecoveryGet", {
    error: OperationError,
    payload: RecoveryAssessmentRequest,
    success: RecoveryAssessment,
  }),
  Rpc.make("RunRecover", {
    error: OperationError,
    payload: RecoveryRequest,
    success: RecoveryReceipt,
  }),
  Rpc.make("RunCancel", {
    error: OperationError,
    payload: CancellationRequest,
    success: CancellationReceipt,
  }),
  Rpc.make("RunGet", {
    error: OperationError,
    payload: { runId: Id },
    success: Run,
  }),
  Rpc.make("ReportSearch", {
    error: OperationError,
    payload: ReportSearchRequest,
    success: ReportSearchPage,
  }),
  Rpc.make("RunReports", {
    error: OperationError,
    payload: RunReportsRequest,
    success: RunReportsPage,
  }),
  Rpc.make("ReportGet", {
    error: OperationError,
    payload: { reportId: Id },
    success: ReportGetReply,
  }),
  Rpc.make("ReportRetry", {
    error: OperationError,
    payload: ReportRetryRequest,
    success: ReportRetryReply,
  }),
  Rpc.make("ReportCancel", {
    error: OperationError,
    payload: ReportCancelRequest,
    success: ReportCancellationReceipt,
  }),
  Rpc.make("RunSummarize", {
    error: OperationError,
    payload: { runId: Id },
    success: RunSummarizeReply,
  }),
  Rpc.make("RunChecks", {
    error: OperationError,
    payload: CheckListRequest,
    success: CheckPage,
  }),
  Rpc.make("RunOutputs", {
    error: OperationError,
    payload: OutputListRequest,
    success: OutputPage,
  }),
  Rpc.make("RunLogs", {
    error: OperationError,
    payload: LogListRequest,
    success: LogPage,
  }),
  Rpc.make("RunEvents", {
    error: OperationError,
    payload: EventListRequest,
    success: EventPage,
  }),
  Rpc.make("WaitList", {
    error: OperationError,
    payload: WaitListRequest,
    success: WaitPage,
  }),
  Rpc.make("WaitGet", {
    error: OperationError,
    payload: { waitId: Id },
    success: Wait,
  }),
  Rpc.make("WaitApprove", {
    error: OperationError,
    payload: Decision,
    success: WaitReceipt,
  }),
  Rpc.make("WaitReject", {
    error: OperationError,
    payload: {
      ...Decision,
      reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
    },
    success: WaitReceipt,
  }),
  Rpc.make("WaitRespond", {
    error: OperationError,
    payload: { ...Decision, input: Schema.Json },
    success: WaitReceipt,
  }),
  Rpc.make("WaitSignal", {
    error: OperationError,
    payload: { ...Decision, payload: Schema.Json },
    success: WaitReceipt,
  }),
  Rpc.make("LakeQuery", {
    error: OperationError,
    payload: {
      cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
      query: Query,
    },
    success: QueryPage,
  }),
  Rpc.make("LakeVersions", {
    error: OperationError,
    payload: VersionListRequest,
    success: VersionPage,
  }),
  Rpc.make("LakeReclamationAutomaticGet", {
    error: OperationError,
    payload: {},
    success: AutomaticReclamationStatus,
  }),
  Rpc.make("LakeReclamationAutomaticSet", {
    error: OperationError,
    payload: AutomaticReclamationSet,
    success: AutomaticReclamationStatus,
  }),
  Rpc.make("LakeReclamationPlan", {
    error: OperationError,
    payload: ReclamationRequest,
    success: ReclamationPlan,
  }),
  Rpc.make("LakeReclamationApply", {
    error: OperationError,
    payload: ReclamationApply,
    success: ReclamationReceipt,
  }),
  Rpc.make("LakeGet", {
    error: OperationError,
    payload: {
      artifactId: Id,
      version: Schema.Int.check(Schema.isGreaterThan(0)),
    },
    success: Content,
  })
);

export { DrainReceipt } from "./system-protocol.ts";
