import type { Application } from "@offtree/effectory-sdk";
import { Workflow } from "@offtree/effectory-sdk";
import {
  boundedInteger,
  durationMillis,
} from "@offtree/effectory-sdk/internal/policy";

function validateRetry(
  registry: typeof Application.Registry.Service,
  node: Workflow.TaskNode,
  retry: NonNullable<Workflow.NodeOptions["retry"]>
) {
  const task = registry.tasks.get(node.task.id);
  if (task?.spec.replay !== "idempotent") {
    throw new Error("Retries require idempotent replay");
  }
  boundedInteger(retry.attempts, 10, "Retry attempts");
  durationMillis(retry.delay);
  boundedInteger(retry.when.length, 32, "Retry error tags");
  if (
    retry.when.some(
      (tag) => typeof tag !== "string" || tag.length === 0 || tag.length > 200
    )
  ) {
    throw new Error("Invalid retry tag");
  }
}

function validateTaskPolicy(
  registry: typeof Application.Registry.Service,
  node: Workflow.TaskNode
) {
  if (node.options.timeout !== undefined) {
    durationMillis(node.options.timeout);
  }
  if (node.options.attemptTimeout !== undefined) {
    durationMillis(node.options.attemptTimeout);
  }
  if (node.options.retry) {
    validateRetry(registry, node, node.options.retry);
  }
}

export function validatePolicies(
  registry: typeof Application.Registry.Service,
  id: string,
  seen = new Set<string>()
) {
  if (seen.has(id)) {
    return;
  }
  seen.add(id);
  const workflow = registry.workflows.get(id);
  if (!workflow) {
    throw new Error("Workflow unavailable");
  }
  const policy = workflow.definition.spec.execution;
  if (policy?.timeout !== undefined) {
    durationMillis(policy.timeout);
  }
  if (policy?.concurrency !== undefined) {
    boundedInteger(policy.concurrency, 100, "Workflow concurrency");
  }
  for (const node of Workflow.allNodes(workflow.graph)) {
    if (node.kind === "Task") {
      validateTaskPolicy(registry, node);
    }
    if (node.kind === "Workflow") {
      if (node.options.timeout !== undefined) {
        durationMillis(node.options.timeout);
      }
      validatePolicies(registry, node.workflow.id, seen);
    }
    if (
      node.kind === "Approval" ||
      node.kind === "Input" ||
      node.kind === "Signal" ||
      node.kind === "SignalRegistration"
    ) {
      durationMillis(node.timeout);
    }
  }
}
