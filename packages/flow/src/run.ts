/** Execution: one fiber per node, each waiting on its dependencies. */
import { Deferred, Effect, Exit, Schema } from "effect";

import type { Plan } from "./plan.ts";
import { Outputs } from "./services.ts";

/**
 * Execute a plan: one fiber per node, each waiting on its dependencies before
 * running. Outputs are checked against the Task's output schema. The first
 * failure interrupts the rest; dependents of a failed node never start.
 */
export const run = <A, E, R>(
  self: Plan<A, E, R>
): Effect.Effect<A, E | Schema.SchemaError, R> =>
  Effect.gen(function* runPlan() {
    const outputs = new Map<string, unknown>();
    const done = new Map<string, Deferred.Deferred<null, unknown>>();
    for (const key of self.order) {
      done.set(key, yield* Deferred.make<null, unknown>());
    }
    const doneOf = (key: string) => {
      const deferred = done.get(key);
      if (!deferred) {
        throw new Error(`Unknown node ${key}`);
      }
      return deferred;
    };

    yield* Effect.forEach(
      [...self.nodes.values()],
      ({ dependencies, node, run: work, task }) =>
        Effect.forEach(dependencies, (key) => Deferred.await(doneOf(key)), {
          discard: true,
        }).pipe(
          Effect.andThen(work),
          Effect.tap((output) =>
            Schema.encodeUnknownEffect(task.output)(output)
          ),
          Effect.tap((output) =>
            Effect.sync(() => outputs.set(node.key, output))
          ),
          Effect.onExit((exit) =>
            Deferred.done(
              doneOf(node.key),
              Exit.map(exit, () => null)
            )
          ),
          Effect.withSpan(`flow.${node.name}`, {
            attributes: { "flow.key": node.key },
          })
        ),
      { concurrency: "unbounded", discard: true }
    ).pipe(Effect.provideService(Outputs, outputs));

    return outputs.get(self.root);
  }) as never;
