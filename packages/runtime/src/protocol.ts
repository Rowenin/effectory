import { Schema } from "effect";

const Id = Schema.String.check(Schema.isMinLength(1));

/** Private local control messages. Workflow payloads are decoded again by their own Schema. */
export const ControlRequest = Schema.Union([
  Schema.Struct({ method: Schema.Literal("task.list") }),
  Schema.Struct({ method: Schema.Literal("task.describe"), name: Id }),
  Schema.Struct({
    input: Schema.Unknown,
    method: Schema.Literal("task.run"),
    requestKey: Id,
    task: Id,
  }),
  Schema.Struct({ method: Schema.Literal("run.list") }),
  Schema.Struct({ id: Id, method: Schema.Literal("run.inspect") }),
  Schema.Struct({ id: Id, method: Schema.Literal("run.cancel") }),
  Schema.Struct({ id: Id, method: Schema.Literal("run.resume") }),
  Schema.Struct({
    method: Schema.Literal("artifact.list"),
    runId: Schema.optional(Id),
  }),
  Schema.Struct({ id: Id, method: Schema.Literal("artifact.get") }),
  Schema.Struct({ method: Schema.Literal("approval.list") }),
  Schema.Struct({ id: Id, method: Schema.Literal("approval.inspect") }),
  Schema.Struct({
    digest: Id,
    id: Id,
    method: Schema.Literal("approval.decide"),
    outcome: Schema.Literals(["approved", "rejected"]),
    reason: Schema.optional(Schema.String),
    revision: Id,
  }),
]);

export type ControlMessage = typeof ControlRequest.Type;

export const ControlResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ error: Schema.String, ok: Schema.Literal(false) }),
]);
