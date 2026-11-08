/* oxlint-disable eslint/no-redeclare -- Effect schemas intentionally share their value and type names. */
import { Context, Effect, Schema } from "effect";

import { TaskRuntimeError } from "./errors.ts";
import type * as Task from "./task.ts";
import type * as Workflow from "./workflow.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(200));
const Count = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })
);
export const Status = Schema.Literals([
  "Succeeded",
  "Failed",
  "Rejected",
  "TimedOut",
  "Cancelled",
]);
export type Status = typeof Status.Type;
export const Source = Schema.Struct({
  invocationId: Schema.NullOr(Id),
  revision: Id,
  runId: Id,
  scope: Schema.Literals(["run", "invocation"]),
  status: Status,
  targetId: Id,
  targetKind: Schema.Literals(["task", "workflow"]),
  targetVersion: Schema.Int.check(
    Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 })
  ),
});
export type Source = typeof Source.Type;
export type Target = Task.Contract | Workflow.Definition;
export type KindOf<T extends Target> = T extends Workflow.Definition
  ? "workflow"
  : "task";
export type Outcome<V, E> =
  | { readonly _tag: "Succeeded"; readonly value: V }
  | { readonly _tag: "DomainFailure"; readonly error: E }
  | {
      readonly _tag: "Failure";
      readonly category: "Host" | "Defect";
      readonly detail: Schema.Json;
    }
  | {
      readonly _tag: "Stopped";
      readonly status: "Rejected" | "TimedOut" | "Cancelled";
      readonly detail: Schema.Json;
    };
export const Outcome = Schema.Union([
  Schema.TaggedStruct("Succeeded", { value: Schema.Json }),
  Schema.TaggedStruct("DomainFailure", { error: Schema.Json }),
  Schema.TaggedStruct("Failure", {
    category: Schema.Literals(["Host", "Defect"]),
    detail: Schema.Json,
  }),
  Schema.TaggedStruct("Stopped", {
    detail: Schema.Json,
    status: Schema.Literals(["Rejected", "TimedOut", "Cancelled"]),
  }),
]);
/** Counts Unicode code points, matching string iteration. */
const codePointLength = (text: string) => text.match(/./gsu)?.length ?? 0;
export const PathPreview = Schema.Struct({
  text: Schema.String.check(
    Schema.makeFilter((value) => codePointLength(value) <= 2048)
  ),
  truncated: Schema.Boolean,
});
export const InvocationItem = Schema.Struct({
  attemptCount: Count,
  invocationId: Id,
  pathPreview: PathPreview,
  providerId: Schema.NullOr(Id),
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
  taskVersion: Source.fields.targetVersion,
});
export type InvocationItem = typeof InvocationItem.Type;
export const Event = Schema.Struct({
  at: Schema.String,
  payload: Schema.Json,
  runId: Schema.String,
  sequence: Schema.Int,
  tag: Schema.String,
});
export const PageRequest = Schema.Struct({
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 1 }))
  ),
});
export type PageRequest = typeof PageRequest.Type;
export const EventRequest = Schema.Struct({
  ...PageRequest.fields,
  afterSequence: Schema.optionalKey(Count),
});
export const InvocationPage = Schema.Struct({
  cursor: Schema.NullOr(Schema.String),
  items: Schema.Array(InvocationItem).check(Schema.isMaxLength(200)),
  snapshot: Count,
});
export type InvocationPage = typeof InvocationPage.Type;
export const EventPage = Schema.Struct({
  cursor: Schema.NullOr(Schema.String),
  items: Schema.Array(Event).check(Schema.isMaxLength(200)),
  snapshot: Count,
});
export type EventPage = typeof EventPage.Type;
export interface HistoryService {
  readonly outcome: {
    (): Effect.Effect<Outcome<Schema.Json, Schema.Json>, TaskRuntimeError>;
    <T extends Target>(
      target: T
    ): Effect.Effect<
      Outcome<T["successSchema"]["Type"], T["errorSchema"]["Type"]>,
      TaskRuntimeError
    >;
  };
  readonly invocations: (
    options?: PageRequest
  ) => Effect.Effect<InvocationPage, TaskRuntimeError>;
  readonly events: (
    options?: typeof EventRequest.Type
  ) => Effect.Effect<EventPage, TaskRuntimeError>;
}
export class History extends Context.Service<History, HistoryService>()(
  "@offtree/effectory-sdk/Report.History"
) {}

const refuse = () =>
  Effect.fail(
    new TaskRuntimeError({
      code: "InvalidBoundary",
      message: "Report.History is available only inside a report invocation",
    })
  );
export const unavailableHistory: HistoryService = Object.freeze({
  events: refuse,
  invocations: refuse,
  outcome: refuse,
});
