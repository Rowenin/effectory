/* oxlint-disable max-classes-per-file -- the Registry service and NodeFailure are the node contract. */
/**
 * The engine's generic node contract. Every primitive (Action, Resource,
 * Assert, Approve, Each, ...) registers `NodeSpec`s through the `Registry`;
 * the engine schedules and persists them without knowing what they are.
 */
import { Context, Data, Effect } from "effect";
import type { Schema } from "effect";

import * as Output from "./output.ts";
import type { StateShape } from "./state.ts";

export type NodeKind =
  | "action"
  | "resource"
  | "assert"
  | "approve"
  | "each"
  | "call"
  | "data"
  | "secret";

/** `live` talks to real services; `fake` uses providers' and Actions' fakes. */
export type Mode = "live" | "fake";

export type RunIf = "succeeded" | "completed" | "failed";

/** Retention for a node's records. */
export type Keep = { readonly versions: number } | { readonly days: number };

/** Options every node accepts. */
export interface NodeOptions {
  /** Skip the node when false. */
  readonly when?: Output.Output<boolean> | boolean;
  /** Which upstream outcomes let the node run. Default `succeeded`. */
  readonly runIf?: RunIf;
  /** Record a failure without failing the run. */
  readonly allowFailure?: boolean;
  /** Extra ordering edges, for nodes that do not consume a value. */
  readonly dependsOn?: readonly unknown[];
  /** Record retention. */
  readonly keep?: Keep;
}

/** What `--plan` reports for a node. */
export interface PlannedChange {
  readonly action:
    | "run"
    | "cached"
    | "create"
    | "update"
    | "replace"
    | "noop"
    | "adopt"
    | "expand"
    | "unknown";
  readonly detail?: string;
}

/** A node's persisted status in one run. */
export type NodeStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "suspended";

export interface NodeError {
  readonly tag: string;
  readonly message: string;
}

/** Identity of the run a node belongs to. */
export interface RunInfo {
  readonly runId: string;
  readonly collection: string;
  readonly workflow: string;
  readonly scope: string;
  readonly mode: Mode;
}

export interface PlanContext extends RunInfo {
  readonly fqn: string;
  readonly state: StateShape;
  /** The node's input when it is known at plan time. */
  readonly input:
    | { readonly resolved: true; readonly value: unknown }
    | { readonly resolved: false };
}

export interface ExecContext extends RunInfo {
  readonly fqn: string;
  readonly state: StateShape;
  /** The node's input with every Output resolved. */
  readonly input: unknown;
  /** This node's status row from an earlier attempt of the same run, if any. */
  readonly previous: NodeRow | undefined;
  /**
   * Register more nodes while the run executes (dynamic `Each`, `Call`). The
   * body runs under this node's FQN (plus `namespace`), with `context`
   * provided (capture it at registration with `Effect.context()`), and its
   * nodes start immediately. Returns the body's value, which may contain
   * Outputs; pass it to `await`.
   */
  readonly expand: <A, E>(
    body: Effect.Effect<A, E, Registry>,
    options?: {
      readonly namespace?: string;
      readonly context?: Context.Context<never>;
    }
  ) => Effect.Effect<A, E | NodeFailure>;
  /** Wait for every upstream of `value` and resolve it. Fails if one has no value. */
  readonly await: <A>(
    value: A
  ) => Effect.Effect<Output.Resolved<A>, NodeFailure>;
}

export interface FinishContext extends RunInfo {
  readonly fqn: string;
  readonly state: StateShape;
  readonly value: unknown;
}

export type NodeResult =
  | { readonly _tag: "Succeeded"; readonly value: unknown }
  | { readonly _tag: "Suspended"; readonly reason: string };

export const succeeded = (value: unknown): NodeResult => ({
  _tag: "Succeeded",
  value,
});
export const suspended = (reason: string): NodeResult => ({
  _tag: "Suspended",
  reason,
});

/** A node failure the engine records; any other error is converted to one. */
// oxlint-disable-next-line unicorn/custom-error-definition -- a Data.Error with a dynamic tag, not a plain Error subclass.
export class NodeFailure extends Data.Error<{
  readonly tag: string;
  readonly message: string;
}> {}

/** The engine's view of a node. */
export interface NodeSpec {
  /** Namespace path plus logical id, e.g. `verify-pr/check/test`. */
  readonly fqn: string;
  readonly kind: NodeKind;
  /** The node's type: an Action or Resource name, `Assert`, `Approve`, ... */
  readonly type: string;
  /** Input with nested Outputs; its upstreams are the node's dependencies. */
  readonly input: unknown;
  readonly options: NodeOptions;
  /** JSON codec for the value persisted in node statuses and records. */
  readonly codec?: Schema.Codec<unknown, unknown>;
  /** Write the value as an immutable Record when the node succeeds. */
  readonly record?: boolean;
  /**
   * On resume, reuse a succeeded status (`record`) or execute again
   * (`never`, for Resources and Secrets, which re-converge).
   */
  readonly reuse: "record" | "never";
  /** Hold a concurrency permit while executing. Off for nodes that only wait on children. */
  readonly permit?: boolean;
  /** Shared per-group limit, e.g. an `Each` with `{ concurrency }`. */
  readonly limiter?: {
    readonly withPermit: <A, E, R>(
      self: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, R>;
  };
  readonly plan?: (ctx: PlanContext) => Effect.Effect<PlannedChange>;
  readonly execute: (ctx: ExecContext) => Effect.Effect<NodeResult, unknown>;
  /** Runs when the run finishes, for nodes that succeeded (run-lifetime cleanup). */
  readonly finish?: (ctx: FinishContext) => Effect.Effect<void, unknown>;
}

/** Persisted node status. */
export interface NodeRow {
  readonly runId: string;
  readonly fqn: string;
  readonly kind: NodeKind;
  readonly type: string;
  readonly status: NodeStatus;
  readonly attempt: number;
  readonly value?: unknown;
  readonly error?: NodeError;
  readonly reason?: string;
  readonly allowFailure?: boolean;
  readonly updatedAt: number;
}

/** The fully qualified dependencies of a spec. */
export const dependencies = (spec: Pick<NodeSpec, "input" | "options">) =>
  new Set([
    ...Output.upstreamOf(spec.input),
    ...Output.upstreamOf(spec.options.when),
    ...Output.upstreamOf(spec.options.dependsOn),
  ]);

/** Collects node specs while a workflow body runs. */
export class Registry extends Context.Service<
  Registry,
  {
    readonly info: RunInfo;
    readonly register: (spec: NodeSpec) => Effect.Effect<void>;
  }
>()("effectory/Registry") {}

/** The current namespace path. */
export const Namespace = Context.Reference<readonly string[]>(
  "effectory/Namespace",
  { defaultValue: () => [] }
);

/** A shared limit for nodes registered inside an effect (e.g. `Each` with `{ concurrency }`). */
export const Limiter = Context.Reference<NodeSpec["limiter"]>(
  "effectory/NodeLimiter",
  // oxlint-disable-next-line unicorn/no-useless-undefined -- no limiter by default.
  { defaultValue: () => undefined }
);

/** Options applied to every node registered inside an effect. */
export const Defaults = Context.Reference<NodeOptions>(
  "effectory/NodeDefaults",
  {
    defaultValue: () => ({}),
  }
);

const segment = /^[\w.@:#+-]+$/u;

/** Run `self` with `name` appended to the namespace path. */
export const namespace =
  (name: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Namespace, (path) =>
      Effect.provideService(self, Namespace, [...path, name])
    );

const withDefaults =
  (options: NodeOptions) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Defaults, (current) =>
      Effect.provideService(self, Defaults, { ...current, ...options })
    );

/** Skip the node(s) registered by `self` unless `condition` holds. */
export const when = (condition: Output.Output<boolean> | boolean) =>
  withDefaults({ when: condition });
/** Set when the node(s) registered by `self` run relative to upstream outcomes. */
export const runIf = (value: RunIf) => withDefaults({ runIf: value });
/** Record the failure of the node(s) registered by `self` without failing the run. */
export const allowFailure = withDefaults({ allowFailure: true });
/** Add ordering edges to the node(s) registered by `self`. */
export const dependsOn = (...values: readonly unknown[]) =>
  withDefaults({ dependsOn: values });
/** Set record retention for the node(s) registered by `self`. */
export const keep = (value: Keep) => withDefaults({ keep: value });

/** The registration details a primitive provides; the rest is derived. */
export type Registration = Omit<NodeSpec, "fqn" | "options"> & {
  readonly name: string;
  readonly options?: NodeOptions | undefined;
};

/**
 * Register a node under the current namespace and return the Output of its
 * value. Names are single path segments.
 */
export const register = <A>(
  registration: Registration
): Effect.Effect<Output.Output<A>, never, Registry> =>
  Effect.gen(function* registerNode() {
    const registry = yield* Registry;
    const path = yield* Namespace;
    const defaults = yield* Defaults;
    const limiter = yield* Limiter;
    if (!segment.test(registration.name)) {
      return yield* Effect.die(
        new Error(
          `Invalid node name "${registration.name}": use letters, digits, and . _ - @ : # +`
        )
      );
    }
    const { name, options, ...rest } = registration;
    const fqn = [...path, name].join("/");
    const merged: NodeOptions = {
      ...defaults,
      ...options,
      dependsOn: [...(defaults.dependsOn ?? []), ...(options?.dependsOn ?? [])],
    };
    yield* registry.register({
      ...(limiter === undefined ? {} : { limiter }),
      ...rest,
      fqn,
      options: merged,
    });
    return Output.ref<A>(fqn);
  });

/** The run the current workflow body is registering nodes for. */
export const info = Effect.map(Registry, (registry) => registry.info);
