import { Context, Effect, Option, Schema } from "effect";
import * as NativeActivity from "effect/workflow/Activity";
import type {
  WorkflowEngine,
  WorkflowInstance,
} from "effect/workflow/WorkflowEngine";

import { AutomationError, requireName } from "./authoring.ts";
import type { Codec } from "./authoring.ts";

/**
 * Present only while a Task body runs. Services whose calls have side effects
 * require it, so calling them outside a Task (where nothing is recorded and
 * every replay repeats the call) fails to typecheck.
 */
export class InTask extends Context.Service<
  InTask,
  { readonly path: string }
>()("effectory/InTask") {}

/** A named, durable step made by `make`. Call it with an input and an optional key. */
export interface Task<I extends Codec, S extends Codec, E extends Codec, R> {
  (
    input: I["Type"],
    invocation?: { readonly key: string }
  ): Effect.Effect<
    S["Type"],
    E["Type"] | AutomationError,
    Exclude<R, InTask> | WorkflowEngine | WorkflowInstance
  >;
  readonly taskName: string;
  readonly input: I;
  readonly success: S;
  readonly error: Schema.Union<readonly [E, typeof AutomationError]>;
}

// oxlint-disable-next-line typescript/no-explicit-any -- matches any Task's schemas and services.
export type Any = Task<any, any, any, any>;
/* oxlint-disable typescript/no-explicit-any -- extractors ignore the other parameters. */
export type Input<T> =
  T extends Task<infer I, any, any, any> ? I["Type"] : never;
export type Success<T> =
  T extends Task<any, infer S, any, any> ? S["Type"] : never;
export type Error<T> =
  T extends Task<any, any, infer E, any> ? E["Type"] : never;
export type Services<T> =
  T extends Task<any, any, any, infer R> ? Exclude<R, InTask> : never;
/* oxlint-enable typescript/no-explicit-any */

const segment = (name: string, key: string | undefined) =>
  `${name.length}:${name}/${key === undefined ? "once" : `key:${key}`}`;

/**
 * A named, durable step. Its result is recorded; replay returns the record
 * instead of running the body again. A body may call services and other
 * Tasks. Child Tasks are recorded under the parent's key, so a parent that
 * re-runs after a crash replays the children that already finished.
 */
export const make = <
  I extends Codec,
  S extends Codec,
  E extends Codec,
  R,
>(options: {
  readonly name: string;
  readonly input: I;
  readonly success: S;
  readonly error: E;
  readonly run: (
    input: I["Type"]
  ) => Effect.Effect<
    NoInfer<S["Type"]>,
    NoInfer<E["Type"]> | AutomationError,
    R
  >;
}): Task<I, S, E, R> => {
  requireName(options.name);
  const error = Schema.Union([options.error, AutomationError]);
  const inputSchema = Schema.toType(options.input);
  const successSchema = Schema.toType(options.success);
  const failure =
    (reason: "invalid-input" | "invalid-output") => (cause: unknown) =>
      new AutomationError({
        message: String(cause),
        operation: options.name,
        reason,
      });

  /** Run the Task. Supply a stable key for each distinct call in its parent. */
  const call = (input: I["Type"], invocation?: { readonly key: string }) =>
    Effect.flatMap(Effect.serviceOption(InTask), (parent) => {
      const own = segment(options.name, invocation?.key);
      const path = Option.match(parent, {
        onNone: () => own,
        onSome: ({ path: prefix }) => `${prefix}/${own}`,
      });
      return NativeActivity.make<Exclude<R, InTask>, S, typeof error>({
        error,
        execute: Schema.decodeUnknownEffect(inputSchema)(input).pipe(
          Effect.mapError(failure("invalid-input")),
          Effect.flatMap((decoded) =>
            options.run(decoded).pipe(Effect.provideService(InTask, { path }))
          ),
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(successSchema)(value).pipe(
              Effect.mapError(failure("invalid-output"))
            )
          )
        ),
        name: `effectory/task/${path}`,
        success: options.success,
      });
    });

  return Object.assign(call, {
    error,
    input: options.input,
    success: options.success,
    taskName: options.name,
  });
};
