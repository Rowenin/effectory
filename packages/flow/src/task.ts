/** Task definitions: schemas, the body contract, and type-level accessors. */
import type { Effect, Schema } from "effect";

import type { PlanError } from "./errors.ts";
import type { Planner } from "./services.ts";

/** A schema whose encoding needs no services, so plan keys are pure. */
export type AnySchema = Schema.Constraint & {
  readonly EncodingServices: never;
};

export interface TaskConfig<In extends AnySchema, Out extends AnySchema> {
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly input: In;
  readonly output: Out;
}

/** What a Task body hands back to the planner: the work to do at run time. */
export interface Step<A, E = never, R = never> {
  readonly run: Effect.Effect<A, E, R>;
}

export const TaskTypeId: unique symbol = Symbol.for("effectory/flow/Task");

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
  readonly description: string | undefined;
  readonly labels: readonly string[];
  readonly input: In;
  readonly output: Out;
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
>(
  name: Name,
  config: TaskConfig<In, Out>,
  body: (input: In["Type"]) => Effect.Effect<Step<A, E, R>, BE, BR>
): Task<
  Name,
  In,
  Out,
  E | Exclude<BE, PlanError>,
  R | Exclude<BR, Planner>
> => ({
  [TaskTypeId]: { _E: (_) => _, _R: (_) => _ },
  body,
  description: config.description,
  input: config.input,
  labels: config.labels ?? [],
  name,
  output: config.output,
});
