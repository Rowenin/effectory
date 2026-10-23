/**
 * Lazy references to node values. Passing an Output into another node's input
 * creates a dependency edge; the value exists only once the upstream node ran.
 */
import type { Redacted } from "effect";

const TypeId: unique symbol = Symbol.for("effectory/Output");

/** Resolves a node's value by FQN. Throws `MissingValue` when it has none. */
export type Lookup = (fqn: string) => unknown;

/** Thrown by a `Lookup` for a node that failed, was skipped, or has not run. */
export class MissingValueError extends Error {
  readonly fqn: string;
  constructor(fqn: string) {
    super(`Node ${fqn} has no value`);
    this.name = "MissingValueError";
    this.fqn = fqn;
  }
}

interface OutputBase<A> {
  readonly [TypeId]: {
    readonly upstream: ReadonlySet<string>;
    readonly evaluate: (lookup: Lookup) => A;
    readonly _A?: (_: never) => A;
  };
}

type Props<A> = 0 extends 1 & A
  ? unknown
  : [A] extends [readonly (infer E)[]]
    ? { readonly [n: number]: Output<E>; readonly length: Output<number> }
    : [A] extends [Redacted.Redacted<unknown>]
      ? unknown
      : [A] extends [(...args: never[]) => unknown]
        ? unknown
        : [A] extends [object]
          ? { readonly [K in keyof A]-?: Output<A[K]> }
          : unknown;

/**
 * A lazy value of type `A`. Property access on an Output is an Output of the
 * property, so `checkout.path` works for a Resource's attributes.
 */
export type Output<A> = OutputBase<A> & Props<A>;

/** Anything a node accepts in place of `T`: the value, an Output of it, or a structure containing Outputs. */
export type Input<T> =
  | T
  | Output<T>
  | ([T] extends [readonly (infer E)[]]
      ? readonly Input<E>[]
      : [T] extends [Redacted.Redacted<unknown>]
        ? never
        : [T] extends [Record<string, unknown>]
          ? { readonly [K in keyof T]: Input<T[K]> }
          : never);

/** The plain type of a value that may contain Outputs. */
export type Resolved<T> =
  T extends OutputBase<infer A>
    ? A
    : T extends Redacted.Redacted<unknown>
      ? T
      : T extends readonly unknown[]
        ? { -readonly [K in keyof T]: Resolved<T[K]> }
        : T extends Record<string, unknown>
          ? { -readonly [K in keyof T]: Resolved<T[K]> }
          : T;

// Keys that runtime introspection (await, JSON, test matchers, inspect)
// probes; answering them with Outputs would confuse those callers.
const opaqueKeys = new Set([
  "then",
  "toJSON",
  "constructor",
  "asymmetricMatch",
  "$$typeof",
  "nodeType",
  "toString",
  "valueOf",
  "inspect",
]);

const make = <A>(
  upstream: ReadonlySet<string>,
  evaluate: (lookup: Lookup) => A
): Output<A> => {
  const target = { [TypeId]: { evaluate, upstream } };
  return new Proxy(target, {
    get(self, key, receiver) {
      if (typeof key === "symbol" || opaqueKeys.has(key)) {
        return Reflect.get(self, key, receiver);
      }
      return make(upstream, (lookup) => {
        const parent = evaluate(lookup) as Record<string, unknown> | undefined;
        return parent?.[key];
      });
    },
  }) as unknown as Output<A>;
};

export const isOutput = (value: unknown): value is Output<unknown> =>
  typeof value === "object" && value !== null && TypeId in value;

/** The Output of a node's value. */
export const ref = <A>(fqn: string): Output<A> =>
  make(new Set([fqn]), (lookup) => lookup(fqn) as A);

/** A constant Output with no upstream. */
export const of = <A>(value: A): Output<A> => make(new Set(), () => value);

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Every node FQN a value (with nested Outputs) depends on. */
export const upstreamOf = (value: unknown): ReadonlySet<string> => {
  const found = new Set<string>();
  const visit = (item: unknown) => {
    if (isOutput(item)) {
      for (const fqn of item[TypeId].upstream) {
        found.add(fqn);
      }
    } else if (Array.isArray(item) || isPlain(item)) {
      for (const child of Object.values(item)) {
        visit(child);
      }
    }
  };
  visit(value);
  return found;
};

/** Replace every nested Output with its value. */
export const resolve = <T>(value: T, lookup: Lookup): Resolved<T> => {
  const visit = (item: unknown): unknown => {
    if (isOutput(item)) {
      return item[TypeId].evaluate(lookup);
    }
    if (Array.isArray(item)) {
      return item.map(visit);
    }
    if (isPlain(item)) {
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [key, visit(child)])
      );
    }
    return item;
  };
  return visit(value) as Resolved<T>;
};

const containsOutput = (value: unknown): boolean =>
  isOutput(value) ||
  (Array.isArray(value) && value.some(containsOutput)) ||
  (isPlain(value) && Object.values(value).some(containsOutput));

/** True when a value contains no Outputs, so it is known at plan time. */
export const isResolved = (value: unknown): boolean => !containsOutput(value);

/** Transform an Output (or a structure containing Outputs). */
export const map: {
  <T, B>(f: (value: Resolved<T>) => B): (self: T) => Output<B>;
  <T, B>(self: T, f: (value: Resolved<T>) => B): Output<B>;
} = function mapOutput(...args: readonly unknown[]): unknown {
  if (args.length === 1) {
    return (self: unknown) => mapOutput(self, args[0]);
  }
  const [self, f] = args as [unknown, (value: unknown) => unknown];
  return make(upstreamOf(self), (lookup) => f(resolve(self, lookup)));
} as never;

/** Combine an array or record of Outputs into one Output. */
export const all = <
  const T extends readonly unknown[] | Record<string, unknown>,
>(
  values: T
): Output<Resolved<T>> =>
  make(upstreamOf(values), (lookup) => resolve(values, lookup));

/**
 * An Output that is `undefined` when its upstream has no value (failed or
 * skipped), for nodes that run with `runIf: "completed"`.
 */
export const optional = <A>(self: Output<A>): Output<A | undefined> =>
  make(self[TypeId].upstream, (lookup) => {
    try {
      return self[TypeId].evaluate(lookup);
    } catch (error) {
      if (error instanceof MissingValueError) {
        return;
      }
      throw error;
    }
  });
