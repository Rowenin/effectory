import { Schema } from "effect";

import type { Registry } from "./application.ts";
import { DefinitionError } from "./errors.ts";
import {
  normalizeSelection,
  SelectionDecision,
} from "./report-selection-schema.ts";
import { normalize } from "./tag-state.ts";
import type * as Tag from "./tag.ts";
import * as Workflow from "./workflow.ts";

export interface Selection {
  readonly only?: readonly string[];
  readonly onlyTags?: Tag.Input;
  readonly skip?: readonly string[];
  readonly skipAll?: boolean;
  readonly skipTags?: Tag.Input;
}
export function authorSelection(input: Selection | undefined) {
  try {
    if (input === undefined) {
      throw new Error("Report selection must be an object");
    }
    return normalizeSelection({
      ...input,
      ...("onlyTags" in input ? { onlyTags: normalize(input.onlyTags) } : {}),
      ...("skipTags" in input ? { skipTags: normalize(input.skipTags) } : {}),
    });
  } catch (error) {
    throw new DefinitionError({
      message: `Invalid report selection: ${String(error).slice(0, 1500)}`,
    });
  }
}

type RegistryView = Pick<typeof Registry.Service, "reports" | "workflows">;
/** Inspect templates, never handlers or input-dependent branch predicates. */
export function reportCandidates(
  registry: RegistryView,
  kind: "task" | "workflow",
  id: string
) {
  const tasks = new Set<string>();
  const visited = new Set<string>();
  const visit = (workflowId: string) => {
    if (visited.has(workflowId)) {
      return;
    }
    visited.add(workflowId);
    const workflow = registry.workflows.get(workflowId);
    if (!workflow) {
      throw new DefinitionError({
        message: `Workflow unavailable: ${workflowId}`,
      });
    }
    for (const node of Workflow.allNodes(workflow.graph)) {
      if (node.kind === "Task") {
        tasks.add(node.task.id);
      }
      if (node.kind === "Workflow") {
        visit(node.workflow.id);
      }
    }
  };
  if (kind === "task") {
    tasks.add(id);
  } else {
    visit(id);
  }
  return [...registry.reports.values()].filter((attachment) =>
    attachment.scope === "invocation"
      ? (attachment.target.kind === "Task" ? tasks : visited).has(
          attachment.target.id
        )
      : attachment.target.id === id &&
        (attachment.target.kind === "Task" ? "task" : "workflow") === kind
  );
}
const match = (
  tags: Readonly<Record<string, string>>,
  wanted: Readonly<Record<string, string>>
) =>
  Object.entries(wanted).every(
    ([key, tag]) => Object.hasOwn(tags, key) && tags[key] === tag
  );

export function selectReports(
  registry: RegistryView,
  kind: "task" | "workflow",
  id: string,
  value: unknown = {}
) {
  const requested = normalizeSelection(value);
  const candidates = reportCandidates(registry, kind, id);
  const ids = new Set(candidates.map((entry) => entry.id));
  const unknown = [
    ...new Set([...(requested.only ?? []), ...(requested.skip ?? [])]),
  ].filter((name) => !ids.has(name));
  if (unknown.length) {
    throw new DefinitionError({
      message: `Unknown or irrelevant report attachments: ${unknown.join(", ").slice(0, 1400)}; see ${kind} describe ${id}`,
    });
  }
  const selected = candidates.filter(
    (entry) =>
      entry.required ||
      (!requested.skipAll &&
        !requested.skip?.includes(entry.id) &&
        !(requested.skipTags && match(entry.tags, requested.skipTags)) &&
        (!requested.only || requested.only.includes(entry.id)) &&
        (!requested.onlyTags || match(entry.tags, requested.onlyTags)))
  );
  const selectedIds = new Set(selected.map((entry) => entry.id));
  const decision = Schema.decodeUnknownSync(SelectionDecision)({
    excluded: candidates
      .filter((entry) => !selectedIds.has(entry.id))
      .map((entry) => entry.id)
      .toSorted(),
    requested,
    required: candidates
      .filter((entry) => entry.required)
      .map((entry) => entry.id)
      .toSorted(),
    selected: [...selectedIds].toSorted(),
  });
  return { decision, selected };
}
