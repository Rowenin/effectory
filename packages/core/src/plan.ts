/**
 * Planning: run a workflow body with a collecting Registry and build the plan
 * graph with `effect/Graph`. Planning has no side effects beyond providers'
 * `read` and State lookups.
 */
import { Data, Effect, Graph } from "effect";

import * as Node from "./node.ts";
import type { NodeKind, NodeSpec, PlannedChange, RunInfo } from "./node.ts";
import * as Output from "./output.ts";
import type { StateShape } from "./state.ts";
import type * as Workflow from "./workflow.ts";

export class PlanError extends Data.TaggedError("PlanError")<{
  readonly message: string;
}> {}

export interface PlanNode {
  readonly fqn: string;
  readonly kind: NodeKind;
  readonly type: string;
}

export type PlanGraph = Graph.DirectedGraph<PlanNode, null>;

export interface Built {
  readonly info: RunInfo;
  readonly specs: ReadonlyMap<string, NodeSpec>;
  /** FQNs in topological order. */
  readonly order: readonly string[];
  readonly graph: PlanGraph;
  /** The body's return value; may contain Outputs. */
  readonly returned: unknown;
}

/**
 * Run `body` with a Registry that collects node specs. Specs may depend only
 * on nodes in `known` or registered earlier in the same body.
 */
export const collect = <A, E, R>(
  info: RunInfo,
  body: Effect.Effect<A, E, R>,
  known: ReadonlySet<string> = new Set()
): Effect.Effect<
  { readonly specs: readonly NodeSpec[]; readonly value: A },
  E | PlanError,
  Exclude<R, Node.Registry>
> =>
  Effect.gen(function* collectNodes() {
    const specs: NodeSpec[] = [];
    const seen = new Set<string>();
    let failure: PlanError | undefined;
    const registry = Node.Registry.of({
      info,
      register: (spec) =>
        Effect.sync(() => {
          if (seen.has(spec.fqn) || known.has(spec.fqn)) {
            failure ??= new PlanError({
              message: `Duplicate node: ${spec.fqn}`,
            });
            return;
          }
          for (const dep of Node.dependencies(spec)) {
            if (!seen.has(dep) && !known.has(dep)) {
              failure ??= new PlanError({
                message: `Node ${spec.fqn} depends on unknown node ${dep}`,
              });
            }
          }
          seen.add(spec.fqn);
          specs.push(spec);
        }),
    });
    const value = yield* Effect.provideService(body, Node.Registry, registry);
    if (failure) {
      return yield* failure;
    }
    return { specs, value };
  }) as never;

/** Build a plan graph from specs; rejects cycles. */
export const graphOf = (
  specs: readonly NodeSpec[]
): Effect.Effect<{ graph: PlanGraph; order: readonly string[] }, PlanError> =>
  Effect.suspend(() => {
    const index = new Map<string, number>();
    const graph = Graph.directed<PlanNode, null>((mutable) => {
      for (const spec of specs) {
        index.set(
          spec.fqn,
          Graph.addNode(mutable, {
            fqn: spec.fqn,
            kind: spec.kind,
            type: spec.type,
          })
        );
      }
      for (const spec of specs) {
        for (const dep of Node.dependencies(spec)) {
          const from = index.get(dep);
          const to = index.get(spec.fqn);
          if (from !== undefined && to !== undefined) {
            Graph.addEdge(mutable, from, to, null);
          }
        }
      }
    });
    const cycle = Graph.findCycle(graph);
    if (cycle._tag === "Some") {
      const path = cycle.value.path
        .map((node) => Graph.getNode(graph, node))
        .map((node) => (node._tag === "Some" ? node.value.fqn : "?"));
      return Effect.fail(
        new PlanError({ message: `Cycle: ${path.join(" -> ")}` })
      );
    }
    const order = [...Graph.values(Graph.topo(graph))].map((node) => node.fqn);
    return Effect.succeed({ graph, order });
  });

/** Decode nothing, register everything: the plan for an already-decoded input. */
export const build = <I, O, R>(
  workflow: Workflow.Workflow<string, I, O, R>,
  input: I,
  info: RunInfo
): Effect.Effect<Built, PlanError, R> =>
  Effect.gen(function* buildPlan() {
    const collected = yield* collect(
      info,
      workflow.body(input).pipe(Node.namespace(workflow.name))
    ).pipe(
      Effect.catchIf(
        (error): error is unknown => !(error instanceof PlanError),
        (error) =>
          Effect.fail(
            new PlanError({
              message: `Workflow body failed: ${error instanceof Error ? error.message : String(error)}`,
            })
          )
      )
    );
    const { graph, order } = yield* graphOf(collected.specs);
    return {
      graph,
      info,
      order,
      returned: collected.value,
      specs: new Map(collected.specs.map((spec) => [spec.fqn, spec])),
    };
  }) as never;

export interface PlanEntry extends PlanNode {
  readonly dependsOn: readonly string[];
  readonly change: PlannedChange;
}

/** What executing the plan would do, per node, in topological order. */
export const describe = (
  built: Built,
  state: StateShape
): Effect.Effect<readonly PlanEntry[]> =>
  Effect.forEach(built.order, (fqn) => {
    const spec = built.specs.get(fqn) as NodeSpec;
    const input = Output.isResolved(spec.input)
      ? { resolved: true as const, value: spec.input }
      : { resolved: false as const };
    const change: Effect.Effect<PlannedChange> = spec.plan
      ? spec.plan({ ...built.info, fqn, input, state }).pipe(
          Effect.catchCause((cause) =>
            Effect.succeed<PlannedChange>({
              action: "unknown",
              detail: String(cause),
            })
          )
        )
      : Effect.succeed({ action: "run" });
    return Effect.map(change, (planned) => ({
      change: planned,
      dependsOn: [...Node.dependencies(spec)],
      fqn,
      kind: spec.kind,
      type: spec.type,
    }));
  });

/** One line per node: `create  verify-pr/summary (GitHub.PullRequestComment)`. */
export const renderText = (entries: readonly PlanEntry[]): string =>
  entries
    .map((entry) => {
      const detail = entry.change.detail ? `  ${entry.change.detail}` : "";
      const after =
        entry.dependsOn.length > 0 ? `  <- ${entry.dependsOn.join(", ")}` : "";
      return `${entry.change.action.padEnd(8)} ${entry.fqn} (${entry.type})${after}${detail}`;
    })
    .join("\n");

const shapes: Partial<Record<NodeKind, Graph.MermaidNodeShape>> = {
  approve: "diamond",
  assert: "diamond",
  resource: "rounded",
};

/** Mermaid flowchart of the plan. */
export const renderMermaid = (graph: PlanGraph): string =>
  Graph.toMermaid(graph, {
    // Edges carry no data; the default `String(null)` would label each one "null".
    edgeLabel: () => "",
    nodeLabel: (node) => `${node.fqn}\n${node.type}`,
    nodeShape: (node) => shapes[node.kind] ?? "rectangle",
  });

/** Persistable form of the plan graph. */
export const snapshot = (graph: PlanGraph): unknown => Graph.toSnapshot(graph);

/** The FQNs in a persisted snapshot. */
export const snapshotNodes = (value: unknown): readonly string[] =>
  Graph.fromSnapshot(value as Graph.Snapshot<PlanNode, null, "directed">)
    .pipe((graph) => [...Graph.values(Graph.nodes(graph))])
    .map((node) => node.fqn);
