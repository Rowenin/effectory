/**
 * Durable runs: `start` and `resume` run a plan through a `RunStore`, so a
 * run can stop at its Inputs and continue in a later process without
 * repeating finished nodes.
 */
import { randomUUID } from "node:crypto";

import {
  Cause,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  Option,
  Schedule,
  Schema,
} from "effect";

import { Suspended } from "./errors.ts";
import type {
  PendingInput,
  PendingTimer,
  PlanError,
  StoreError,
} from "./errors.ts";
import { fingerprint, plan } from "./plan.ts";
import type { Plan } from "./plan.ts";
import { runWith } from "./run.ts";
import type { Journal } from "./run.ts";
import { RunStore } from "./store.ts";
import type { EdgeRecord, NodeRecord, RunRecord } from "./store.ts";
import type {
  AnyTask,
  ErrorOf,
  InputArgs,
  OutputOf,
  ServicesOf,
} from "./task.ts";

/** How a durable run ended this time. */
export type Outcome<A, E> =
  | {
      readonly _tag: "Succeeded";
      readonly runId: string;
      readonly output: A;
    }
  | {
      readonly _tag: "Suspended";
      readonly runId: string;
      readonly pending: readonly PendingInput[];
      readonly timers: readonly PendingTimer[];
    }
  | {
      readonly _tag: "Failed";
      readonly runId: string;
      readonly cause: Cause.Cause<E>;
    };

export class ResumeError extends Data.TaggedError("ResumeError")<{
  readonly reason:
    | "not-found"
    | "task-mismatch"
    | "plan-changed"
    | "unexpected-response"
    | "busy";
  readonly message: string;
  readonly runId: string;
}> {}

/**
 * How long a process's claim on a run lasts without renewal. The owner renews
 * it while running; after a crash, the run can be resumed once it lapses.
 */
export const LeaseTime = Context.Reference<Duration.Duration>(
  "effectory/flow/LeaseTime",
  { defaultValue: () => Duration.seconds(30) }
);

/**
 * Hold the lease on `runId` for the rest of the scope, renewing it as it
 * goes, or fail with `"busy"` if another process holds it.
 */
const own = (runId: string) =>
  Effect.gen(function* ownRun() {
    const store = yield* RunStore;
    const owner = randomUUID();
    const lease = Duration.toMillis(yield* LeaseTime);
    const claim = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      store.claim(runId, owner, { now, until: now + lease })
    );
    if (!(yield* claim)) {
      return yield* new ResumeError({
        message: `Run ${runId} is being run by another process`,
        reason: "busy",
        runId,
      });
    }
    yield* Effect.addFinalizer(() =>
      Effect.ignore(store.release(runId, owner))
    );
    yield* Effect.forkScoped(
      Effect.repeat(claim, Schedule.spaced(Duration.millis(lease / 3)))
    );
  });

export interface ResumeOptions {
  /** Responses to the run's pending Inputs, by key, JSON-encoded. */
  readonly responses?: Readonly<Record<string, unknown>>;
}

export interface RunState {
  readonly run: RunRecord;
  readonly nodes: readonly NodeRecord[];
  /** Edges the run followed: dependencies and calls. */
  readonly edges: readonly EdgeRecord[];
}

type DurableEffect<T extends AnyTask, E = never> = Effect.Effect<
  Outcome<OutputOf<T>, ErrorOf<T> | Schema.SchemaError>,
  E | PlanError | ErrorOf<T> | StoreError | Schema.SchemaError,
  RunStore | ServicesOf<T>
>;

/** Read and record a run's nodes in the store. */
const journalOf = (store: RunStore["Service"], runId: string): Journal => {
  const node = (key: string) =>
    Effect.map(store.getNode(runId, key), Option.getOrUndefined);
  /** Write a node's new state, keeping its attempts and wake time. */
  const put = (
    key: string,
    update: (previous: NodeRecord | undefined) => Omit<NodeRecord, "key">
  ) =>
    Effect.flatMap(node(key), (previous) =>
      store.putNode(runId, {
        key,
        ...(previous?.wakeAt === undefined ? {} : { wakeAt: previous.wakeAt }),
        ...update(previous),
      })
    );
  return {
    edge: (from, to, kind) => store.putEdge(runId, { from, kind, to }),
    failed: (key, error) =>
      put(key, (previous) => ({
        attempts: previous?.attempts ?? 0,
        error,
        status: "failed",
      })),
    output: (key) =>
      Effect.map(node(key), (previous) =>
        previous?.status === "succeeded"
          ? Option.some(previous.output)
          : Option.none()
      ),
    response: (key) => store.getResponse(runId, key),
    started: (key) =>
      put(key, (previous) => ({
        attempts: (previous?.attempts ?? 0) + 1,
        status: "running",
      })),
    succeeded: (key, output) =>
      put(key, (previous) => ({
        attempts: previous?.attempts ?? 1,
        output,
        status: "succeeded",
      })),
    timer: (key, wakeAt) =>
      Effect.flatMap(node(key), (previous) =>
        previous?.wakeAt === undefined
          ? Effect.as(
              store.putNode(runId, {
                attempts: previous?.attempts ?? 0,
                key,
                status: previous?.status ?? "running",
                wakeAt,
              }),
              wakeAt
            )
          : Effect.succeed(previous.wakeAt)
      ),
    waiting: (key) =>
      put(key, (previous) => ({
        attempts: previous?.attempts ?? 0,
        status: "waiting",
      })),
  };
};

/** Run `self` for `runId` and record how it ended. */
const drive = <T extends AnyTask>(
  task: T,
  runId: string,
  self: Plan<unknown, unknown, unknown>
) =>
  Effect.gen(function* driveRun() {
    const store = yield* RunStore;
    const exit = yield* Effect.exit(runWith(self, journalOf(store, runId)));
    if (Exit.isSuccess(exit)) {
      const output = yield* Schema.encodeUnknownEffect(
        Schema.toCodecJson(task.output)
      )(exit.value);
      yield* store.updateRun(runId, {
        output,
        pending: [],
        status: "succeeded",
        timers: [],
      });
      return { _tag: "Succeeded", output: exit.value, runId } as const;
    }
    const error = Cause.findErrorOption(exit.cause);
    if (Option.isSome(error) && error.value instanceof Suspended) {
      const { pending, timers } = error.value;
      yield* store.updateRun(runId, { pending, status: "suspended", timers });
      return { _tag: "Suspended", pending, runId, timers } as const;
    }
    if (Cause.hasInterruptsOnly(exit.cause)) {
      // Left `running`: resuming continues where it was cut off.
      return yield* Effect.interrupt;
    }
    yield* store.updateRun(runId, {
      error: Cause.pretty(exit.cause),
      pending: [],
      status: "failed",
      timers: [],
    });
    return { _tag: "Failed", cause: exit.cause, runId } as const;
  });

/**
 * Plan `task(input)` and run it as a new durable run. Returns how it ended,
 * with the run id to resume it by.
 */
export const start = <T extends AnyTask>(
  task: T,
  ...[input]: InputArgs<T>
): DurableEffect<T> =>
  Effect.gen(function* startRun() {
    const store = yield* RunStore;
    const planned = yield* plan(task, input);
    const encoded = yield* Schema.encodeUnknownEffect(
      Schema.toCodecJson(task.input)
    )(input);
    const runId = randomUUID();
    yield* store.createRun({
      fingerprint: fingerprint(planned),
      id: runId,
      input: encoded,
      pending: [],
      status: "running",
      task: task.name,
      timers: [],
    });
    yield* own(runId);
    return yield* drive(task, runId, planned);
  }).pipe(Effect.scoped) as never;

/**
 * Continue run `runId` of `task`, first recording `responses` for its pending
 * Inputs. Finished nodes return their stored outputs; failed and unfinished
 * nodes run again. A run that already succeeded returns its output.
 */
export const resume = <T extends AnyTask>(
  task: T,
  runId: string,
  options: ResumeOptions = {}
): DurableEffect<T, ResumeError> =>
  Effect.gen(function* resumeRun() {
    const store = yield* RunStore;
    const fail = (reason: ResumeError["reason"], message: string) =>
      Effect.fail(new ResumeError({ message, reason, runId }));

    const found = yield* store.getRun(runId);
    if (Option.isNone(found)) {
      return yield* fail("not-found", `No run ${runId}`);
    }
    const run = found.value;
    if (run.task !== task.name) {
      return yield* fail(
        "task-mismatch",
        `Run ${runId} is of ${run.task}, not ${task.name}`
      );
    }
    if (run.status === "succeeded") {
      const output = yield* Schema.decodeUnknownEffect(
        Schema.toCodecJson(task.output)
      )(run.output);
      return { _tag: "Succeeded", output, runId } as const;
    }

    const responses = Object.entries(options.responses ?? {});
    const pending = new Set(run.pending.map((input) => input.key));
    const unexpected = responses.filter(([key]) => !pending.has(key));
    if (unexpected.length > 0) {
      return yield* fail(
        "unexpected-response",
        `Run ${runId} is not waiting for ${unexpected.map(([key]) => key).join(", ")}`
      );
    }

    const input = yield* Schema.decodeUnknownEffect(
      Schema.toCodecJson(task.input)
    )(run.input);
    const planned = yield* plan(task, input);
    if (fingerprint(planned) !== run.fingerprint) {
      return yield* fail(
        "plan-changed",
        `The plan for run ${runId} changed since it started`
      );
    }

    yield* own(runId);
    yield* Effect.forEach(responses, ([key, value]) =>
      store.putResponse(runId, key, value)
    );
    yield* store.updateRun(runId, {
      pending: [],
      status: "running",
      timers: [],
    });
    return yield* drive(task, runId, planned);
  }).pipe(Effect.scoped) as never;

/** A run's record and the state of each node it reached. */
export const status = (
  runId: string
): Effect.Effect<RunState, StoreError | ResumeError, RunStore> =>
  Effect.gen(function* runStatus() {
    const store = yield* RunStore;
    const run = yield* store.getRun(runId);
    if (Option.isNone(run)) {
      return yield* new ResumeError({
        message: `No run ${runId}`,
        reason: "not-found",
        runId,
      });
    }
    return {
      edges: yield* store.listEdges(runId),
      nodes: yield* store.listNodes(runId),
      run: run.value,
    };
  });

const mermaidLabel = (text: string) =>
  text
    .replaceAll('"', "#quot;")
    .replaceAll("(", "#40;")
    .replaceAll(")", "#41;");

const statusClasses = {
  failed: "fill:#ffe3e3,stroke:#e03131",
  running: "fill:#e7f5ff,stroke:#1c7ed6",
  succeeded: "fill:#ebfbee,stroke:#2f9e44",
  waiting: "fill:#fff9db,stroke:#f08c00",
} as const;

/**
 * Render what a run did as a Mermaid flowchart: every node it reached, styled
 * by status, with solid edges for dependencies and dashed edges for calls.
 */
export const toMermaidRun = (state: RunState): string => {
  const ids = new Map<string, string>();
  const idOf = (key: string) => {
    let id = ids.get(key);
    if (id === undefined) {
      id = `n${ids.size}`;
      ids.set(key, id);
    }
    return id;
  };
  const lines = ["flowchart TD"];
  for (const node of state.nodes) {
    const attempts = node.attempts > 1 ? ` ×${node.attempts}` : "";
    lines.push(
      `  ${idOf(node.key)}["${mermaidLabel(node.key)}<br/>${node.status}${attempts}"]:::${node.status}`
    );
  }
  for (const edge of state.edges) {
    lines.push(
      `  ${idOf(edge.from)} ${edge.kind === "call" ? "-.->" : "-->"} ${idOf(edge.to)}`
    );
  }
  for (const [className, style] of Object.entries(statusClasses)) {
    lines.push(`  classDef ${className} ${style}`);
  }
  return lines.join("\n");
};
