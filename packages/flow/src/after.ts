import { Effect } from "effect";

import type { PlanError } from "./errors.ts";
import { Outputs, Planner } from "./services.ts";
import type {
  AnyTask,
  ErrorOf,
  InputArgs,
  OutputOf,
  ServicesOf,
} from "./task.ts";

/** A declared upstream node. */
export interface Upstream<A> {
  readonly key: string;
  /** The upstream output. Only valid inside `run`. */
  readonly output: Effect.Effect<A>;
}

/**
 * Declare that the current Task runs after `task` applied to `input`.
 *
 * The upstream Task's errors and services appear in this Effect's channels so
 * that `Task` can carry them; planning never fails with those errors itself.
 */
export const After = <T extends AnyTask>(
  task: T,
  ...[input]: InputArgs<T>
): Effect.Effect<
  Upstream<OutputOf<T>>,
  PlanError | ErrorOf<T>,
  Planner | ServicesOf<T>
> =>
  Effect.gen(function* after() {
    const planner = yield* Planner;
    const key = yield* planner.after(task, input);
    const output = Effect.flatMap(Outputs, (outputs) =>
      outputs.has(key)
        ? Effect.succeed(outputs.get(key) as OutputOf<T>)
        : Effect.die(
            new Error(
              `Output of ${key} read before it finished; read it in run`
            )
          )
    );
    return { key, output };
  });
