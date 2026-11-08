import { Context, Effect, Schema } from "effect";

import { identifier, version } from "./boundary.ts";
import type { Boundary } from "./boundary.ts";
import { DefinitionError, definitionError } from "./errors.ts";
import { boundedInteger, durationMillis } from "./policy.ts";
import * as Ref from "./ref.ts";
import { declarations } from "./tag-state.ts";
import type * as MetadataTag from "./tag.ts";
import type * as Task from "./task.ts";

export interface Spec {
  readonly tags?: MetadataTag.Declarations;
  readonly id: string;
  readonly version: number;
  readonly input: Boundary;
  readonly success: Boundary;
  readonly error: Boundary;
  readonly description?: string;
  readonly execution?: {
    readonly concurrency?: number;
    readonly timeout?: string;
  };
}

export interface NodeOptions {
  readonly after?: readonly Ref.Ref<unknown>[];
  readonly timeout?: string;
  readonly attemptTimeout?: string;
  readonly retry?: {
    readonly attempts: number;
    readonly delay: string;
    readonly when: readonly string[];
  };
}

export type TaskOptions<E> = Omit<NodeOptions, "retry"> & {
  readonly retry?: Omit<NonNullable<NodeOptions["retry"]>, "when"> & {
    readonly when: readonly (E extends {
      readonly _tag: infer Tag extends string;
    }
      ? Tag
      : never)[];
  };
};

export interface TaskNode {
  readonly kind: "Task";
  readonly id: string;
  readonly task: Task.Contract;
  readonly input: unknown;
  readonly dependencies: readonly string[];
  readonly refs: readonly Ref.Ref<unknown>[];
  readonly options: NodeOptions;
  /** Compiler-owned barriers, attached after the author's graph is built. */
  readonly patches?: readonly AppliedPatch[];
}

export interface AppliedPatch {
  readonly id: string;
  readonly definitionId: string;
  readonly extensionId: string;
  readonly after: readonly string[];
  readonly graph: Graph;
}

export interface MapNode {
  readonly kind: "Map";
  readonly id: string;
  readonly input: unknown;
  readonly success: Boundary;
  readonly compute: (value: unknown) => unknown;
  readonly dependencies: readonly string[];
  readonly refs: readonly Ref.Ref<unknown>[];
}

export interface WaitNode {
  readonly kind: "Approval" | "Input" | "Signal" | "SignalRegistration";
  readonly id: string;
  readonly prompt?: string;
  readonly context?: unknown;
  readonly schema?: Boundary;
  readonly timeout: string;
  readonly dependencies: readonly string[];
  readonly refs: readonly Ref.Ref<unknown>[];
}

export interface BranchNode {
  readonly kind: "Branch";
  readonly id: string;
  readonly condition: Ref.Ref<boolean>;
  readonly success: Boundary;
  readonly onTrue: Graph;
  readonly onFalse: Graph;
  readonly dependencies: readonly string[];
  readonly refs: readonly Ref.Ref<unknown>[];
}
export interface ForEachNode {
  readonly kind: "ForEach";
  readonly id: string;
  readonly items: Ref.Ref<readonly unknown[]>;
  readonly item: Boundary;
  readonly success: Boundary;
  readonly key: (item: unknown) => string;
  readonly concurrency: number;
  readonly maxItems: number;
  readonly graph: Graph;
  readonly dependencies: readonly string[];
  readonly refs: readonly Ref.Ref<unknown>[];
}
export interface ChildNode {
  readonly kind: "Workflow";
  readonly id: string;
  readonly workflow: Definition;
  readonly input: unknown;
  readonly options: Pick<NodeOptions, "after" | "timeout">;
  readonly dependencies: readonly string[];
  readonly refs: readonly Ref.Ref<unknown>[];
}
export interface SleepNode {
  readonly kind: "Sleep";
  readonly id: string;
  readonly duration: string;
  readonly dependencies: readonly string[];
  readonly refs: readonly Ref.Ref<unknown>[];
}
export const SignalAddress = Schema.Struct({
  runId: Schema.String,
  waitId: Schema.String,
});
const signalType: unique symbol = Symbol("Signal");
export interface Signal<A> {
  readonly address: Ref.Ref<typeof SignalAddress.Type>;
  readonly [signalType]: (_: A) => A;
}
export interface AwaitSignalNode {
  readonly kind: "AwaitSignal";
  readonly id: string;
  readonly address: Ref.Ref<typeof SignalAddress.Type>;
  readonly schema: Boundary;
  readonly dependencies: readonly string[];
  readonly refs: readonly Ref.Ref<unknown>[];
}
export type Node =
  | TaskNode
  | MapNode
  | WaitNode
  | BranchNode
  | ForEachNode
  | ChildNode
  | SleepNode
  | AwaitSignalNode;

export interface Graph {
  readonly captures: readonly Ref.Ref<unknown>[];
  readonly nodes: readonly Node[];
  readonly result: unknown;
  readonly scope: symbol;
}

export interface ApprovalPermit {
  readonly _tag: "ApprovalPermit";
}

export interface WaitOptions {
  readonly prompt?: string;
  readonly context?: unknown;
  readonly timeout: string;
  readonly after?: readonly Ref.Ref<unknown>[];
}

export interface GraphBuilder {
  readonly registerSignal: <S extends Boundary>(
    id: string,
    options: WaitOptions & { readonly schema: S }
  ) => Effect.Effect<Signal<S["Type"]>, DefinitionError>;
  readonly awaitSignal: <A>(
    id: string,
    signal: Signal<A>,
    options?: Pick<NodeOptions, "after">
  ) => Effect.Effect<Ref.Ref<A>, DefinitionError>;
  readonly branch: <S extends Boundary>(
    id: string,
    condition: Ref.Ref<boolean>,
    cases: {
      readonly success: S;
      readonly onTrue: Effect.Effect<
        Ref.Input<NoInfer<S["Type"]>>,
        DefinitionError,
        Builder
      >;
      readonly onFalse: Effect.Effect<
        Ref.Input<NoInfer<S["Type"]>>,
        DefinitionError,
        Builder
      >;
    }
  ) => Effect.Effect<Ref.Ref<S["Type"]>, DefinitionError>;
  readonly forEach: <I extends Boundary, O extends Boundary>(
    id: string,
    items: Ref.Ref<readonly NoInfer<I["Type"]>[]>,
    options: {
      readonly item: I;
      readonly success: O;
      readonly key: (item: NoInfer<I["Type"]>) => string;
      readonly concurrency: number;
      readonly maxItems: number;
    },
    construction: (
      item: Ref.Ref<NoInfer<I["Type"]>>
    ) => Effect.Effect<Ref.Input<NoInfer<O["Type"]>>, DefinitionError, Builder>
  ) => Effect.Effect<Ref.Ref<readonly O["Type"][]>, DefinitionError>;
  readonly workflow: <S extends Spec>(
    id: string,
    workflow: Definition<S>,
    input: Ref.Input<NoInfer<S["input"]["Type"]>>,
    options?: Pick<NodeOptions, "after" | "timeout">
  ) => Effect.Effect<Ref.Ref<S["success"]["Type"]>, DefinitionError>;
  readonly sleep: (
    id: string,
    duration: string,
    options?: Pick<NodeOptions, "after">
  ) => Effect.Effect<Ref.Ref<void>, DefinitionError>;

  readonly input: <S extends Boundary>(
    schema: S
  ) => Effect.Effect<Ref.Ref<S["Type"]>, DefinitionError>;
  readonly task: <S extends Task.Spec>(
    id: string,
    task: Task.Contract<S>,
    input: Ref.Input<NoInfer<S["input"]["Type"]>>,
    options?: TaskOptions<NoInfer<S["error"]["Type"]>>
  ) => Effect.Effect<Ref.Ref<S["success"]["Type"]>, DefinitionError>;
  readonly map: <A, S extends Boundary>(
    id: string,
    spec: { readonly input: Ref.Ref<A>; readonly success: S },
    compute: (value: A) => NoInfer<S["Type"]>
  ) => Effect.Effect<Ref.Ref<S["Type"]>, DefinitionError>;
  readonly approval: (
    id: string,
    options: WaitOptions & { readonly prompt: string }
  ) => Effect.Effect<Ref.Ref<ApprovalPermit>, DefinitionError>;
  readonly requestInput: <S extends Boundary>(
    id: string,
    options: WaitOptions & { readonly prompt: string; readonly schema: S }
  ) => Effect.Effect<Ref.Ref<S["Type"]>, DefinitionError>;
  readonly waitForSignal: <S extends Boundary>(
    id: string,
    options: WaitOptions & { readonly schema: S }
  ) => Effect.Effect<Ref.Ref<S["Type"]>, DefinitionError>;
}

export class Builder extends Context.Service<Builder, GraphBuilder>()(
  "effectory/Workflow.Builder"
) {}

export interface Definition<S extends Spec = Spec> {
  readonly tags: Readonly<Record<string, string>>;
  readonly tagSchemas: Readonly<
    Record<string, Schema.Codec<unknown, string, never, never>>
  >;
  readonly kind: "Workflow";
  readonly id: S["id"];
  readonly spec: S;
  readonly inputSchema: S["input"];
  readonly successSchema: S["success"];
  readonly errorSchema: S["error"];
  readonly build: Effect.Effect<Graph, DefinitionError>;
}

const attempt = <A>(body: () => A) =>
  Effect.try({ catch: definitionError, try: body });

interface ParentScope {
  readonly allowed: ReadonlyMap<symbol, ReadonlySet<string>>;
  readonly input: Ref.Ref<unknown>;
  readonly depth: number;
}

function buildScope(
  spec: Spec,
  construction: (
    scope: symbol
  ) => Effect.Effect<unknown, DefinitionError, Builder>,
  parent?: ParentScope,
  special?: string
): Effect.Effect<Graph, DefinitionError> {
  return Effect.suspend(() => {
    const scope = Symbol(spec.id);
    const inputRef = parent?.input ?? new Ref.Ref(scope, "$input");
    const nodes = new Map<string, Node>();
    const captures = new Set<Ref.Ref<unknown>>();
    const signals = new Map<
      object,
      { readonly schema: Boundary; consumed: boolean }
    >();
    const allowed = new Map(parent?.allowed);
    const known = new Set<string>(parent ? [] : ["$input"]);
    if (special) {
      known.add(special);
    }
    allowed.set(scope, known);
    const references = (
      input: unknown,
      after: readonly Ref.Ref<unknown>[] = []
    ) => {
      const refs = [...Ref.references(input), ...after];
      for (const ref of refs) {
        if (!allowed.get(ref.scope)?.has(ref.nodeId)) {
          throw new DefinitionError({
            message: `Reference outside graph or unavailable node: ${ref.nodeId}`,
          });
        }
        if (ref.scope !== scope) {
          captures.add(ref);
        }
      }
      return {
        dependencies: [...new Set(refs.map((ref) => ref.nodeId))],
        refs,
      };
    };
    const childContext = (): ParentScope => {
      const depth = (parent?.depth ?? 0) + 1;
      boundedInteger(depth, 16, "Graph nesting depth");
      return {
        allowed: new Map([...allowed].map(([id, ids]) => [id, new Set(ids)])),
        depth,
        input: inputRef,
      };
    };
    const register = <A>(node: Node): Ref.Ref<A> => {
      identifier(node.id);
      if (nodes.has(node.id)) {
        throw new DefinitionError({ message: `Duplicate node: ${node.id}` });
      }
      boundedInteger(nodes.size + 1, 1000, "Nodes per graph scope");
      nodes.set(node.id, Object.freeze(node));
      known.add(node.id);
      return new Ref.Ref<A>(scope, node.id);
    };
    const wait = <A>(
      kind: WaitNode["kind"],
      id: string,
      options: WaitOptions & { readonly schema?: Boundary }
    ) =>
      attempt(() => {
        durationMillis(options.timeout);
        return register<A>({
          ...options,
          ...references(options.context, options.after),
          id,
          kind,
        });
      });
    const builder: GraphBuilder = {
      approval: (id, options) => wait("Approval", id, options),
      awaitSignal: (id, signal, options = {}) =>
        attempt(() => {
          const registration = signals.get(signal);
          if (!registration || registration.consumed) {
            throw new DefinitionError({
              message:
                "Signal requires exactly one await in its registration scope",
            });
          }
          registration.consumed = true;
          return register({
            address: signal.address,
            id,
            kind: "AwaitSignal",
            schema: registration.schema,
            ...references(signal.address, options.after),
          });
        }),
      branch: (id, condition, cases) =>
        Effect.gen(function* () {
          const context = yield* attempt(childContext);
          const onTrue = yield* buildScope(spec, () => cases.onTrue, context);
          const onFalse = yield* buildScope(spec, () => cases.onFalse, context);
          return yield* attempt(() =>
            register({
              condition,
              id,
              kind: "Branch",
              onFalse,
              onTrue,
              success: cases.success,
              ...references([
                condition,
                ...onTrue.captures,
                ...onFalse.captures,
              ]),
            })
          );
        }),
      forEach: (id, items, options, itemConstruction) =>
        Effect.gen(function* () {
          yield* attempt(() => {
            boundedInteger(options.concurrency, 100, "Item concurrency");
            boundedInteger(options.maxItems, 1000, "Maximum items");
          });
          const context = yield* attempt(childContext);
          const graph = yield* buildScope(
            spec,
            (itemScope) => itemConstruction(new Ref.Ref(itemScope, "$item")),
            context,
            "$item"
          );
          return yield* attempt(() =>
            register<readonly (typeof options.success.Type)[]>({
              ...options,
              graph,
              id,
              items,
              key: (value) => options.key(value as typeof options.item.Type),
              kind: "ForEach",
              ...references([items, ...graph.captures]),
            })
          );
        }),
      input: (schema) =>
        attempt(() => {
          if (schema !== spec.input) {
            throw new DefinitionError({
              message: `Input codec does not match workflow ${spec.id}`,
            });
          }
          return new Ref.Ref(inputRef.scope, inputRef.nodeId);
        }),
      map: (id, mapSpec, compute) =>
        attempt(() =>
          register({
            // The public generic relates the compute input to its reference. The IR erases it.
            compute: (value) => compute(value as typeof mapSpec.input.Type),
            ...references(mapSpec.input),
            id,
            input: mapSpec.input,
            kind: "Map",
            success: mapSpec.success,
          })
        ),
      registerSignal: (id, options) =>
        Effect.gen(function* () {
          const address = yield* wait<typeof SignalAddress.Type>(
            "SignalRegistration",
            id,
            options
          );
          const signal: Signal<typeof options.schema.Type> = Object.freeze({
            address,
            [signalType]: (value: typeof options.schema.Type) => value,
          });
          signals.set(signal, { consumed: false, schema: options.schema });
          return signal;
        }),
      requestInput: (id, options) => wait("Input", id, options),
      sleep: (id, duration, options = {}) =>
        attempt(() => {
          durationMillis(duration, true);
          return register({
            duration,
            id,
            kind: "Sleep",
            ...references(null, options.after),
          });
        }),
      task: (id, task, input, options = {}) =>
        attempt(() =>
          register({
            ...references(input, options.after),
            id,
            input,
            kind: "Task",
            options,
            task,
          })
        ),
      waitForSignal: (id, options) => wait("Signal", id, options),
      workflow: (id, workflow, input, options = {}) =>
        attempt(() =>
          register({
            id,
            input,
            kind: "Workflow",
            options,
            workflow,
            ...references(input, options.after),
          })
        ),
    };
    return construction(scope).pipe(
      Effect.provideService(Builder, builder),
      Effect.flatMap((result) =>
        attempt(() => {
          references(result);
          if ([...signals.values()].some((signal) => !signal.consumed)) {
            throw new DefinitionError({
              message: "Signal registration requires an await consumer",
            });
          }
          return Object.freeze({
            captures: Object.freeze([...captures]),
            nodes: Object.freeze([...nodes.values()]),
            result,
            scope,
          });
        })
      )
    );
  });
}

export function make<const S extends Spec>(
  spec: S,
  construction: Effect.Effect<
    Ref.Input<NoInfer<S["success"]["Type"]>>,
    DefinitionError,
    Builder
  >
): Definition<S> {
  identifier(spec.id);
  version(spec.version);
  const metadata = declarations("tags" in spec ? spec.tags : {});
  return Object.freeze({
    ...metadata,
    build: buildScope(spec, () => construction),
    errorSchema: spec.error,
    id: spec.id,
    inputSchema: spec.input,
    kind: "Workflow",
    spec,
    successSchema: spec.success,
  });
}

/** Walk every declared scope; inactive branches remain visible to validation/planning. */
export function allNodes(graph: Graph): readonly Node[] {
  return graph.nodes.flatMap((node) => {
    if (node.kind === "Task") {
      return [
        node,
        ...(node.patches ?? []).flatMap((patch) => allNodes(patch.graph)),
      ];
    }
    if (node.kind === "Branch") {
      return [node, ...allNodes(node.onTrue), ...allNodes(node.onFalse)];
    }
    if (node.kind === "ForEach") {
      return [node, ...allNodes(node.graph)];
    }
    return [node];
  });
}
