import { Ref, Workflow as WorkflowAuthoring } from "@offtree/effectory-sdk";
import type { Application, Workflow } from "@offtree/effectory-sdk";
import type { Boundary } from "@offtree/effectory-sdk/internal/boundary";
import { decode } from "@offtree/effectory-sdk/internal/boundary";
import { Effect, Schema } from "effect";
import { DurableDeferred } from "effect/workflow";

import {
  ExecutionFailure,
  boundary,
  hostFailure,
} from "./execution-boundary.ts";

export interface ScopeValues {
  readonly path: readonly string[];
  readonly registrations: ReadonlySet<string>;
  readonly values: Map<string, unknown>;
  readonly nodes: ReadonlyMap<string, Workflow.Node>;
}
export interface GraphEnvironment {
  readonly errors: readonly Boundary[];
  readonly scopes: ReadonlyMap<symbol, ScopeValues>;
  readonly path: readonly string[];
  readonly permits: readonly {
    readonly path: string;
    readonly concurrency: number;
  }[];
  readonly budget: { count: number };
}

export function resolve(value: unknown, environment: GraphEnvironment) {
  return Ref.resolve(
    value,
    new Map(),
    new Map(
      [...environment.scopes].map(([scope, state]) => [scope, state.values])
    )
  );
}

export function invocationPath(environment: GraphEnvironment, nodeId: string) {
  return JSON.stringify([...environment.path, nodeId]);
}

/** Resolve a persisted wait path against its exact application revision. */
export function waitDeclaration(
  registry: typeof Application.Registry.Service,
  workflowId: string,
  path: readonly string[]
): Workflow.WaitNode | undefined {
  let graph = registry.workflows.get(workflowId)?.graph;
  let position = 0;
  while (graph) {
    const id = path[position];
    const node: Workflow.Node | undefined = graph.nodes.find(
      (item) => item.id === id
    );
    if (!node) {
      return;
    }
    position += 1;
    if (position === path.length) {
      return node.kind === "Approval" ||
        node.kind === "Input" ||
        node.kind === "Signal" ||
        node.kind === "SignalRegistration"
        ? node
        : undefined;
    }
    if (node.kind === "Branch") {
      graph = path[position] === "true" ? node.onTrue : node.onFalse;
      position += 1;
    } else if (node.kind === "ForEach") {
      ({ graph } = node);
      position += 1;
    } else if (node.kind === "Workflow") {
      graph = registry.workflows.get(node.workflow.id)?.graph;
    } else if (node.kind === "Task" && path[position] === "$patch") {
      const bindingId = path[position + 1];
      graph = node.patches?.find((patch) => patch.id === bindingId)?.graph;
      position += 2;
    } else {
      return;
    }
  }
}

export function nodeCodec(node: Workflow.Node): Boundary {
  switch (node.kind) {
    case "Task": {
      return node.task.successSchema;
    }
    case "Workflow": {
      return node.workflow.successSchema;
    }
    case "Map":
    case "Branch": {
      return node.success;
    }
    case "ForEach": {
      return Schema.Array(node.success);
    }
    case "Approval": {
      return Schema.TaggedStruct("ApprovalPermit", {});
    }
    case "SignalRegistration": {
      return WorkflowAuthoring.SignalAddress;
    }
    case "AwaitSignal": {
      return node.schema;
    }
    case "Input":
    case "Signal": {
      if (!node.schema) {
        throw new Error("Wait codec is missing");
      }
      return node.schema;
    }
    case "Sleep": {
      return Schema.Null;
    }
    default: {
      const unreachable: never = node;
      throw new Error(`Unsupported node: ${String(unreachable)}`);
    }
  }
}

export const nodeResultName = (path: string) => `node/${path}`;
// Effect 4 (checked through 4.1.2) names the deferred owned by raceAll with this prefix. A one-arm
// race gives each node a held activity scope and a cached, engine-owned result.
export const nodeResult = (path: string) =>
  DurableDeferred.make(`raceAll/${nodeResultName(path)}`, {
    error: ExecutionFailure,
    success: Schema.Json,
  });

export function awaitReferences(
  refs: readonly Ref.Ref<unknown>[],
  environment: GraphEnvironment
) {
  return Effect.forEach(
    refs,
    (ref) =>
      Effect.gen(function* () {
        const scope = environment.scopes.get(ref.scope);
        if (!scope) {
          return yield* hostFailure("Reference scope is unavailable");
        }
        if (scope.values.has(ref.nodeId)) {
          return;
        }
        const node = scope.nodes.get(ref.nodeId);
        if (!node) {
          return yield* hostFailure("Reference node is unavailable");
        }
        const value = yield* DurableDeferred.await(
          nodeResult(JSON.stringify([...scope.path, ref.nodeId]))
        );
        scope.values.set(
          ref.nodeId,
          node.kind === "Sleep"
            ? undefined
            : yield* boundary(() => decode(nodeCodec(node), value))
        );
      }),
    { discard: true }
  );
}

export function awaitDependencies(
  node: Workflow.Node,
  environment: GraphEnvironment
) {
  // Captures describe possible edges for planning. Only the selected branch's
  // graph awaits its captures; inactive scopes must not delay active work.
  let { refs } = node;
  if (node.kind === "Branch") {
    refs = [node.condition];
  }
  if (node.kind === "ForEach") {
    refs = [node.items];
  }
  return awaitReferences(refs, environment);
}
