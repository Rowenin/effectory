/** Task definitions: schemas, the body contract, and type-level accessors. */
import type { Duration, Effect, Schema } from "effect";

import type { PlanError, TaskTimeout } from "./errors.ts";
import type { Planner } from "./services.ts";

/** A schema whose encoding needs no services, so plan keys are pure. */
export type AnySchema = Schema.Constraint & {
  readonly EncodingServices: never;
};

/** What every kind of Task is described by. */
export interface BaseConfig<In extends AnySchema, Out extends AnySchema> {
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly input: In;
  readonly output: Out;
}

export interface RetryPolicy {
  /** Retries after the first attempt. */
  readonly times: number;
  /** Wait between attempts. */
  readonly delay?: Duration.Input;
}

/** How a Task's work runs. */
export interface Execution {
  /** Run failed work again. A wait for an Input is never retried. */
  readonly retry?: RetryPolicy;
  /** Fail an attempt that runs longer than this with `TaskTimeout`. */
  readonly timeout?: Duration.Input;
  /** Most nodes of this Task doing work at once in a run. */
  readonly concurrency?: number;
}

export interface TaskConfig<In extends AnySchema, Out extends AnySchema>
  extends BaseConfig<In, Out>, Execution {}

/** What a Task body hands back to the planner: the work to do at run time. */
export interface Step<A, E = never, R = never> {
  readonly run: Effect.Effect<A, E, R>;
}

export const TaskTypeId: unique symbol = Symbol.for("effectory/flow/Task");

/**
 * `"task"` does work in `run`; `"input"` waits for a person's response, which
 * `run` takes from outside instead of computing; `"timer"` waits until a time.
 */
export type TaskKind = "task" | "input" | "timer";

// oxlint-disable-next-line no-redeclare -- `Flow.Task` is both the type and its constructor.
export interface Task<
  out Name extends string,
  in out In extends AnySchema,
  in out Out extends AnySchema,
  out E = never,
  out R = never,
> {
  readonly [TaskTypeId]: {
    readonly _E: (_: never) => E;
    readonly _R: (_: never) => R;
  };
  readonly name: Name;
  readonly kind: TaskKind;
  readonly description: string | undefined;
  readonly labels: readonly string[];
  readonly input: In;
  readonly output: Out;
  readonly execution: Execution;
  /** For timers: how long to wait, from the Task's input. */
  readonly wait?: (input: In["Type"]) => Duration.Input;
  readonly body: (
    input: In["Type"]
  ) => Effect.Effect<Step<Out["Type"], unknown, unknown>, unknown, unknown>;
}

// oxlint-disable-next-line typescript/no-explicit-any -- schemas are invariant; `any` admits every Task.
export type AnyTask = Task<string, any, any, unknown, unknown>;
export type InputOf<T extends AnyTask> = T["input"]["Type"];
export type OutputOf<T extends AnyTask> = T["output"]["Type"];
export type ErrorOf<T extends AnyTask> = T[typeof TaskTypeId]["_E"] extends (
  _: never
) => infer E
  ? E
  : never;
export type ServicesOf<T extends AnyTask> = T[typeof TaskTypeId]["_R"] extends (
  _: never
) => infer R
  ? R
  : never;

/** `input` may be omitted for Tasks whose input schema accepts `undefined`. */
export type InputArgs<T extends AnyTask> =
  undefined extends InputOf<T> ? [input?: InputOf<T>] : [input: InputOf<T>];

/**
 * Define a Task. Upstream errors and services declared with `After` are
 * folded into this Task's type, so they surface wherever it is planned.
 */
export const Task = <
  const Name extends string,
  In extends AnySchema,
  Out extends AnySchema,
  A extends Out["Type"],
  BE = never,
  BR = never,
  E = never,
  R = never,
  Timeout extends Duration.Input | undefined = undefined,
>(
  name: Name,
  config: TaskConfig<In, Out> & { readonly timeout?: Timeout },
  body: (input: In["Type"]) => Effect.Effect<Step<A, E, R>, BE, BR>
): Task<
  Name,
  In,
  Out,
  | E
  | Exclude<BE, PlanError>
  | (undefined extends Timeout ? never : TaskTimeout),
  R | Exclude<BR, Planner>
> => ({
  [TaskTypeId]: { _E: (_) => _, _R: (_) => _ },
  body,
  description: config.description,
  execution: {
    ...(config.concurrency === undefined
      ? {}
      : { concurrency: config.concurrency }),
    ...(config.retry === undefined ? {} : { retry: config.retry }),
    ...(config.timeout === undefined ? {} : { timeout: config.timeout }),
  },
  input: config.input,
  kind: "task",
  labels: config.labels ?? [],
  name,
  output: config.output,
});
