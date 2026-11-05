import { Effect } from "effect";

import { DefinitionError, definitionError } from "./errors.ts";
import type * as Extension from "./extension.ts";
import type * as WorkflowPatch from "./workflow-patch.ts";
import type * as Workflow from "./workflow.ts";

export interface SelectedPatch {
  readonly extensionId: string;
  readonly binding: Extension.Binding;
  readonly definition: WorkflowPatch.Definition;
}

function attach(
  graph: Workflow.Graph,
  path: Extension.Binding["at"],
  selected: SelectedPatch,
  patch: Workflow.AppliedPatch
): Workflow.Graph {
  const [id, segment, ...rest] = path;
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (typeof id !== "string" || !node) {
    throw new DefinitionError({
      message: `Missing patch target: ${selected.binding.id}`,
    });
  }
  let replacement: Workflow.Node;
  if (segment === undefined) {
    if (
      node.kind !== "Task" ||
      node.task.spec !== selected.definition.target.spec
    ) {
      throw new DefinitionError({
        message: `Noncanonical patch target: ${selected.binding.id}`,
      });
    }
    replacement = Object.freeze({
      ...node,
      patches: Object.freeze([...(node.patches ?? []), patch]),
    });
  } else if (
    node.kind === "Branch" &&
    typeof segment === "object" &&
    "branch" in segment
  ) {
    replacement = Object.freeze({
      ...node,
      [segment.branch]: attach(node[segment.branch], rest, selected, patch),
    });
  } else if (
    node.kind === "ForEach" &&
    typeof segment === "object" &&
    "item" in segment
  ) {
    replacement = Object.freeze({
      ...node,
      graph: attach(node.graph, rest, selected, patch),
    });
  } else {
    throw new DefinitionError({
      message: `Invalid patch scope: ${selected.binding.id}`,
    });
  }
  return Object.freeze({
    ...graph,
    nodes: Object.freeze(
      graph.nodes.map((candidate) =>
        candidate === node ? replacement : candidate
      )
    ),
  });
}

function validateTargetOrder(node: Workflow.TaskNode): void {
  const patches = new Map(
    (node.patches ?? []).map((patch) => [patch.id, patch])
  );
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) {
      return;
    }
    const patch = patches.get(id);
    if (!patch) {
      throw new DefinitionError({
        message: `Patch ordering dependency must name a binding on the same target: ${id}`,
      });
    }
    if (visiting.has(id)) {
      throw new DefinitionError({ message: `Patch ordering cycle: ${id}` });
    }
    visiting.add(id);
    for (const prior of patch.after) {
      visit(prior);
    }
    visiting.delete(id);
    done.add(id);
  };
  for (const id of patches.keys()) {
    visit(id);
  }
}

function validateOrder(graph: Workflow.Graph): void {
  for (const node of graph.nodes) {
    if (node.kind === "Branch") {
      validateOrder(node.onTrue);
      validateOrder(node.onFalse);
    } else if (node.kind === "ForEach") {
      validateOrder(node.graph);
    } else if (node.kind === "Task") {
      validateTargetOrder(node);
    }
  }
}

export function apply(
  workflow: Workflow.Definition,
  original: Workflow.Graph,
  selections: readonly SelectedPatch[]
): Effect.Effect<Workflow.Graph, DefinitionError> {
  return Effect.gen(function* () {
    let graph = original;
    for (const selected of selections) {
      if (selected.binding.workflow.id !== workflow.id) {
        continue;
      }
      if (selected.binding.workflow.version !== workflow.spec.version) {
        return yield* new DefinitionError({
          message: `Patch workflow version mismatch: ${selected.binding.id}`,
        });
      }
      const patchGraph = yield* selected.definition.build;
      const previous = graph;
      graph = yield* Effect.try({
        catch: definitionError,
        try: () =>
          attach(
            previous,
            selected.binding.at,
            selected,
            Object.freeze({
              after: Object.freeze([...(selected.binding.after ?? [])]),
              definitionId: selected.definition.id,
              extensionId: selected.extensionId,
              graph: patchGraph,
              id: selected.binding.id,
            })
          ),
      });
    }
    yield* Effect.try({
      catch: definitionError,
      try: () => validateOrder(graph),
    });
    return graph;
  });
}
