import { Effect } from "effect";

import type { RegisteredTask } from "./application.ts";
import type * as Artifact from "./artifact.ts";
import { DefinitionError } from "./errors.ts";
import * as Extension from "./extension.ts";
import type { SelectedPatch } from "./patch-compiler.ts";
import type * as Workflow from "./workflow.ts";

export interface Provenance {
  readonly id: string;
  readonly version: string;
  readonly digest: string | null;
  readonly implementations: readonly string[];
  readonly patches: readonly Extension.Binding[];
}

function selectContributions(
  selection: Extension.Use,
  definition: Extension.Definition,
  seenProviders: Set<string>,
  seenPatches: Set<string>,
  seenBindings: Set<string>
) {
  return Effect.gen(function* () {
    const replacements: Extension.Implementation[] = [];
    const patches: SelectedPatch[] = [];
    const providers = new Map<string, Extension.Implementation>();
    for (const provider of definition.implementations) {
      if (seenProviders.has(provider.providerId)) {
        return yield* new DefinitionError({
          message: `Duplicate provider: ${provider.providerId}`,
        });
      }
      seenProviders.add(provider.providerId);
      providers.set(provider.providerId, provider);
    }
    const selectedIds = selection.selection.implementations ?? [];
    if (new Set(selectedIds).size !== selectedIds.length) {
      return yield* new DefinitionError({
        message: `Duplicate implementation selection: ${definition.id}`,
      });
    }
    for (const id of selectedIds) {
      const provider = providers.get(id);
      if (!provider) {
        return yield* new DefinitionError({
          message: `Unknown extension implementation: ${id}`,
        });
      }
      replacements.push(provider);
    }
    const declaredPatches = new Map<
      string,
      (typeof definition.patches)[number]
    >();
    for (const patch of definition.patches) {
      if (seenPatches.has(patch.id)) {
        return yield* new DefinitionError({
          message: `Duplicate patch definition: ${patch.id}`,
        });
      }
      seenPatches.add(patch.id);
      declaredPatches.set(patch.id, patch);
    }
    for (const binding of selection.selection.patches ?? []) {
      const patch = declaredPatches.get(binding.use);
      if (!patch || seenBindings.has(binding.id) || patches.length >= 256) {
        return yield* new DefinitionError({
          message: `Unknown, duplicate, or excessive patch binding: ${binding.id}`,
        });
      }
      seenBindings.add(binding.id);
      patches.push({
        binding,
        definition: patch,
        extensionId: definition.id,
      });
    }
    return { patches, replacements };
  });
}

export function resolve(
  selections: readonly Extension.Use[],
  localTasks: readonly RegisteredTask[],
  localWorkflows: readonly Workflow.Definition[],
  localArtifacts: readonly Artifact.Artifact[]
) {
  return Effect.gen(function* () {
    if (selections.length > 128) {
      return yield* new DefinitionError({
        message: "At most 128 extensions may be selected",
      });
    }
    const tasks = new Map<string, RegisteredTask>();
    const workflows = [...localWorkflows];
    const artifacts = new Map<string, Artifact.Artifact>();
    const extensions: Provenance[] = [];
    const patches: SelectedPatch[] = [];
    const replacements: Extension.Implementation[] = [];
    const seenExtensions = new Set<string>();
    const seenProviders = new Set<string>();
    const seenPatches = new Set<string>();
    const seenBindings = new Set<string>();
    const contributed = [...localTasks];
    const artifactDefinitions = [...localArtifacts];
    for (const selection of selections) {
      const definition = yield* Extension.load(selection);
      if (seenExtensions.has(definition.id)) {
        return yield* new DefinitionError({
          message: `Duplicate extension: ${definition.id}`,
        });
      }
      seenExtensions.add(definition.id);
      contributed.push(...Object.values(definition.tasks));
      workflows.push(...Object.values(definition.workflows));
      artifactDefinitions.push(...Object.values(definition.artifacts));
      const contributions = yield* selectContributions(
        selection,
        definition,
        seenProviders,
        seenPatches,
        seenBindings
      );
      patches.push(...contributions.patches);
      replacements.push(...contributions.replacements);
      if (patches.length > 256) {
        return yield* new DefinitionError({
          message: "At most 256 patch bindings may be selected",
        });
      }
      extensions.push(
        Object.freeze({
          digest:
            selection.extension.kind === "InstalledExtension"
              ? selection.extension.digest
              : null,
          id: definition.id,
          implementations: selection.selection.implementations ?? [],
          patches: selection.selection.patches ?? [],
          version: definition.version,
        })
      );
    }
    for (const task of contributed) {
      if (tasks.has(task.id)) {
        return yield* new DefinitionError({
          message: `Duplicate task: ${task.id}`,
        });
      }
      tasks.set(task.id, task);
      artifactDefinitions.push(...Object.values(task.spec.outputs ?? {}));
    }
    const selectedTargets = new Map<string, string>();
    for (const provider of replacements) {
      const prior = selectedTargets.get(provider.id);
      if (prior !== undefined) {
        return yield* new DefinitionError({
          message: `Conflicting implementations for ${provider.id}: ${prior}, ${provider.providerId}`,
        });
      }
      if (tasks.get(provider.id)?.spec !== provider.spec) {
        return yield* new DefinitionError({
          message: `Missing or noncanonical replacement target: ${provider.id}`,
        });
      }
      selectedTargets.set(provider.id, provider.providerId);
      tasks.set(provider.id, provider);
    }
    for (const artifact of artifactDefinitions) {
      const key = JSON.stringify([artifact.id, artifact.version]);
      const prior = artifacts.get(key);
      if (prior && prior !== artifact) {
        return yield* new DefinitionError({
          message: `Noncanonical artifact: ${artifact.id}@${artifact.version}`,
        });
      }
      artifacts.set(key, artifact);
    }
    return {
      artifacts,
      extensions: Object.freeze(extensions),
      patches,
      tasks,
      workflows,
    };
  });
}
