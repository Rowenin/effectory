/**
 * `Each` fans a function out over a list. A literal list expands at plan time,
 * so the plan shows every child; an `Output` list registers one `Each` node
 * that expands into children when the list resolves.
 *
 * Also holds the helpers `Call` shares for expanding nodes at execution time.
 */
import { Context, Effect, Semaphore } from "effect";

import * as Node from "./node.ts";
import type {
  ExecContext,
  NodeOptions,
  NodeResult,
  NodeSpec,
  Registry,
} from "./node.ts";
import * as Output from "./output.ts";

export interface EachOptions extends NodeOptions {
  /** Maximum children executing at once. Default: the run's concurrency. */
  readonly concurrency?: number;
}

type Limiter = NonNullable<NodeSpec["limiter"]>;

const segment = /^[\w.@:#+-]+$/u;

/** Die on a name that cannot be a single FQN segment. */
export const checkName = (name: string): Effect.Effect<void> =>
  segment.test(name)
    ? Effect.void
    : Effect.die(
        new Error(
          `Invalid node name "${name}": use letters, digits, and . _ - @ : # +`
        )
      );

const defined = (options: {
  readonly [K in keyof NodeOptions]?: NodeOptions[K] | undefined;
}): NodeOptions =>
  Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined)
  );

/** Apply `options` to every node registered by `self`, on top of the current defaults. */
export const withDefaults =
  (options: NodeOptions) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Node.Defaults, (current) =>
      Effect.provideService(self, Node.Defaults, {
        ...current,
        ...defined(options),
        dependsOn: [...(current.dependsOn ?? []), ...(options.dependsOn ?? [])],
      })
    );

const limiterOf = (
  semaphore: Semaphore.Semaphore,
  outer?: Limiter
): Limiter => ({
  withPermit: (self) =>
    outer === undefined
      ? semaphore.withPermit(self)
      : outer.withPermit(semaphore.withPermit(self)),
});

/** Limit the nodes registered by `self` to `concurrency` at once (nested limits compose). */
const withLimit =
  (concurrency: number) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Node.Limiter, (outer) =>
      Effect.provideService(
        self,
        Node.Limiter,
        limiterOf(Semaphore.makeUnsafe(concurrency), outer)
      )
    );

/**
 * Capture the caller's services at registration for `ctx.expand`, without
 * the plan-time Registry and node settings: those must come from `expand`.
 */
export const captureContext = <R>(): Effect.Effect<
  Context.Context<never>,
  never,
  R
> =>
  Effect.map(
    Effect.context<R>(),
    (context) =>
      Context.omit(
        Node.Registry,
        Node.Namespace,
        Node.Defaults,
        Node.Limiter
      )(context) as Context.Context<never>
  );

/**
 * Defaults for children expanded at execution time: they inherit the
 * parent's `allowFailure` and `keep`, not its `when`, `runIf`, or
 * `dependsOn` (the parent already passed those gates).
 */
export const childDefaults = (
  options: NodeOptions | undefined
): Effect.Effect<NodeOptions> =>
  Effect.map(Node.Defaults, (defaults) =>
    defined({
      allowFailure: options?.allowFailure ?? defaults.allowFailure,
      keep: options?.keep ?? defaults.keep,
    })
  );

/** Run `self`, collecting the FQNs of the nodes it registers. */
export const tracking = <A, E, R>(
  self: Effect.Effect<A, E, R>
): Effect.Effect<
  { readonly fqns: readonly string[]; readonly value: A },
  E,
  R | Registry
> =>
  Effect.gen(function* trackRegistrations() {
    const registry = yield* Node.Registry;
    const fqns: string[] = [];
    const value = yield* Effect.provideService(
      self,
      Node.Registry,
      Node.Registry.of({
        info: registry.info,
        register: (spec) =>
          Effect.tap(registry.register(spec), () =>
            Effect.sync(() => {
              fqns.push(spec.fqn);
            })
          ),
      })
    );
    return { fqns, value };
  });

/**
 * Wait for every expanded child, then finish the parent: suspended while a
 * child is suspended or pending, failed when a child failed (without
 * `allowFailure`), otherwise succeeded with `value` resolved.
 */
export const settle = (
  ctx: ExecContext,
  children: readonly string[],
  value: unknown
): Effect.Effect<NodeResult, Node.NodeFailure> =>
  Effect.gen(function* settleChildren() {
    yield* Effect.forEach(
      children,
      (fqn) => Effect.exit(ctx.await(Output.ref(fqn))),
      { discard: true }
    );
    const wanted = new Set(children);
    const rows = (yield* ctx.state.getNodes(ctx.runId)).filter((row) =>
      wanted.has(row.fqn)
    );
    const blocked = rows.filter(
      (row) => row.status === "suspended" || row.status === "pending"
    );
    if (blocked.length > 0) {
      return Node.suspended(
        `waiting on ${blocked.map((row) => row.fqn).join(", ")}`
      );
    }
    const failed = rows.filter(
      (row) => row.status === "failed" && row.allowFailure !== true
    );
    if (failed.length > 0) {
      return yield* new Node.NodeFailure({
        message: `${failed.map((row) => row.fqn).join(", ")} failed`,
        tag: "ChildFailed",
      });
    }
    return Node.succeeded(yield* ctx.await(value));
  });

const staticEach = <A, B, E, R>(
  name: string,
  items: readonly A[],
  f: (item: A, index: number) => Effect.Effect<B, E, R>,
  options: NodeOptions,
  concurrency: number | undefined
): Effect.Effect<B[], E, R> => {
  const body = Effect.forEach(items, f).pipe(withDefaults(options));
  const limited =
    concurrency === undefined ? body : body.pipe(withLimit(concurrency));
  return limited.pipe(Node.namespace(name));
};

const dynamicEach = <A, B, E, R>(
  name: string,
  items: Output.Output<readonly A[]>,
  f: (item: A, index: number) => Effect.Effect<B, E, R>,
  options: NodeOptions,
  concurrency: number | undefined
) =>
  Effect.gen(function* registerEach() {
    const context = yield* captureContext<Exclude<R, Registry>>();
    const defaults = yield* childDefaults(options);
    return yield* Node.register<Output.Resolved<B>[]>({
      execute: (ctx) =>
        Effect.gen(function* executeEach() {
          const values = ctx.input as readonly A[];
          const limiter =
            concurrency === undefined
              ? undefined
              : limiterOf(Semaphore.makeUnsafe(concurrency));
          const body = Effect.forEach(values, f).pipe(
            Effect.provideService(Node.Defaults, defaults),
            Effect.provideService(Node.Limiter, limiter)
          ) as Effect.Effect<B[], E, Registry>;
          const { fqns, value } = yield* ctx.expand(tracking(body), {
            context,
          });
          return yield* settle(ctx, fqns, value);
        }),
      input: items,
      kind: "each",
      name,
      options,
      permit: false,
      plan: () =>
        Effect.succeed({
          action: "expand",
          detail: "children are known at execution",
        }),
      reuse: "record",
      type: "Each",
    });
  });

/**
 * Fan `f` out over `items`. Children are named by `f` and live under
 * `name/`. Node options apply to every child of a literal list and to the
 * `Each` node of an `Output` list.
 *
 * ```ts
 * const checks = yield* Each("check", commands, (cmd) => Shell(cmd.name, { ... }));
 * const sums = yield* Each("sum", items, (n) => Add(String(n), { a: n, b: 1 }), { concurrency: 2 });
 * ```
 */
export const Each: {
  <const T extends readonly unknown[], B, E, R>(
    name: string,
    items: Output.Output<T>,
    f: (item: T[number], index: number) => Effect.Effect<B, E, R>,
    options?: EachOptions
  ): Effect.Effect<
    Output.Output<Output.Resolved<B>[]>,
    never,
    Registry | Exclude<R, Registry>
  >;
  <A, B, E, R>(
    name: string,
    items: readonly A[],
    f: (item: A, index: number) => Effect.Effect<B, E, R>,
    options?: EachOptions
  ): Effect.Effect<B[], E, R>;
} = function each(
  name: string,
  items: readonly unknown[] | Output.Output<readonly unknown[]>,
  f: (item: unknown, index: number) => Effect.Effect<unknown, unknown, unknown>,
  options: EachOptions = {}
): Effect.Effect<unknown, unknown, unknown> {
  const { concurrency, ...nodeOptions } = options;
  if (
    concurrency !== undefined &&
    (!Number.isInteger(concurrency) || concurrency < 1)
  ) {
    return Effect.die(
      new Error(`Each ${name}: concurrency must be a positive integer`)
    );
  }
  const body: Effect.Effect<unknown, unknown, unknown> = Output.isOutput(items)
    ? dynamicEach(name, items, f, nodeOptions, concurrency)
    : staticEach(name, items, f, nodeOptions, concurrency);
  return Effect.andThen(checkName(name), body);
} as never;
