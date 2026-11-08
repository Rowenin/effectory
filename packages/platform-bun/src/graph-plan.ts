import type { Application, Workflow } from "@offtree/effectory-sdk";
import type { Schema } from "effect";

/** Templates retain every declared branch; this is a plan, not a prediction. */
export function graphPlan(
  graph: Workflow.Graph,
  registry: typeof Application.Registry.Service
): Schema.Json {
  return graph.nodes.map((node): Schema.Json => {
    const common = {
      dependencies: node.dependencies,
      id: node.id,
      kind: node.kind,
    };
    switch (node.kind) {
      case "Task": {
        return {
          ...common,
          patches: (node.patches ?? []).map((patch) => ({
            after: patch.after,
            definitionId: patch.definitionId,
            extensionId: patch.extensionId,
            id: patch.id,
            nodes: graphPlan(patch.graph, registry),
          })),
          providerId: registry.tasks.get(node.task.id)?.providerId ?? null,
          taskId: node.task.id,
        };
      }
      case "Branch": {
        return {
          ...common,
          onFalse: graphPlan(node.onFalse, registry),
          onTrue: graphPlan(node.onTrue, registry),
        };
      }
      case "ForEach": {
        return {
          ...common,
          concurrency: node.concurrency,
          items: graphPlan(node.graph, registry),
          maxItems: node.maxItems,
        };
      }
      case "Workflow": {
        return {
          ...common,
          version: node.workflow.spec.version,
          workflowId: node.workflow.id,
        };
      }
      default: {
        return common;
      }
    }
  });
}
