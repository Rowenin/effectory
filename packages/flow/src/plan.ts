/** Planning: run Task bodies and build the DAG with `effect/Graph`. */
import { createHash } from "node:crypto";

import { Effect, Graph, Schema } from "effect";

import { PlanError } from "./errors.ts";
import { Planner } from "./services.ts";
import type {
  AnyTask,
  ErrorOf,
  InputArgs,
  OutputOf,
  ServicesOf,
  TaskKind,
} from "./task.ts";

export interface PlanNode {
  readonly key: string;
  readonly name: string;
  /** `"input"` nodes are where a run may stop to wait for a person. */
  readonly kind: TaskKind;
  /** The node's input as encoded into its key. */
  readonly input: unknown;
  readonly description: string | undefined;
  readonly labels: readonly string[];
  /** Tasks this node may call at run time, declared with `Calls`. */
  readonly calls: readonly {
    readonly name: string;
    readonly kind: TaskKind;
    readonly max: number | undefined;
  }[];
}

export interface PlannedNode {
  readonly node: PlanNode;
  readonly index: Graph.NodeIndex;
  readonly task: AnyTask;
  /** Keys of the nodes this one runs after. */
  readonly dependencies: readonly string[];
  readonly run: Effect.Effect<unknown, unknown, unknown>;
}

/** A planned node before it is placed in the graph. */
export type NodeEntry = Omit<PlannedNode, "index">;

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
  Schema.encodeUnknownEffect(Schema.toCodecJson(task.input))(input).pipe(
    Effect.map((encoded) => ({
      encoded,
      key: `${task.name}(${JSON.stringify(encoded)})`,
    })),
    Effect.mapError(
      (cause) =>
        new PlanError({
          cause,
          message: `Invalid input for ${task.name}: ${cause.message}`,
        })
    )
  );

/**
 * Plan `task(input)` and everything it runs after into `planned`, reusing
 * nodes already there. `path` is the chain of bodies being planned, used to
 * name cycles. `run` reuses this to plan nodes started by calls.
 */
export const visit = (
  planned: Map<string, NodeEntry>,
  current: AnyTask,
  value: unknown,
  path: readonly string[] = []
): Effect.Effect<string, unknown, unknown> =>
  Effect.gen(function* visitTask() {
    const { encoded, key } = yield* keyOf(current, value);
    if (path.includes(key)) {
      const cycle = [...path.slice(path.indexOf(key)), key];
      return yield* new PlanError({ message: `Cycle: ${cycle.join(" -> ")}` });
    }
    if (planned.has(key)) {
      return key;
    }
    const dependencies: string[] = [];
    const calls: PlanNode["calls"][number][] = [];
    const planner = Planner.of({
      after: (dependency, dependencyInput) =>
        visit(planned, dependency, dependencyInput, [...path, key]).pipe(
          Effect.tap((dependencyKey) =>
            Effect.sync(() => {
              if (!dependencies.includes(dependencyKey)) {
                dependencies.push(dependencyKey);
              }
            })
          )
        ) as Effect.Effect<string, PlanError>,
      calls: (task, max) =>
        Effect.sync(() => {
          calls.push({ kind: task.kind, max, name: task.name });
          return { caller: key, max, task };
        }),
    });
    const step = yield* current
      .body(value)
      .pipe(Effect.provideService(Planner, planner));
    planned.set(key, {
      dependencies,
      node: {
        calls,
        description: current.description,
        input: encoded,
        key,
        kind: current.kind,
        labels: current.labels,
        name: current.name,
      },
      run: step.run,
      task: current,
    });
    return key;
  });

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
    const planned = new Map<string, NodeEntry>();
    const root = yield* visit(planned, task, input);

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

/**
 * A hash of the plan's nodes and edges. Called nodes aren't part of a plan, so
 * they don't affect it.
 */
export const fingerprint = (self: Plan<unknown, unknown, unknown>): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        self.order.map((key) => [
          key,
          [...(self.nodes.get(key)?.dependencies ?? [])].toSorted(),
        ])
      )
    )
    .digest("hex");

const escape = (label: string) =>
  label
    .replaceAll('"', "#quot;")
    .replaceAll("(", "#40;")
    .replaceAll(")", "#41;");

const shapes = {
  input: "hexagon",
  task: "rectangle",
  timer: "stadium",
} as const satisfies Record<TaskKind, Graph.MermaidNodeShape>;

const wrap: Record<TaskKind, (label: string) => string> = {
  input: (label) => `{{${label}}}`,
  task: (label) => `[${label}]`,
  timer: (label) => `([${label}])`,
};

/**
 * Render a plan as a Mermaid flowchart labelled by node key. Input nodes are
 * hexagons and Timers are stadiums. Declared calls are dashed edges to the
 * called Task, labelled with their `max`.
 */
export const toMermaid = (self: Plan<unknown, unknown, unknown>): string => {
  const lines = [
    Graph.toMermaid(self.graph, {
      edgeLabel: () => "",
      nodeLabel: (node) => node.key,
      nodeShape: (node) => shapes[node.kind],
    }),
  ];
  const targets = new Map<string, string>();
  for (const { index, node } of self.nodes.values()) {
    for (const call of node.calls) {
      let id = targets.get(call.name);
      if (id === undefined) {
        id = `call${targets.size}`;
        targets.set(call.name, id);
        const label = escape(`${call.name}(…)`);
        lines.push(`  ${id}${wrap[call.kind](`"${label}"`)}`);
      }
      const label = call.max === undefined ? "" : `|"≤${call.max}"|`;
      lines.push(`  ${index} -.->${label} ${id}`);
    }
  }
  return lines.join("\n");
};
