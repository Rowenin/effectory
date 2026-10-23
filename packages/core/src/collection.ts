/**
 * The collection root: every workflow, Action, Resource type, Target, and
 * Trigger, plus the Layers that provide what they need.
 */
import { Layer } from "effect";
import type { FileSystem, Path } from "effect";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import type * as Action from "./action.ts";
import type * as Resource from "./resource.ts";
import type * as Target from "./target.ts";
import type * as Trigger from "./trigger.ts";
import type * as Workflow from "./workflow.ts";

/** Services the CLI always provides (Bun platform). */
export type Platform = FileSystem.FileSystem | Path.Path | ChildProcessSpawner;

export interface Collection<R = never> {
  readonly _tag: "Collection";
  readonly name: string;
  readonly description: string;
  readonly workflows: readonly Workflow.Any[];
  readonly actions: readonly Action.Any[];
  readonly resources: readonly Resource.Any[];
  readonly targets: readonly Target.Any[];
  readonly triggers: readonly Trigger.Trigger[];
  /** Providers and services, merged. Requires only `Platform`. */
  readonly layer: Layer.Layer<R, unknown, Platform>;
}

// oxlint-disable-next-line typescript/no-explicit-any -- variance escape hatch
export type Any = Collection<any>;

type Requirement<W> = W extends Workflow.Any ? Workflow.Requirements<W> : never;
type ActionRequirement<A> =
  A extends Action.Action<string, infer _I, infer _O, infer R> ? R : never;

/** What the workflows and Actions need that the layers do not provide. */
export type Missing<W, A, P, RP, RS> = Exclude<
  Requirement<W> | ActionRequirement<A> | RP | RS,
  P | Platform
>;

export interface Options<W, A, P, E, RP, S, E2, RS> {
  readonly name: string;
  readonly description?: string;
  readonly workflows: readonly W[];
  readonly actions?: readonly A[];
  readonly resources?: readonly Resource.Any[];
  readonly targets?: readonly Target.Any[];
  readonly triggers?: readonly Trigger.Trigger[];
  readonly providers?: Layer.Layer<P, E, RP>;
  readonly services?: Layer.Layer<S, E2, RS>;
}

/**
 * Define the collection. Fails to typecheck, naming the missing services,
 * until every workflow's Providers and services are provided.
 */
export const make = <
  W extends Workflow.Any,
  A extends Action.Any = never,
  P = never,
  E = never,
  RP = never,
  S = never,
  E2 = never,
  RS = never,
>(
  options: Options<W, A, P, E, RP, S, E2, RS> &
    ([Missing<W, A, P | S, RP, RS>] extends [never]
      ? unknown
      : { readonly missingServices: Missing<W, A, P | S, RP, RS> })
): Collection<P | S> => {
  const services = (options.services ?? Layer.empty) as Layer.Layer<S, E2, RS>;
  const providers = (options.providers ?? Layer.empty) as Layer.Layer<P, E, RP>;
  const layer = Layer.provideMerge(
    providers,
    services
  ) as unknown as Layer.Layer<P | S, unknown, Platform>;
  return {
    _tag: "Collection",
    actions: options.actions ?? [],
    description: options.description ?? "",
    layer,
    name: options.name,
    resources: options.resources ?? [],
    targets: options.targets ?? [],
    triggers: options.triggers ?? [],
    workflows: options.workflows,
  };
};

export const isCollection = (value: unknown): value is Any =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "Collection";
