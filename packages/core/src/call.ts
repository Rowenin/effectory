/**
 * `Call` runs another workflow as part of this one. The callee's nodes, and
 * so its records, approvals, and resources, live under `name/` and share the
 * caller's run and scope.
 */
import { Data, Effect, Schema } from "effect";

import {
  captureContext,
  checkName,
  childDefaults,
  settle,
  tracking,
  withDefaults,
} from "./each.ts";
import * as Json from "./json.ts";
import * as Node from "./node.ts";
import type { NodeOptions, Registry } from "./node.ts";
import * as Output from "./output.ts";
import type * as Workflow from "./workflow.ts";

/** The callee rejected the input it was called with. */
export class InvalidCallInput extends Data.TaggedError("InvalidCallInput")<{
  readonly message: string;
  readonly workflow: string;
}> {}

const decoder = <I, O, R>(workflow: Workflow.Workflow<string, I, O, R>) => {
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(workflow.input));
  return (input: unknown, at: string) =>
    decode(Json.toJson(input)).pipe(
      Effect.mapError(
        (issue) =>
          new InvalidCallInput({
            message: `${at}: invalid input for ${workflow.name}: ${String(issue)}`,
            workflow: workflow.name,
          })
      )
    ) as Effect.Effect<I, InvalidCallInput>;
};

/**
 * Run `workflow` with `input` under `name/`.
 *
 * A plan-time `input` (no Outputs) is decoded at plan time and the callee's
 * nodes appear in the plan; node options then apply to every callee node.
 * Otherwise one `Call:<workflow>` node decodes the input and expands the
 * callee at execution; it succeeds once every callee node finished, and node
 * options apply to it.
 *
 * ```ts
 * const notified = yield* Call("notify", notifyWorkflow, { channel: "#ci" });
 * ```
 */
export const Call = <I, O, R>(
  name: string,
  workflow: Workflow.Workflow<string, I, O, R>,
  input: Output.Input<I>,
  options: NodeOptions = {}
): Effect.Effect<Output.Output<Output.Resolved<O>>, unknown, R | Registry> => {
  const decode = decoder(workflow);
  if (Output.isResolved(input)) {
    return Effect.gen(function* callStatic() {
      yield* checkName(name);
      const path = yield* Node.Namespace;
      const decoded = yield* decode(input, [...path, name].join("/"));
      const value = yield* workflow
        .body(decoded)
        .pipe(withDefaults(options), Node.namespace(name));
      return Output.map(value, (resolved) => resolved) as Output.Output<
        Output.Resolved<O>
      >;
    });
  }
  return Effect.gen(function* registerCall() {
    const context = yield* captureContext<R>();
    const defaults = yield* childDefaults(options);
    return yield* Node.register<Output.Resolved<O>>({
      execute: (ctx) =>
        Effect.gen(function* executeCall() {
          const decoded = yield* decode(ctx.input, ctx.fqn);
          const body = workflow
            .body(decoded)
            .pipe(
              Effect.provideService(Node.Defaults, defaults),
              Effect.provideService(Node.Limiter, Node.Limiter.defaultValue())
            ) as Effect.Effect<O, unknown, Registry>;
          const { fqns, value } = yield* ctx.expand(tracking(body), {
            context,
          });
          return yield* settle(ctx, fqns, value);
        }),
      input,
      kind: "call",
      name,
      options,
      permit: false,
      plan: () =>
        Effect.succeed({
          action: "expand",
          detail: `runs ${workflow.name} once its input is known`,
        }),
      reuse: "record",
      type: `Call:${workflow.name}`,
    });
  });
};
