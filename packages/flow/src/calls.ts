import { Effect } from "effect";
import type { Schema } from "effect";

import type { CallError } from "./errors.ts";
import { PlanError } from "./errors.ts";
import { CurrentRun, Planner } from "./services.ts";
import type {
  AnyTask,
  ErrorOf,
  InputArgs,
  OutputOf,
  ServicesOf,
} from "./task.ts";

export interface CallOptions {
  /** Most calls this node may make to the Task in one run. */
  readonly max?: number;
}

/**
 * Starts `task` applied to `input` as a node and returns its output. Only
 * valid inside `run`. The called Task's errors and services are this Effect's.
 */
export type Call<T extends AnyTask> = (
  ...args: InputArgs<T>
) => Effect.Effect<
  OutputOf<T>,
  ErrorOf<T> | CallError | Schema.SchemaError,
  ServicesOf<T>
>;

/**
 * Declare that the current Task may call `task` at run time, at most `max`
 * times. The plan records the declaration; each call becomes a node keyed by
 * its input, which is only known once `run` makes it.
 */
export const Calls = <T extends AnyTask>(
  task: T,
  options: CallOptions = {}
): Effect.Effect<Call<T>, PlanError, Planner> =>
  Effect.gen(function* calls() {
    const { max } = options;
    if (max !== undefined && !(Number.isInteger(max) && max >= 0)) {
      return yield* new PlanError({
        message: `Invalid max for calls to ${task.name}: ${max}`,
      });
    }
    const planner = yield* Planner;
    const declaration = yield* planner.calls(task, max);
    return ((...[input]: InputArgs<T>) =>
      Effect.flatMap(CurrentRun, (runtime) =>
        runtime
          ? runtime.call(declaration, input)
          : Effect.die(
              new Error(
                `${declaration.caller} called ${task.name} while planning; call it in run`
              )
            )
      )) as Call<T>;
  });
