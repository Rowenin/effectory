/** Where durable runs keep their state between processes. */
import { Context, Effect, Layer, Option } from "effect";

import { StoreError } from "./errors.ts";
import type { PendingInput } from "./errors.ts";

export type RunStatus = "running" | "suspended" | "succeeded" | "failed";

export interface RunRecord {
  readonly id: string;
  /** Name of the root Task. */
  readonly task: string;
  /** The root Task's input, JSON-encoded. */
  readonly input: unknown;
  /** Hash of the static plan; resuming refuses a different one. */
  readonly fingerprint: string;
  readonly status: RunStatus;
  /** Inputs waiting for a response while `suspended`. */
  readonly pending: readonly PendingInput[];
  /** The root's JSON-encoded output once `succeeded`. */
  readonly output?: unknown;
  /** What went wrong once `failed`. */
  readonly error?: string;
}

/**
 * `running` with no later record means the node was cut off mid-work.
 * `waiting` means it can't finish until a pending Input is answered.
 */
export type NodeStatus = "running" | "waiting" | "succeeded" | "failed";

export interface NodeRecord {
  readonly key: string;
  readonly status: NodeStatus;
  /** Times the node's work started in this run. */
  readonly attempts: number;
  /** The JSON-encoded output once `succeeded`. */
  readonly output?: unknown;
  readonly error?: string;
}

/**
 * Persistence for durable runs. Values are stored JSON-encoded through their
 * schemas, so any store that keeps JSON can hold them.
 */
export class RunStore extends Context.Service<
  RunStore,
  {
    readonly createRun: (run: RunRecord) => Effect.Effect<void, StoreError>;
    readonly getRun: (
      id: string
    ) => Effect.Effect<Option.Option<RunRecord>, StoreError>;
    readonly updateRun: (
      id: string,
      update: Pick<RunRecord, "status" | "pending"> &
        Partial<Pick<RunRecord, "output" | "error">>
    ) => Effect.Effect<void, StoreError>;
    readonly getNode: (
      runId: string,
      key: string
    ) => Effect.Effect<Option.Option<NodeRecord>, StoreError>;
    readonly putNode: (
      runId: string,
      node: NodeRecord
    ) => Effect.Effect<void, StoreError>;
    readonly listNodes: (
      runId: string
    ) => Effect.Effect<readonly NodeRecord[], StoreError>;
    /**
     * Record a response, replacing an earlier one. `resume` only accepts
     * responses for pending Inputs, so a consumed response is never replaced.
     */
    readonly putResponse: (
      runId: string,
      key: string,
      value: unknown
    ) => Effect.Effect<void, StoreError>;
    readonly getResponse: (
      runId: string,
      key: string
    ) => Effect.Effect<Option.Option<unknown>, StoreError>;
    /**
     * Take or extend the lease on a run until `until` (epoch ms). Succeeds
     * with `false` if another owner holds a lease that hasn't expired at
     * `now`.
     */
    readonly claim: (
      runId: string,
      owner: string,
      options: { readonly now: number; readonly until: number }
    ) => Effect.Effect<boolean, StoreError>;
    /** Give up `owner`'s lease on a run, if it still holds it. */
    readonly release: (
      runId: string,
      owner: string
    ) => Effect.Effect<void, StoreError>;
  }
>()("effectory/flow/RunStore") {}

/** A store that lives as long as the layer; for tests and one-off runs. */
export const layerMemory: Layer.Layer<RunStore> = Layer.sync(RunStore)(() => {
  const runs = new Map<string, RunRecord>();
  const nodes = new Map<string, Map<string, NodeRecord>>();
  const responses = new Map<string, Map<string, unknown>>();
  const leases = new Map<string, { owner: string; until: number }>();
  const nodesOf = (runId: string) => {
    const map = nodes.get(runId) ?? new Map<string, NodeRecord>();
    nodes.set(runId, map);
    return map;
  };
  const responsesOf = (runId: string) => {
    const map = responses.get(runId) ?? new Map<string, unknown>();
    responses.set(runId, map);
    return map;
  };
  return RunStore.of({
    claim: (runId, owner, { now, until }) =>
      Effect.sync(() => {
        const lease = leases.get(runId);
        if (lease && lease.owner !== owner && lease.until >= now) {
          return false;
        }
        leases.set(runId, { owner, until });
        return true;
      }),
    createRun: (run) =>
      runs.has(run.id)
        ? Effect.fail(new StoreError({ message: `Run ${run.id} exists` }))
        : Effect.sync(() => {
            runs.set(run.id, run);
          }),
    getNode: (runId, key) =>
      Effect.sync(() => Option.fromUndefinedOr(nodesOf(runId).get(key))),
    getResponse: (runId, key) =>
      Effect.sync(() => {
        const map = responsesOf(runId);
        return map.has(key) ? Option.some(map.get(key)) : Option.none();
      }),
    getRun: (id) => Effect.sync(() => Option.fromUndefinedOr(runs.get(id))),
    listNodes: (runId) => Effect.sync(() => [...nodesOf(runId).values()]),
    putNode: (runId, node) =>
      Effect.sync(() => {
        nodesOf(runId).set(node.key, node);
      }),
    putResponse: (runId, key, value) =>
      Effect.sync(() => {
        responsesOf(runId).set(key, value);
      }),
    release: (runId, owner) =>
      Effect.sync(() => {
        if (leases.get(runId)?.owner === owner) {
          leases.delete(runId);
        }
      }),
    updateRun: (id, update) =>
      Effect.suspend(() => {
        const run = runs.get(id);
        if (!run) {
          return Effect.fail(new StoreError({ message: `No run ${id}` }));
        }
        const { error: _error, output: _output, ...rest } = run;
        runs.set(id, { ...rest, ...update });
        return Effect.void;
      }),
  });
});
