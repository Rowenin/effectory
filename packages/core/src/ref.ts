import { DefinitionError } from "./errors.ts";

const instances = new WeakSet<object>();

export class Ref<out A> {
  declare readonly Type: A;
  readonly scope: symbol;
  readonly nodeId: string;
  readonly path: readonly (string | number)[];

  /** References are created only by graph construction. @internal */
  constructor(
    scope: symbol,
    nodeId: string,
    path: readonly (string | number)[] = []
  ) {
    this.scope = scope;
    this.nodeId = nodeId;
    this.path = Object.freeze([...path]);
    instances.add(this);
    Object.freeze(this);
  }
}

export type Input<A> =
  | Ref<A>
  | (A extends readonly unknown[]
      ? { readonly [K in keyof A]: Input<A[K]> }
      : A extends object
        ? { readonly [K in keyof A]: Input<A[K]> }
        : A);

export function is(value: unknown): value is Ref<unknown> {
  return typeof value === "object" && value !== null && instances.has(value);
}

export function field<A, K extends keyof A & (string | number)>(
  ref: Ref<A>,
  key: K
): Ref<A[K]> {
  return new Ref(ref.scope, ref.nodeId, [...ref.path, key]);
}

export function references(
  value: unknown,
  seen = new Set<object>()
): readonly Ref<unknown>[] {
  if (is(value)) {
    return [value];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  if (seen.has(value)) {
    throw new DefinitionError({ message: "Cyclic graph input" });
  }
  seen.add(value);
  const refs = Object.values(value).flatMap((child) => references(child, seen));
  seen.delete(value);
  return refs;
}

export function resolve(
  value: unknown,
  results: ReadonlyMap<string, unknown>,
  scopes?: ReadonlyMap<symbol, ReadonlyMap<string, unknown>>
): unknown {
  if (is(value)) {
    const source = scopes ? scopes.get(value.scope) : results;
    if (!source?.has(value.nodeId)) {
      throw new DefinitionError({
        message: `Missing node result: ${value.nodeId}`,
      });
    }
    let result = source.get(value.nodeId);
    for (const key of value.path) {
      if (typeof result !== "object" || result === null) {
        throw new DefinitionError({
          message: `Invalid reference path on ${value.nodeId}`,
        });
      }
      result = Reflect.get(result, key);
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolve(item, results, scopes));
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolve(item, results, scopes),
      ])
    );
  }
  return value;
}
