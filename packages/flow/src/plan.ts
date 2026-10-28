/** Planning: run Task bodies and build the DAG with `effect/Graph`. */
import { Effect, Graph, Schema } from "effect";

import { PlanError } from "./errors.ts";
import { Planner } from "./services.ts";
import type {
  AnyTask,
  ErrorOf,
  InputArgs,
  OutputOf,
  ServicesOf,
} from "./task.ts";

export interface PlanNode {
  readonly key: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly labels: readonly string[];
}

export interface PlannedNode {
  readonly node: PlanNode;
  readonly index: Graph.NodeIndex;
  readonly task: AnyTask;
  /** Keys of the nodes this one runs after. */
  readonly dependencies: readonly string[];
  readonly run: Effect.Effect<unknown, unknown, unknown>;
}

const PlanTypeId: unique symbol = Symbol.for("effectory/flow/Plan");

export interface Plan<out A, out E, out R> {
  readonly [PlanTypeId]: {
    readonly _A: (_: never) => A;
    readonly _E: (_: never) => E;
    readonly _R: (_: never) => R;
  };
  /** Key of the planned Task. */
  readonly root: string;
  /** Edges point from a dependency to the node that runs after it. */
  readonly graph: Graph.DirectedGraph<PlanNode, null>;
  /** Node keys with every dependency before its dependents. */
  readonly order: readonly string[];
  readonly nodes: ReadonlyMap<string, PlannedNode>;
}

/** A node's identity: its Task name and encoded input. */
const keyOf = (task: AnyTask, input: unknown) =>
  Schema.encodeUnknownEffect(task.input)(input).pipe(
    Effect.map((encoded) => `${task.name}(${JSON.stringify(encoded)})`),
    Effect.mapError(
      (cause) =>
        new PlanError({
          cause,
          message: `Invalid input for ${task.name}: ${cause.message}`,
        })
    )
  );

/**
 * Build the DAG rooted at `task(input)`. Each Task body runs once per distinct
 * input; repeated `After`s of one Task and input share a node. Cycles fail
 * with a PlanError naming the path.
 *
 * Bodies run with the caller's services, so planning requires the same
 * services as running.
 */
export const plan = <T extends AnyTask>(
  task: T,
  ...[input]: InputArgs<T>
): Effect.Effect<
  Plan<OutputOf<T>, ErrorOf<T>, ServicesOf<T>>,
  PlanError | ErrorOf<T>,
  ServicesOf<T>
> =>
  Effect.gen(function* planTask() {
    const planned = new Map<string, Omit<PlannedNode, "index">>();
    const visiting: string[] = [];

    const visit = (
      current: AnyTask,
      value: unknown
    ): Effect.Effect<string, unknown, unknown> =>
      Effect.gen(function* visitTask() {
        const key = yield* keyOf(current, value);
        if (visiting.includes(key)) {
          const path = [...visiting.slice(visiting.indexOf(key)), key];
          return yield* new PlanError({
            message: `Cycle: ${path.join(" -> ")}`,
          });
        }
        if (planned.has(key)) {
          return key;
        }
        visiting.push(key);
        const dependencies: string[] = [];
        const planner = Planner.of({
          after: (dependency, dependencyInput) =>
            visit(dependency, dependencyInput).pipe(
              Effect.tap((dependencyKey) =>
                Effect.sync(() => {
                  if (!dependencies.includes(dependencyKey)) {
                    dependencies.push(dependencyKey);
                  }
                })
              )
            ) as Effect.Effect<string, PlanError>,
        });
        const step = yield* current
          .body(value)
          .pipe(Effect.provideService(Planner, planner));
        visiting.pop();
        planned.set(key, {
          dependencies,
          node: {
            description: current.description,
            key,
            labels: current.labels,
            name: current.name,
          },
          run: step.run,
          task: current,
        });
        return key;
      });

    const root = yield* visit(task, input);

    const nodes = new Map<string, PlannedNode>();
    const graph = Graph.directed<PlanNode, null>((mutable) => {
      for (const [key, entry] of planned) {
        nodes.set(key, { ...entry, index: Graph.addNode(mutable, entry.node) });
      }
      for (const entry of nodes.values()) {
        for (const dependency of entry.dependencies) {
          const from = nodes.get(dependency);
          if (from) {
            Graph.addEdge(mutable, from.index, entry.index, null);
          }
        }
      }
    });
    const order = [...Graph.values(Graph.topo(graph))].map((node) => node.key);

    return {
      [PlanTypeId]: { _A: (_) => _, _E: (_) => _, _R: (_) => _ },
      graph,
      nodes,
      order,
      root,
    } satisfies Plan<unknown, unknown, unknown>;
  }) as never;

/** Render a plan as a Mermaid flowchart labelled by node key. */
export const toMermaid = (self: Plan<unknown, unknown, unknown>): string =>
  Graph.toMermaid(self.graph, {
    edgeLabel: () => "",
    nodeLabel: (node) => node.key,
  });
