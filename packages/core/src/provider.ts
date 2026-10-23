/* oxlint-disable max-classes-per-file -- the provider contract's errors live with it. */
/**
 * Providers implement a Resource type's lifecycle: `read` observes live
 * state, `diff` classifies a change, `reconcile` converges to the desired
 * props, `delete` removes the object. A provider is a Layer of the
 * `Provider<Type>` service; dual providers carry a fake for `mode: "fake"`.
 */
import { Context, Data, Effect, Layer } from "effect";
import type { Schema } from "effect";

import * as Json from "./json.ts";
import type { Mode } from "./node.ts";
import type * as Resource from "./resource.ts";

/** What a provider needs of its Resource definition: its type and schemas. */
export interface ResourceSchemas<P, A> {
  readonly type: string;
  readonly props: Schema.Codec<P, unknown>;
  readonly attributes: Schema.Codec<A, unknown>;
}

/** A provider's `delete` is waiting on the remote side; the engine retries it. */
export class DeleteInProgress extends Data.TaggedError("DeleteInProgress")<{
  readonly message: string;
}> {}

/** A preflight check refused the operation. */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{
  readonly message: string;
}> {}

/** `read` found an object this collection does not own, and `adopt` is off. */
export class ResourceUnowned extends Data.TaggedError("ResourceUnowned")<{
  readonly message: string;
  readonly fqn: string;
  readonly type: string;
}> {}

const UnownedTypeId: unique symbol = Symbol.for("effectory/Unowned");

/** Live state `read` found that was not created by this collection. */
export interface UnownedResult<A> {
  readonly [UnownedTypeId]: true;
  readonly attributes: A;
}

/** Mark attributes `read` found as not owned by this collection. */
export const Unowned = <A>(attributes: A): UnownedResult<A> => ({
  [UnownedTypeId]: true,
  attributes,
});

/** `read`'s result for an object that does not exist. */
export const absent: Effect.Effect<undefined> =
  Effect.void as Effect.Effect<undefined>;

export const isUnowned = (value: unknown): value is UnownedResult<unknown> =>
  typeof value === "object" && value !== null && UnownedTypeId in value;

export interface ReadInput<P, A> {
  readonly fqn: string;
  /** The scope the resource belongs to; with `fqn`, its identity. */
  readonly scope: string;
  /** The last reconciled props, or the desired props when there is no state row. */
  readonly olds: P;
  /** The last known attributes; `undefined` when looking an object up. */
  readonly output: A | undefined;
}

export interface DiffInput<P, A> {
  readonly fqn: string;
  /** The scope the resource belongs to; with `fqn`, its identity. */
  readonly scope: string;
  readonly olds: P;
  readonly news: P;
  readonly output: A;
}

export interface ReconcileInput<P, A> {
  readonly fqn: string;
  /** The scope the resource belongs to; with `fqn`, its identity. */
  readonly scope: string;
  readonly news: P;
  /** Props the object was last reconciled to; `undefined` when creating. */
  readonly olds: P | undefined;
  /** The current object's attributes; `undefined` when creating. */
  readonly output: A | undefined;
}

export interface DeleteInput<P, A> {
  readonly fqn: string;
  /** The scope the resource belongs to; with `fqn`, its identity. */
  readonly scope: string;
  readonly olds: P;
  readonly output: A;
}

export interface CheckInput<P, A> {
  readonly fqn: string;
  /** The scope the resource belongs to; with `fqn`, its identity. */
  readonly scope: string;
  readonly operation: "reconcile" | "delete";
  readonly news?: P | undefined;
  readonly olds?: P | undefined;
  readonly output?: A | undefined;
}

export interface Diff {
  readonly action: "noop" | "update" | "replace";
  /** For `replace`: delete the old object before creating the new one. */
  readonly deleteFirst?: boolean;
}

/** The provider contract (Alchemy's `ProviderService`, trimmed). */
export interface ProviderService<P, A, R = never> {
  /** Observe live state: attributes, `Unowned(attrs)`, or `undefined` if absent. */
  readonly read: (
    input: ReadInput<P, A>
  ) => Effect.Effect<A | UnownedResult<A> | undefined, unknown, R>;
  /** Classify a change. Default: deep-equal props → `noop`, else `update`. */
  readonly diff?: (
    input: DiffInput<P, A>
  ) => Effect.Effect<Diff | undefined, unknown, R>;
  /** Create or update to `news`. Must be idempotent. */
  readonly reconcile: (
    input: ReconcileInput<P, A>
  ) => Effect.Effect<A, unknown, R>;
  /** Idempotent. Fail with `DeleteInProgress` to be retried. */
  readonly delete: (
    input: DeleteInput<P, A>
  ) => Effect.Effect<void, unknown, R>;
  /** Attributes known at plan time across updates. */
  readonly stables?: readonly (keyof A)[];
  /** Preflight checks run before `reconcile` and `delete`. */
  readonly checks?: (
    input: CheckInput<P, A>
  ) => Effect.Effect<void, CheckFailed, R>;
}

/** Identifies the provider service for Resource type `Type`. */
export interface Provider<Type extends string> {
  readonly _ProviderType: Type;
}

/** The value of a `Provider<Type>` service. */
export interface ProviderShape<P, A> {
  readonly resource: ResourceSchemas<P, A>;
  readonly live: ProviderService<P, A>;
  readonly fake: ProviderService<P, A>;
}

/** The service a provider uses in `mode`. */
export const forMode = <P, A>(shape: ProviderShape<P, A>, mode: Mode) =>
  mode === "fake" ? shape.fake : shape.live;

// oxlint-disable-next-line typescript/no-explicit-any -- keyed by type string at runtime.
const tags = new Map<string, Context.Service<any, ProviderShape<any, any>>>();

/** The service key for Resource type `type`. Memoized, so runtime lookup by type works. */
// oxlint-disable-next-line typescript/no-explicit-any -- callers that look up by type string get untyped shapes.
export const tag = <Type extends string, P = any, A = any>(
  type: Type
): Context.Service<Provider<Type>, ProviderShape<P, A>> => {
  let key = tags.get(type);
  if (key === undefined) {
    key = Context.Service<Provider<Type>, ProviderShape<P, A>>(
      `effectory/Provider/${type}`
    );
    tags.set(type, key);
  }
  return key as Context.Service<Provider<Type>, ProviderShape<P, A>>;
};

/** Provide `context` to every lifecycle method, so calls need nothing. */
const bind = <P, A, R>(
  service: ProviderService<P, A, R>,
  context: Context.Context<R>
): ProviderService<P, A> => {
  const provide = <X, E>(effect: Effect.Effect<X, E, R>) =>
    Effect.provideContext(effect, context);
  const { checks, diff } = service;
  return {
    delete: (input) => provide(service.delete(input)),
    read: (input) => provide(service.read(input)),
    reconcile: (input) => provide(service.reconcile(input)),
    ...(checks === undefined
      ? {}
      : { checks: (input) => provide(checks(input)) }),
    ...(diff === undefined ? {} : { diff: (input) => provide(diff(input)) }),
    ...(service.stables === undefined ? {} : { stables: service.stables }),
  };
};

const bound = <P, A, R>(service: ProviderService<P, A, R>) =>
  Effect.map(Effect.context<R>(), (context) => bind(service, context));

/** A provider from a service value; one service for both modes. */
export const succeed = <Type extends string, P, A, R = never>(
  resource: Resource.Resource<Type, P, A>,
  service: ProviderService<P, A, R>
): Layer.Layer<Provider<Type>, never, R> =>
  Layer.effect(
    tag<Type, P, A>(resource.type),
    Effect.map(bound(service), (live) => ({ fake: live, live, resource }))
  );

/** A provider built by an Effect; one service for both modes. */
export const effect = <
  Type extends string,
  P,
  A,
  RS = never,
  E = never,
  R = never,
>(
  resource: Resource.Resource<Type, P, A>,
  make: Effect.Effect<ProviderService<P, A, RS>, E, R>
): Layer.Layer<Provider<Type>, E, R | RS> =>
  Layer.effect(
    tag<Type, P, A>(resource.type),
    Effect.gen(function* makeProvider() {
      const live = yield* bound(yield* make);
      return { fake: live, live, resource };
    })
  );

/** A provider with a fake used in `mode: "fake"` (Alchemy's provider modes). */
export const dual = <
  Type extends string,
  P,
  A,
  RL = never,
  EL = never,
  RML = never,
  RF = never,
  EF = never,
  RMF = never,
>(
  resource: Resource.Resource<Type, P, A>,
  services: {
    readonly live: Effect.Effect<ProviderService<P, A, RL>, EL, RML>;
    readonly fake: Effect.Effect<ProviderService<P, A, RF>, EF, RMF>;
  }
): Layer.Layer<Provider<Type>, EL | EF, RL | RML | RF | RMF> =>
  Layer.effect(
    tag<Type, P, A>(resource.type),
    Effect.gen(function* makeDual() {
      const live = yield* bound(yield* services.live);
      const fake = yield* bound(yield* services.fake);
      return { fake, live, resource };
    })
  );

interface MemoryEntry<P, A> {
  readonly id: number;
  props: P;
  attributes: A;
  owned: boolean;
}

/** The objects an in-memory provider holds, for assertions. */
export interface MemoryStore<P, A> {
  /** Live objects per FQN, oldest first. */
  readonly objects: (fqn: string) => readonly MemoryEntry<P, A>[];
  /** Every live object. */
  readonly all: () => readonly MemoryEntry<P, A>[];
  /** Create an object out of band (e.g. one this collection does not own). */
  readonly seed: (
    fqn: string,
    props: P,
    options?: { readonly owned?: boolean }
  ) => A;
  readonly calls: {
    reads: number;
    creates: number;
    updates: number;
    deletes: number;
  };
}

export interface MemoryOptions<P, A> {
  readonly attributes: (props: P, fqn: string) => A;
  readonly diff?: ProviderService<P, A>["diff"];
  readonly checks?: ProviderService<P, A>["checks"];
  /** Runs before each reconcile; fail it to simulate provider errors. */
  readonly onReconcile?: (
    input: ReconcileInput<P, A>
  ) => Effect.Effect<void, unknown>;
  /** Runs before each delete; fail it (e.g. `DeleteInProgress`) to simulate provider errors. */
  readonly onDelete?: (
    input: DeleteInput<P, A>
  ) => Effect.Effect<void, unknown>;
}

/**
 * An in-memory provider, for fakes and tests. Objects are kept per FQN and
 * identified by their attributes, so a replacement can coexist with the
 * object it replaces.
 */
export const memory = <Type extends string, P, A>(
  _resource: Resource.Resource<Type, P, A>,
  options: MemoryOptions<P, A>
): ProviderService<P, A> & { readonly store: MemoryStore<P, A> } => {
  const objects = new Map<string, MemoryEntry<P, A>[]>();
  let next = 0;
  const entries = (fqn: string) => {
    let list = objects.get(fqn);
    if (list === undefined) {
      list = [];
      objects.set(fqn, list);
    }
    return list;
  };
  const find = (fqn: string, output: A | undefined) => {
    const list = entries(fqn);
    if (output === undefined) {
      return list.at(-1);
    }
    const wanted = Json.canonical(output);
    return list.find((entry) => Json.canonical(entry.attributes) === wanted);
  };
  const add = (fqn: string, props: P, owned: boolean) => {
    next += 1;
    const entry = {
      attributes: options.attributes(props, fqn),
      id: next,
      owned,
      props,
    };
    entries(fqn).push(entry);
    return entry;
  };
  const store: MemoryStore<P, A> = {
    all: () => [...objects.values()].flat(),
    calls: { creates: 0, deletes: 0, reads: 0, updates: 0 },
    objects: (fqn) => [...entries(fqn)],
    seed: (fqn, props, seedOptions) =>
      add(fqn, props, seedOptions?.owned ?? true).attributes,
  };
  return {
    delete: (input) =>
      Effect.gen(function* deleteMemory() {
        if (options.onDelete) {
          yield* options.onDelete(input);
        }
        store.calls.deletes += 1;
        const entry = find(input.fqn, input.output);
        if (entry !== undefined) {
          const list = entries(input.fqn);
          list.splice(list.indexOf(entry), 1);
        }
      }),
    read: (input) =>
      Effect.sync(() => {
        store.calls.reads += 1;
        const entry = find(input.fqn, input.output);
        if (entry === undefined) {
          return;
        }
        return entry.owned ? entry.attributes : Unowned(entry.attributes);
      }),
    reconcile: (input) =>
      Effect.gen(function* reconcileMemory() {
        if (options.onReconcile) {
          yield* options.onReconcile(input);
        }
        const entry =
          input.output === undefined
            ? undefined
            : find(input.fqn, input.output);
        if (entry === undefined) {
          store.calls.creates += 1;
          return add(input.fqn, input.news, true).attributes;
        }
        store.calls.updates += 1;
        entry.props = input.news;
        entry.attributes = options.attributes(input.news, input.fqn);
        entry.owned = true;
        return entry.attributes;
      }),
    store,
    ...(options.diff === undefined ? {} : { diff: options.diff }),
    ...(options.checks === undefined ? {} : { checks: options.checks }),
  };
};
