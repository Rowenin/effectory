/**
 * The entry point to a set of Tasks: what `flow.run.ts` default-exports and
 * the CLI loads. It finds Tasks by name, searches them, and plans, starts and
 * resumes them by name with JSON inputs, providing the services they need.
 */
import { Data, Effect, Layer, Option, Schema } from "effect";

import { resume, start, status } from "./durable.ts";
import type { Outcome, RunState } from "./durable.ts";
import type { PlanError, StoreError } from "./errors.ts";
import { plan } from "./plan.ts";
import type { Plan } from "./plan.ts";
import { Concurrency } from "./services.ts";
import { RunStore } from "./store.ts";
import type { RunRecord } from "./store.ts";
import type { AnyTask, ServicesOf } from "./task.ts";

/** An unknown Task name, a name used by two Tasks, or invalid input. */
export class AppError extends Data.TaggedError("AppError")<{
  readonly reason: "unknown-task" | "duplicate-task" | "invalid-input";
  readonly message: string;
}> {}

const AppTypeId: unique symbol = Symbol.for("effectory/flow/App");

type AnyOutcome = Outcome<unknown, unknown>;

export interface App {
  readonly [AppTypeId]: typeof AppTypeId;
  /** Every Task, in the order given. */
  readonly tasks: readonly AnyTask[];
  readonly get: (name: string) => Option.Option<AnyTask>;
  /** Tasks whose name, description or a label contains `query`, ignoring case. */
  readonly search: (query: string) => readonly AnyTask[];
  /** Plan Task `name` with `input` in its JSON form. */
  readonly plan: (
    name: string,
    input: unknown
  ) => Effect.Effect<Plan<unknown, unknown, unknown>, unknown>;
  /** Start a durable run of Task `name` with `input` in its JSON form. */
  readonly start: (
    name: string,
    input: unknown
  ) => Effect.Effect<AnyOutcome, unknown, RunStore>;
  /** Respond to a run's pending Inputs and continue it. */
  readonly resume: (
    runId: string,
    responses?: Readonly<Record<string, unknown>>
  ) => Effect.Effect<AnyOutcome, unknown, RunStore>;
  readonly status: (
    runId: string
  ) => Effect.Effect<RunState, unknown, RunStore>;
  /** Every run in the store, oldest first. */
  readonly runs: Effect.Effect<readonly RunRecord[], StoreError, RunStore>;
}

type ServicesOfAll<T> = T extends AnyTask ? ServicesOf<T> : never;

/** Services the Tasks need, directly or through what they run after or call. */
export type MissingServices<
  Tasks extends readonly AnyTask[],
  Provided,
> = Exclude<ServicesOfAll<Tasks[number]>, Provided>;

export interface AppConfig<Tasks extends readonly AnyTask[], Provided, E> {
  readonly tasks: Tasks;
  /** Provides the services the Tasks need. */
  readonly layer?: Layer.Layer<Provided, E>;
  /** Most nodes doing work at once in each run (default: no limit). */
  readonly concurrency?: number;
}

/** Decode a Task's input from its JSON form. */
const decode = (task: AnyTask, input: unknown) =>
  Schema.decodeUnknownEffect(Schema.toCodecJson(task.input))(input).pipe(
    Effect.mapError(
      (failure) =>
        new AppError({
          message: `Invalid input for ${task.name}: ${failure.message}`,
          reason: "invalid-input",
        })
    )
  );

export const isApp = (value: unknown): value is App =>
  typeof value === "object" && value !== null && AppTypeId in value;

/**
 * Define the app over `tasks`. `layer` must provide every service the Tasks
 * need; if it doesn't, the config needs a `missingServices` property, whose
 * type names what's missing. Task names must be unique.
 */
export const make = <
  const Tasks extends readonly AnyTask[],
  Provided = never,
  E = never,
>(
  config: AppConfig<Tasks, Provided, E> &
    ([MissingServices<Tasks, Provided>] extends [never]
      ? unknown
      : { readonly missingServices: MissingServices<Tasks, Provided> })
): App => {
  const byName = new Map<string, AnyTask>();
  for (const task of config.tasks) {
    const existing = byName.get(task.name);
    if (existing && existing !== task) {
      throw new AppError({
        message: `Two Tasks are named ${task.name}`,
        reason: "duplicate-task",
      });
    }
    byName.set(task.name, task);
  }
  const tasks = [...byName.values()];
  const services = (config.layer ?? Layer.empty) as Layer.Layer<never, unknown>;

  const find = (name: string) =>
    Effect.fromOption(Option.fromUndefinedOr(byName.get(name))).pipe(
      Effect.mapError(
        () =>
          new AppError({
            message: `No Task named ${name}`,
            reason: "unknown-task",
          })
      )
    );
  const provide = <A, Err, R>(effect: Effect.Effect<A, Err, R>) =>
    Effect.provide(
      config.concurrency === undefined
        ? effect
        : Effect.provideService(effect, Concurrency, config.concurrency),
      services
    ) as Effect.Effect<
      A,
      Err | PlanError,
      Exclude<R, ServicesOfAll<Tasks[number]>>
    >;

  return {
    [AppTypeId]: AppTypeId,
    get: (name) => Option.fromUndefinedOr(byName.get(name)),
    plan: (name, input) =>
      Effect.gen(function* planByName() {
        const task = yield* find(name);
        return yield* plan(task, yield* decode(task, input));
      }).pipe(provide) as Effect.Effect<
        Plan<unknown, unknown, unknown>,
        unknown
      >,
    resume: (runId, responses = {}) =>
      Effect.gen(function* resumeByName() {
        const { run } = yield* status(runId);
        const task = yield* find(run.task);
        return yield* resume(task, runId, { responses });
      }).pipe(provide) as Effect.Effect<AnyOutcome, unknown, RunStore>,
    runs: Effect.flatMap(RunStore, (store) => store.listRuns),
    search: (query) => {
      const needle = query.toLowerCase();
      return tasks.filter((task) =>
        [task.name, task.description ?? "", ...task.labels].some((text) =>
          text.toLowerCase().includes(needle)
        )
      );
    },
    start: (name, input) =>
      Effect.gen(function* startByName() {
        const task = yield* find(name);
        return yield* start(task, yield* decode(task, input));
      }).pipe(provide) as Effect.Effect<AnyOutcome, unknown, RunStore>,
    status,
    tasks,
  };
};
