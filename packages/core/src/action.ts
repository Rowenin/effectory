/* oxlint-disable max-classes-per-file -- the Action error types live with Action. */
/**
 * An Action is an imperative, recorded step. Its output is schema-validated
 * and written as a Record. Delivery is at-least-once: an interrupted Action
 * reruns on resume unless it declares `retry: "never"`.
 */
import { Data, Effect, Schema } from "effect";

import * as Json from "./json.ts";
import * as Node from "./node.ts";
import type {
  ExecContext,
  NodeOptions,
  PlannedChange,
  Registry,
} from "./node.ts";
import type * as Output from "./output.ts";
import * as Workflow from "./workflow.ts";

/** An interrupted `retry: "never"` Action may or may not have taken effect. */
export class OutcomeUnknown extends Data.TaggedError("OutcomeUnknown")<{
  readonly message: string;
  readonly fqn: string;
  readonly approval: string;
}> {}

export class InvalidInput extends Data.TaggedError("InvalidInput")<{
  readonly message: string;
}> {}

export interface Definition<I, O, R> {
  readonly description?: string;
  readonly input: Schema.Codec<I, unknown>;
  readonly output: Schema.Codec<O, unknown>;
  /**
   * `always` (default) runs every time. `on-change` skips the Action when the
   * latest record for its FQN in this scope has the same input digest.
   */
  readonly rerun?: "always" | "on-change";
  /**
   * `auto` (default) reruns an interrupted Action on resume. `never` fails it
   * with `OutcomeUnknown` and opens an approval to retry.
   */
  readonly retry?: "auto" | "never";
  readonly run: (input: I) => Effect.Effect<O, unknown, R>;
  /** Used instead of `run` in fake mode, when given. */
  readonly fake?: (input: I) => Effect.Effect<O, unknown, R>;
}

export interface Action<Type extends string, I, O, R> {
  (
    name: string,
    input: Output.Input<I>,
    options?: NodeOptions
  ): Effect.Effect<Output.Output<O>, never, Registry | R>;
  readonly _tag: "Action";
  readonly type: Type;
  readonly definition: Definition<I, O, R>;
}

/** Any Action. */
// oxlint-disable-next-line typescript/no-explicit-any -- variance escape hatch for collections
export type Any = Action<string, any, any, any>;

export const isAction = (value: unknown): value is Any =>
  typeof value === "function" &&
  (value as { _tag?: unknown })._tag === "Action";

/** The approval id that retries an interrupted `retry: "never"` Action. */
export const retryApprovalId = (runId: string, fqn: string, attempt: number) =>
  `${runId}:retry:${fqn}:${attempt}`;

const interruptedAttempt = (ctx: ExecContext) => {
  const { previous } = ctx;
  if (previous?.status === "running") {
    return previous.attempt;
  }
  return previous?.status === "failed" &&
    previous.error?.tag === "OutcomeUnknown"
    ? previous.attempt - 1
    : undefined;
};

/** The latest record for this FQN and scope, when its input digest matches. */
const cached = (
  ctx: {
    readonly state: ExecContext["state"];
    readonly collection: string;
    readonly scope: string;
    readonly fqn: string;
  },
  input: unknown
) =>
  ctx.state
    .records({
      collection: ctx.collection,
      fqn: ctx.fqn,
      limit: 1,
      scope: ctx.scope,
    })
    .pipe(
      Effect.map(([latest]) =>
        latest !== undefined && latest.inputDigest === Json.digest(input)
          ? latest
          : undefined
      )
    );

/**
 * Define an Action.
 *
 * ```ts
 * export const Shell = Action.make("Shell", {
 *   input: ShellInput,
 *   output: ShellResult,
 *   run: (input) => ...,
 * });
 * const test = yield* Shell("test", { cwd: checkout.path, command: "bun", args: ["test"] });
 * ```
 */
export const make = <const Type extends string, I, O, R = never>(
  type: Type,
  definition: Definition<I, O, R>
): Action<Type, I, O, R> => {
  const rerun = definition.rerun ?? "always";
  const retry = definition.retry ?? "auto";
  const codec = Schema.toCodecJson(
    definition.output
  ) as unknown as Schema.Codec<unknown, unknown>;
  const validateInput = Schema.decodeUnknownEffect(
    Schema.toType(definition.input)
  );
  const validateOutput = Schema.decodeUnknownEffect(
    Schema.toType(definition.output)
  );

  const register = (
    name: string,
    input: Output.Input<I>,
    options?: NodeOptions
  ) =>
    Effect.gen(function* registerAction() {
      const context = yield* Effect.context<R>();
      return yield* Node.register<O>({
        codec,
        execute: (ctx) =>
          Effect.gen(function* executeAction() {
            const interrupted = interruptedAttempt(ctx);
            if (retry === "never" && interrupted !== undefined) {
              const id = retryApprovalId(ctx.runId, ctx.fqn, interrupted);
              const approval = yield* ctx.state.getApproval(id);
              if (approval?.status !== "approved") {
                if (approval === undefined) {
                  yield* ctx.state.putApproval({
                    createdAt: Date.now(),
                    fqn: ctx.fqn,
                    id,
                    review: {
                      attempt: interrupted,
                      input: Json.toJson(ctx.input),
                    },
                    runId: ctx.runId,
                    status: "pending",
                    title: `Retry ${ctx.fqn}? Attempt ${interrupted} was interrupted and may have taken effect.`,
                  });
                }
                return yield* new OutcomeUnknown({
                  approval: id,
                  fqn: ctx.fqn,
                  message: `${ctx.fqn} was interrupted and declares retry: "never"; approve ${id} and resume to retry`,
                });
              }
            }
            const decoded = yield* validateInput(ctx.input).pipe(
              Effect.mapError(
                (issue) =>
                  new InvalidInput({
                    message: `${ctx.fqn}: ${String(issue)}`,
                  })
              )
            );
            if (rerun === "on-change") {
              const hit = yield* cached(ctx, ctx.input);
              if (hit) {
                const value = yield* Schema.decodeUnknownEffect(codec)(
                  hit.value
                );
                return Node.succeeded(value);
              }
            }
            const implementation =
              ctx.mode === "fake" && definition.fake
                ? definition.fake
                : definition.run;
            const output = yield* Effect.provideContext(
              implementation(decoded as I),
              context
            );
            return Node.succeeded(yield* validateOutput(output));
          }),
        input,
        kind: "action",
        name,
        options,
        plan: (ctx) => {
          if (rerun === "always") {
            return Effect.succeed({ action: "run" });
          }
          if (!ctx.input.resolved) {
            return Effect.succeed({
              action: "unknown",
              detail: "input known at execution",
            });
          }
          return cached(ctx, ctx.input.value).pipe(
            Effect.map((hit): PlannedChange =>
              hit
                ? { action: "cached", detail: `record ${hit.id}` }
                : { action: "run" }
            )
          );
        },
        record: true,
        reuse: "record",
        type,
      });
    });

  return Object.assign(register, {
    _tag: "Action" as const,
    definition,
    type,
  }) as Action<Type, I, O, R>;
};

/** A one-node workflow that runs `action` once: `effectory action run`. */
export const toWorkflow = <Type extends string, I, O, R>(
  action: Action<Type, I, O, R>
) =>
  Workflow.make(
    action.type,
    {
      description:
        action.definition.description ?? `Run the ${action.type} Action`,
      input: action.definition.input as Schema.Codec<I, unknown, never, never>,
      scope: () => "adhoc",
    },
    (input: I) => action("run", input)
  );
