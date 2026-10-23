/* oxlint-disable max-classes-per-file -- the Approve error types live with Approve. */
/**
 * `Approve` suspends its dependents until a person decides. The node opens
 * an approval `<runId>:<fqn>` with a recorded review payload;
 * `Approve.decide` records the decision and `resume` continues the run.
 * Rejection fails the run.
 */
import { Data, Effect, Schema } from "effect";

import * as Json from "./json.ts";
import * as Node from "./node.ts";
import type { NodeOptions, Registry } from "./node.ts";
import * as Output from "./output.ts";
import { State } from "./state.ts";
import type { ApprovalRow, ApprovalStatus } from "./state.ts";

/** The approval was rejected; fails the Approve node and the run. */
export class ApprovalRejected extends Data.TaggedError("ApprovalRejected")<{
  readonly id: string;
  readonly fqn: string;
  readonly message: string;
}> {}

export class ApprovalNotFound extends Data.TaggedError("ApprovalNotFound")<{
  readonly id: string;
  readonly message: string;
}> {}

export class ApprovalNotPending extends Data.TaggedError("ApprovalNotPending")<{
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly message: string;
}> {}

export const DecisionSchema = Schema.Struct({
  approved: Schema.Boolean,
  decidedBy: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
});
export type Decision = typeof DecisionSchema.Type;

const codec = Schema.toCodecJson(DecisionSchema) as unknown as Schema.Codec<
  unknown,
  unknown
>;

export interface Definition {
  readonly title: Output.Input<string>;
  /** Shown to the approver; may contain Outputs. */
  readonly review?: unknown;
  /** Skip the approval (and open none) when false. */
  readonly when?: Output.Output<boolean> | boolean;
}

/** The id of the approval an Approve node opens. */
export const approvalId = (runId: string, fqn: string) => `${runId}:${fqn}`;

const both = (
  left: Output.Output<boolean> | boolean | undefined,
  right: Output.Output<boolean> | boolean | undefined
): Output.Output<boolean> | boolean | undefined => {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Output.map({ left, right }, (value) => value.left && value.right);
};

const register = (
  key: string,
  definition: Definition,
  options: NodeOptions = {}
): Effect.Effect<Output.Output<Decision>, never, Registry> => {
  const when = both(options.when, definition.when);
  return Node.register<Decision>({
    codec,
    execute: (ctx) =>
      Effect.gen(function* executeApprove() {
        const input = ctx.input as {
          readonly title: string;
          readonly review: unknown;
        };
        const id = approvalId(ctx.runId, ctx.fqn);
        const approval = yield* ctx.state.getApproval(id);
        if (approval === undefined) {
          yield* ctx.state.putApproval({
            createdAt: Date.now(),
            fqn: ctx.fqn,
            id,
            review: Json.toJson(input.review) ?? null,
            runId: ctx.runId,
            status: "pending",
            title: input.title,
          });
          return Node.suspended(`awaiting approval ${id}`);
        }
        if (approval.status === "pending") {
          return Node.suspended(`awaiting approval ${id}`);
        }
        if (approval.status === "rejected") {
          const by = approval.decidedBy ? ` by ${approval.decidedBy}` : "";
          const note = approval.note ? `: ${approval.note}` : "";
          return yield* new ApprovalRejected({
            fqn: ctx.fqn,
            id,
            message: `${approval.title} was rejected${by}${note}`,
          });
        }
        return Node.succeeded({
          approved: true,
          ...(approval.decidedBy === undefined
            ? {}
            : { decidedBy: approval.decidedBy }),
          ...(approval.note === undefined ? {} : { note: approval.note }),
        });
      }),
    input: { review: definition.review, title: definition.title },
    kind: "approve",
    name: key,
    options: { ...options, ...(when === undefined ? {} : { when }) },
    plan: () =>
      Effect.succeed({ action: "run", detail: "suspends for approval" }),
    record: false,
    reuse: "record",
    type: "Approve",
  });
};

/**
 * Approve or reject a pending approval. Resume the run afterwards to
 * continue it.
 */
export const decide = (
  id: string,
  decision: {
    readonly approved: boolean;
    readonly by?: string;
    readonly note?: string;
  }
): Effect.Effect<ApprovalRow, ApprovalNotFound | ApprovalNotPending, State> =>
  Effect.gen(function* decideApproval() {
    const state = yield* State;
    const approval = yield* state.getApproval(id);
    if (approval === undefined) {
      return yield* new ApprovalNotFound({
        id,
        message: `No approval ${id}`,
      });
    }
    if (approval.status !== "pending") {
      return yield* new ApprovalNotPending({
        id,
        message: `Approval ${id} is already ${approval.status}`,
        status: approval.status,
      });
    }
    const decided: ApprovalRow = {
      ...approval,
      decidedAt: Date.now(),
      status: decision.approved ? "approved" : "rejected",
      ...(decision.by === undefined ? {} : { decidedBy: decision.by }),
      ...(decision.note === undefined ? {} : { note: decision.note }),
    };
    yield* state.putApproval(decided);
    return decided;
  });

/**
 * Wait for a person's decision before dependents run. Independent branches
 * keep running; the run is `suspended` until the approval is decided and
 * the run resumed.
 *
 * ```ts
 * const go = yield* Approve("deploy", { title: "Deploy?", review: { diff } });
 * yield* Deploy("deploy-prod", { ... }, { dependsOn: [go] });
 * ```
 */
export const Approve = Object.assign(register, { approvalId, decide });
