/** Execution: one fiber per node, each waiting on its dependencies. */
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Schedule,
  Schema,
  Semaphore,
} from "effect";

import { CallError, Suspended, TaskTimeout } from "./errors.ts";
import type { PendingInput, PendingTimer } from "./errors.ts";
import { visit } from "./plan.ts";
import type { NodeEntry, Plan } from "./plan.ts";
import { Concurrency, CurrentRun, InProcessWait, Outputs } from "./services.ts";
import type { CallDeclaration } from "./services.ts";
import type { AnyTask } from "./task.ts";

const byKey = <A extends { readonly key: string }>(items: Iterable<A>) =>
  [...items].toSorted((a, b) => a.key.localeCompare(b.key));

const suspended = (
  pending: readonly PendingInput[],
  timers: readonly PendingTimer[]
) =>
  new Suspended({
    message: `Waiting for ${[
      ...pending.map((input) => input.key),
      ...timers.map(
        (timer) => `${timer.key} until ${new Date(timer.wakeAt).toISOString()}`
      ),
    ].join(", ")}`,
    pending,
    timers,
  });

/** A failure caused only by waiting on Inputs or Timers. */
const isSuspension = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  return (
    Option.isSome(error) &&
    error.value instanceof Suspended &&
    !Cause.hasDies(cause)
  );
};

export interface RunOptions {
  /** Responses to Input nodes, by node key, JSON-encoded. */
  readonly responses?: Readonly<Record<string, unknown>>;
}

/**
 * Where a run finds finished outputs and Input responses, and records what
 * happens to each node. Values are JSON-encoded through the Task's schemas.
 */
export interface Journal {
  /** The output of a node that finished in an earlier attempt. */
  readonly output: (
    key: string
  ) => Effect.Effect<Option.Option<unknown>, unknown>;
  readonly response: (
    key: string
  ) => Effect.Effect<Option.Option<unknown>, unknown>;
  readonly started: (key: string) => Effect.Effect<void, unknown>;
  readonly succeeded: (
    key: string,
    output: unknown
  ) => Effect.Effect<void, unknown>;
  readonly failed: (key: string, error: string) => Effect.Effect<void, unknown>;
  /** The node can't finish until an Input is answered or a Timer wakes. */
  readonly waiting: (key: string) => Effect.Effect<void, unknown>;
  /** A Timer's wake time: the stored one, or else `wakeAt`, now stored. */
  readonly timer: (
    key: string,
    wakeAt: number
  ) => Effect.Effect<number, unknown>;
  readonly edge: (
    from: string,
    to: string,
    kind: "after" | "call"
  ) => Effect.Effect<void, unknown>;
}

/** A journal that remembers nothing; responses come from `options`. */
const ephemeral = (options: RunOptions): Journal => {
  const responses = options.responses ?? {};
  const timers = new Map<string, number>();
  return {
    edge: () => Effect.void,
    failed: () => Effect.void,
    output: () => Effect.succeedNone,
    response: (key) =>
      Effect.succeed(
        Object.hasOwn(responses, key)
          ? Option.some(responses[key])
          : Option.none()
      ),
    started: () => Effect.void,
    succeeded: () => Effect.void,
    timer: (key, wakeAt) =>
      Effect.sync(() => {
        const stored = timers.get(key) ?? wakeAt;
        timers.set(key, stored);
        return stored;
      }),
    waiting: () => Effect.void,
  };
};

/**
 * `run`, reading and recording through `journal`. A node with an output in
 * the journal returns it without running its work.
 */
export const runWith = <A, E, R>(
  self: Plan<A, E, R>,
  journal: Journal
): Effect.Effect<A, E | Schema.SchemaError | Suspended, R> =>
  Effect.gen(function* runPlan() {
    const pending = new Map<string, PendingInput>();
    const timers = new Map<string, PendingTimer>();
    const scope = yield* Effect.scope;
    const entries = new Map<string, NodeEntry>(self.nodes);
    const outputs = new Map<string, unknown>();
    const done = new Map<string, Deferred.Deferred<null, unknown>>();
    const finished = new Set<string>();
    /** Calls in flight: caller key to the keys it is waiting on. */
    const waiting = new Map<string, Map<string, number>>();
    const counts = new Map<CallDeclaration, number>();
    const planning = yield* Semaphore.make(1);

    // Concurrency slots: one for the run's limit and one per Task with a
    // limit. A node holds its slots while working and lets go of them while
    // it waits on a call, so callers can't starve the nodes they call.
    const limit = yield* Concurrency;
    const runSlot =
      limit === "unbounded" ? undefined : yield* Semaphore.make(limit);
    const taskSlots = new Map<string, Semaphore.Semaphore>();
    const slotsOf = new Map<string, readonly Semaphore.Semaphore[]>();
    const holding = new Map<string, Semaphore.Semaphore[]>();

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

    const slotsFor = (key: string, task: AnyTask) =>
      Effect.gen(function* slots() {
        const list: Semaphore.Semaphore[] = runSlot ? [runSlot] : [];
        const { concurrency } = task.execution;
        if (concurrency !== undefined) {
          let slot = taskSlots.get(task.name);
          if (!slot) {
            slot = yield* Semaphore.make(concurrency);
            taskSlots.set(task.name, slot);
          }
          list.push(slot);
        }
        slotsOf.set(key, list);
        return list;
      });

    /** Take `key`'s slots, recording each as it is taken. */
    const occupy = (key: string) =>
      Effect.forEach(
        slotsOf.get(key) ?? [],
        (slot) =>
          Effect.uninterruptibleMask((restore) =>
            restore(slot.take(1)).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  const held = holding.get(key) ?? [];
                  held.push(slot);
                  holding.set(key, held);
                })
              )
            )
          ),
        { discard: true }
      );

    /** Give back whatever slots `key` holds. */
    const vacate = (key: string) =>
      Effect.suspend(() => {
        const held = holding.get(key) ?? [];
        holding.delete(key);
        return Effect.forEach(held.toReversed(), (slot) => slot.release(1), {
          discard: true,
        });
      });

    /** An Input's response, or `Suspended` if there is none yet. */
    const answer = ({ node, task }: Pick<NodeEntry, "node" | "task">) => {
      const wait = (rejected?: string) => {
        const input: PendingInput = {
          description: node.description,
          key: node.key,
          name: node.name,
          request: node.input,
          ...(rejected === undefined ? {} : { rejected }),
        };
        pending.set(node.key, input);
        return Effect.fail(suspended([input], []));
      };
      return Effect.flatMap(journal.response(node.key), (response) =>
        Option.isNone(response)
          ? wait()
          : Schema.decodeUnknownEffect(Schema.toCodecJson(task.output))(
              response.value
            ).pipe(
              Effect.catchTag("SchemaError", (failure) => wait(failure.message))
            )
      );
    };

    /** A Timer's wake time once it has passed, or `Suspended` until then. */
    const wake = ({ node, task }: Pick<NodeEntry, "node" | "task">) =>
      Effect.gen(function* wakeTimer() {
        const input = yield* Schema.decodeUnknownEffect(
          Schema.toCodecJson(task.input)
        )(node.input);
        const now = yield* Clock.currentTimeMillis;
        const wait = Duration.toMillis(
          Duration.fromInputUnsafe(task.wait?.(input) ?? 0)
        );
        const wakeAt = yield* journal.timer(node.key, now + wait);
        const remaining = wakeAt - now;
        if (remaining > Duration.toMillis(yield* InProcessWait)) {
          const timer: PendingTimer = {
            key: node.key,
            name: node.name,
            wakeAt,
          };
          timers.set(node.key, timer);
          return yield* suspended([], [timer]);
        }
        if (remaining > 0) {
          yield* Effect.sleep(Duration.millis(remaining));
        }
        return wakeAt;
      });

    /** One attempt at a Task's work, within its slots and timeout. */
    const attempt = ({ node, run: work, task }: NodeEntry) => {
      const { timeout } = task.execution;
      const timed =
        timeout === undefined
          ? work
          : Effect.timeoutOrElse(work, {
              duration: timeout,
              orElse: () =>
                Effect.fail(
                  new TaskTimeout({
                    key: node.key,
                    message: `${node.key} took longer than ${Duration.format(Duration.fromInputUnsafe(timeout))}`,
                  })
                ),
            });
      return Effect.flatMap(slotsFor(node.key, task), () =>
        occupy(node.key).pipe(
          Effect.andThen(timed),
          Effect.ensuring(vacate(node.key))
        )
      );
    };

    /** What a node does: answer an Input, wake a Timer, or do work. */
    const bodyOf = (entry: NodeEntry) => {
      switch (entry.task.kind) {
        case "input": {
          return answer(entry);
        }
        case "timer": {
          return wake(entry);
        }
        default: {
          return attempt(entry);
        }
      }
    };

    /** Run a node's work, or answer or wake it, and record the outcome. */
    const perform = (entry: NodeEntry) => {
      const { node, task } = entry;
      const codec = Schema.toCodecJson(task.output);
      const body = bodyOf(entry);
      const once = journal.started(node.key).pipe(
        Effect.andThen(body),
        Effect.tap((output) =>
          Effect.flatMap(Schema.encodeUnknownEffect(codec)(output), (encoded) =>
            journal.succeeded(node.key, encoded)
          )
        ),
        Effect.tapCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.void;
          }
          return isSuspension(cause)
            ? journal.waiting(node.key)
            : journal.failed(node.key, Cause.pretty(cause));
        })
      );
      const { retry } = task.execution;
      const fresh =
        retry === undefined
          ? once
          : Effect.retry(once, {
              times: retry.times,
              while: (error: unknown) => !(error instanceof Suspended),
              ...(retry.delay === undefined
                ? {}
                : { schedule: Schedule.spaced(retry.delay) }),
            });
      return Effect.flatMap(journal.output(node.key), (stored) =>
        Option.isSome(stored)
          ? Schema.decodeUnknownEffect(codec)(stored.value)
          : fresh
      );
    };

    const execute = (entry: NodeEntry, caller?: string) =>
      Effect.forEach(
        entry.dependencies,
        (key) =>
          journal
            .edge(key, entry.node.key, "after")
            .pipe(Effect.andThen(Deferred.await(doneOf(key)))),
        { discard: true }
      ).pipe(
        Effect.andThen(perform(entry)),
        Effect.tap((output) =>
          Effect.sync(() => outputs.set(entry.node.key, output))
        ),
        Effect.onExit((exit) =>
          Effect.sync(() => finished.add(entry.node.key)).pipe(
            Effect.andThen(
              Deferred.done(
                doneOf(entry.node.key),
                Exit.map(exit, () => null)
              )
            )
          )
        ),
        Effect.withSpan(`flow.${entry.node.name}`, {
          attributes:
            caller === undefined
              ? { "flow.key": entry.node.key }
              : { "flow.caller": caller, "flow.key": entry.node.key },
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
        yield* journal.edge(caller, key, "call");
        yield* track(caller, key, 1);
        // Let go of the caller's slots while it waits, then take them back.
        yield* vacate(caller);
        const exit = yield* Deferred.await(doneOf(key)).pipe(
          Effect.andThen(Effect.sync(() => outputs.get(key))),
          Effect.ensuring(track(caller, key, -1)),
          Effect.exit
        );
        yield* occupy(caller);
        return yield* exit;
      });

    // A suspended node doesn't stop its siblings: its dependents and callers
    // suspend through it, and everything else runs on. Real failures still
    // interrupt the run.
    yield* Effect.forEach(
      [...self.nodes.values()],
      (entry) =>
        execute(entry).pipe(
          Effect.catchCauseIf(isSuspension, () => Effect.void)
        ),
      { concurrency: "unbounded", discard: true }
    ).pipe(
      Effect.provideService(Outputs, outputs),
      Effect.provideService(CurrentRun, { call })
    );
    if (pending.size > 0 || timers.size > 0) {
      return yield* suspended(byKey(pending.values()), byKey(timers.values()));
    }
    return outputs.get(self.root);
  }).pipe(Effect.scoped) as never;

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
 * with the Input's output schema. Timers wait in the process when due soon.
 * If the run reaches an Input without a response or a Timer that isn't due,
 * it fails with `Suspended` listing what it is waiting for, even if a caller
 * handled that failure.
 */
export const run = <A, E, R>(
  self: Plan<A, E, R>,
  options: RunOptions = {}
): Effect.Effect<A, E | Schema.SchemaError | Suspended, R> =>
  runWith(self, ephemeral(options));
