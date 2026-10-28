/** Execution: one fiber per node, each waiting on its dependencies. */
import { Deferred, Effect, Exit, Schema, Semaphore } from "effect";

import { CallError, Suspended } from "./errors.ts";
import type { PendingInput } from "./errors.ts";
import { visit } from "./plan.ts";
import type { NodeEntry, Plan } from "./plan.ts";
import { CurrentRun, Outputs } from "./services.ts";
import type { CallDeclaration } from "./services.ts";

const suspended = (pending: readonly PendingInput[]) =>
  new Suspended({
    message: `Waiting for ${pending.map((input) => input.key).join(", ")}`,
    pending,
  });

export interface RunOptions {
  /** Responses to Input nodes, by node key, in their encoded form. */
  readonly responses?: Readonly<Record<string, unknown>>;
}

/**
 * Execute a plan: one fiber per node, each waiting on its dependencies before
 * running. Outputs are checked against the Task's output schema. The first
 * failure of a planned node interrupts the rest; dependents of a failed node
 * never start.
 *
 * Declared calls plan their node when made and run it in the same run. A
 * failed call fails only its caller, which may handle it.
 *
 * Input nodes are answered from `responses`, keyed by node key and decoded
 * with the Input's output schema. If the run reaches an Input without a
 * response, it fails with `Suspended` listing what it is waiting for, even if
 * a caller handled that Input's failure.
 */
export const run = <A, E, R>(
  self: Plan<A, E, R>,
  options: RunOptions = {}
): Effect.Effect<A, E | Schema.SchemaError | Suspended, R> =>
  Effect.gen(function* runPlan() {
    const responses = options.responses ?? {};
    const pending = new Map<string, PendingInput>();
    const scope = yield* Effect.scope;
    const entries = new Map<string, NodeEntry>(self.nodes);
    const outputs = new Map<string, unknown>();
    const done = new Map<string, Deferred.Deferred<null, unknown>>();
    const finished = new Set<string>();
    /** Calls in flight: caller key to the keys it is waiting on. */
    const waiting = new Map<string, Map<string, number>>();
    const counts = new Map<CallDeclaration, number>();
    const planning = yield* Semaphore.make(1);

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

    /** An Input's response, or `Suspended` if there is none yet. */
    const answer = ({ node, task }: Pick<NodeEntry, "node" | "task">) =>
      Object.hasOwn(responses, node.key)
        ? Schema.decodeUnknownEffect(task.output)(responses[node.key])
        : Effect.suspend(() => {
            const input: PendingInput = {
              description: node.description,
              key: node.key,
              name: node.name,
              request: node.input,
            };
            pending.set(node.key, input);
            return Effect.fail(suspended([input]));
          });

    const execute = (
      { dependencies, node, run: work, task }: NodeEntry,
      caller?: string
    ) =>
      Effect.forEach(dependencies, (key) => Deferred.await(doneOf(key)), {
        discard: true,
      }).pipe(
        Effect.andThen(task.kind === "input" ? answer({ node, task }) : work),
        Effect.tap((output) => Schema.encodeUnknownEffect(task.output)(output)),
        Effect.tap((output) =>
          Effect.sync(() => outputs.set(node.key, output))
        ),
        Effect.onExit((exit) =>
          Effect.sync(() => finished.add(node.key)).pipe(
            Effect.andThen(
              Deferred.done(
                doneOf(node.key),
                Exit.map(exit, () => null)
              )
            )
          )
        ),
        Effect.withSpan(`flow.${node.name}`, {
          attributes:
            caller === undefined
              ? { "flow.key": node.key }
              : { "flow.caller": caller, "flow.key": node.key },
        })
      );

    /** Unfinished nodes `from` waits on: its dependencies and calls. */
    const waitsOn = (from: string) => [
      ...(entries.get(from)?.dependencies ?? []),
      ...(waiting.get(from)?.keys() ?? []),
    ];

    /** A path of unfinished nodes from `from` to `to`, if one exists. */
    const pathTo = (
      from: string,
      to: string,
      seen = new Set<string>()
    ): string[] | undefined => {
      if (from === to) {
        return [to];
      }
      if (finished.has(from) || seen.has(from)) {
        return undefined;
      }
      seen.add(from);
      for (const next of waitsOn(from)) {
        const rest = pathTo(next, to, seen);
        if (rest) {
          return [from, ...rest];
        }
      }
      return undefined;
    };

    const track = (caller: string, key: string, delta: 1 | -1) =>
      Effect.sync(() => {
        const calls = waiting.get(caller) ?? new Map<string, number>();
        const count = (calls.get(key) ?? 0) + delta;
        if (count > 0) {
          calls.set(key, count);
        } else {
          calls.delete(key);
        }
        waiting.set(caller, calls);
      });

    const call = (declaration: CallDeclaration, input: unknown) =>
      Effect.gen(function* callTask() {
        const { caller, max, task } = declaration;
        const count = (counts.get(declaration) ?? 0) + 1;
        counts.set(declaration, count);
        if (max !== undefined && count > max) {
          return yield* new CallError({
            message: `${caller} called ${task.name} more than ${max} times`,
            reason: "limit",
          });
        }

        const key = yield* planning.withPermits(1)(
          Effect.gen(function* planCall() {
            const before = new Set(entries.keys());
            const planned = yield* visit(entries, task, input).pipe(
              Effect.mapError(
                (cause) =>
                  new CallError({
                    cause,
                    message: `${caller} could not plan a call to ${task.name}`,
                    reason: "plan",
                  })
              )
            );
            const added = [...entries.values()].filter(
              (entry) => !before.has(entry.node.key)
            );
            for (const entry of added) {
              done.set(entry.node.key, yield* Deferred.make<null, unknown>());
            }
            for (const entry of added) {
              yield* Effect.forkIn(
                execute(entry, caller).pipe(Effect.ignore),
                scope
              );
            }
            return planned;
          })
        );

        const cycle = pathTo(key, caller);
        if (cycle) {
          return yield* new CallError({
            message: `Call cycle: ${[caller, ...cycle].join(" -> ")}`,
            reason: "cycle",
          });
        }
        yield* track(caller, key, 1);
        return yield* Deferred.await(doneOf(key)).pipe(
          Effect.andThen(Effect.sync(() => outputs.get(key))),
          Effect.ensuring(track(caller, key, -1))
        );
      });

    const exit = yield* Effect.forEach(
      [...self.nodes.values()],
      (entry) => execute(entry),
      {
        concurrency: "unbounded",
        discard: true,
      }
    ).pipe(
      Effect.provideService(Outputs, outputs),
      Effect.provideService(CurrentRun, { call }),
      Effect.exit
    );
    if (pending.size > 0) {
      return yield* suspended([...pending.values()]);
    }
    return yield* Effect.map(exit, () => outputs.get(self.root));
  }).pipe(Effect.scoped) as never;
