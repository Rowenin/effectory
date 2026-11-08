import type { Application } from "@offtree/effectory-sdk";
import { Status } from "@offtree/effectory-sdk/internal/report-history";
import { Execution as ReportExecution } from "@offtree/effectory-sdk/internal/report-record";
import { selectReports } from "@offtree/effectory-sdk/internal/report-selection";
import { RunTags } from "@offtree/effectory-sdk/RunTags";
import { Effect, Schema } from "effect";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(200));
const Positive = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 })
);
export const ReportPlanEntry = Schema.Struct({
  attachmentId: Id,
  execution: ReportExecution,
  on: Schema.Array(Status).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  reporterId: Id,
  reporterProviderId: Schema.NullOr(Id),
  reporterVersion: Positive,
  required: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  scope: Schema.Literals(["run", "invocation"]),
  tags: RunTags.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => ({})))),
  targetId: Id,
  targetKind: Schema.Literals(["task", "workflow"]),
  targetVersion: Positive,
});
export const ReportPlan = Schema.Array(ReportPlanEntry).check(
  Schema.isMaxLength(128)
);
export type EncodedReportPlan = typeof ReportPlan.Encoded;

/** Capture only data before entering admission; no codecs or author callbacks in SQLite. */
export function resolveReportPlan(
  registry: typeof Application.Registry.Service,
  kind: "task" | "workflow",
  targetId: string,
  selection: unknown = {}
) {
  const { selected, decision } = selectReports(
    registry,
    kind,
    targetId,
    selection
  );
  const plan: EncodedReportPlan = selected.map((attachment) => ({
    attachmentId: attachment.id,
    execution: attachment.execution,
    on: attachment.on,
    reporterId: attachment.task.id,
    reporterProviderId:
      registry.tasks.get(attachment.task.id)?.providerId ?? null,
    reporterVersion: attachment.task.spec.version,
    required: attachment.required,
    scope: attachment.scope,
    tags: attachment.tags,
    targetId: attachment.target.id,
    targetKind: attachment.target.kind === "Task" ? "task" : "workflow",
    targetVersion: attachment.target.spec.version,
  }));
  return { decision, plan };
}
export function reportPlan(
  registry: typeof Application.Registry.Service,
  kind: "task" | "workflow",
  targetId: string
): EncodedReportPlan {
  return resolveReportPlan(registry, kind, targetId).plan;
}
