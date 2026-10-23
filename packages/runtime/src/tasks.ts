import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Config } from "@effectory/sdk/effectory";
import { Context, Layer, Schema } from "effect";
import type * as Workflow from "effect/workflow/Workflow";

import { workspaceEntrypoint } from "./entrypoint.ts";
import { fingerprintTask } from "./fingerprint.ts";
import { importRegistration } from "./registration.ts";
import { TaskCatalogError } from "./task.ts";
import type { RegisteredTask, TaskDirectory } from "./task.ts";

const importedSources = new Map<string, string>();
const sourceDigest = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

const taskName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const record = (value: unknown): value is Record<string, unknown> =>
  (typeof value === "object" && value !== null) || typeof value === "function";

/** Filesystem-only listing. Does not import or execute automation modules. */
export const listTaskDirectories = (workspace: string): TaskDirectory[] => {
  const effectory = path.join(realpathSync(workspace), ".effectory");
  if (!existsSync(effectory)) {
    return [];
  }
  if (
    lstatSync(effectory).isSymbolicLink() ||
    !lstatSync(effectory).isDirectory()
  ) {
    throw new TaskCatalogError(
      ".effectory must be a real directory, not a symlink"
    );
  }
  const directory = path.join(effectory, "automations");
  if (!existsSync(directory)) {
    return [];
  }
  if (
    lstatSync(directory).isSymbolicLink() ||
    !lstatSync(directory).isDirectory()
  ) {
    throw new TaskCatalogError(
      ".effectory/automations must be a real directory, not a symlink"
    );
  }
  const identities = new Set<string>();
  const tasks: TaskDirectory[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted(
    (a, b) => a.name.localeCompare(b.name)
  )) {
    if (entry.isSymbolicLink()) {
      throw new TaskCatalogError(
        `.effectory/automations/${entry.name}: symlinks are unsupported`
      );
    }
    if (!entry.isDirectory() || entry.name === "shared") {
      continue;
    }
    const entrypoint = path.join(directory, entry.name, "index.ts");
    if (!existsSync(entrypoint)) {
      continue;
    }
    if (!taskName.test(entry.name)) {
      throw new TaskCatalogError(
        `Invalid task directory name: ${entry.name}; use lowercase kebab-case`
      );
    }
    if (identities.has(entry.name)) {
      throw new TaskCatalogError(`Duplicate task directory: ${entry.name}`);
    }
    identities.add(entry.name);
    if (
      lstatSync(entrypoint).isSymbolicLink() ||
      !lstatSync(entrypoint).isFile()
    ) {
      throw new TaskCatalogError(
        `${entrypoint}: index.ts must be a regular file`
      );
    }
    tasks.push({
      directory: path.dirname(entrypoint),
      entrypoint,
      name: entry.name,
    });
  }
  return tasks;
};

const validateManifest = (
  value: unknown,
  task: TaskDirectory,
  fingerprint: RegisteredTask["fingerprint"]
): RegisteredTask => {
  const fail = (message: string): never => {
    throw new TaskCatalogError(`${task.entrypoint}: ${message}`);
  };
  if (!record(value)) {
    return fail("default export must be a task manifest");
  }
  if (value.name !== undefined && value.name !== task.name) {
    return fail(`manifest name must match directory ${task.name}`);
  }
  if (typeof value.description !== "string" || !value.description.trim()) {
    return fail("description must be a nonempty string");
  }
  const { workflow } = value;
  if (
    !record(workflow) ||
    workflow["~effect/workflow/Workflow"] !== "~effect/workflow/Workflow" ||
    typeof workflow._tag !== "string" ||
    !workflow._tag.trim() ||
    typeof workflow.executionId !== "function" ||
    typeof workflow.idempotencyKey !== "function"
  ) {
    return fail("workflow must be a native Workflow with a nonempty tag");
  }
  if (!Context.isContext(workflow.annotations)) {
    return fail("workflow.annotations must be an Effect Context");
  }
  for (const key of ["payloadSchema", "successSchema", "errorSchema"]) {
    if (!Schema.isSchema(workflow[key])) {
      return fail(`workflow.${key} must be an Effect Schema`);
    }
  }
  const { payloadSchema } = workflow;
  if (!Schema.isSchema(payloadSchema)) {
    return fail("workflow.payloadSchema must be an Effect Schema");
  }
  if (!record(payloadSchema) || !record(payloadSchema.fields)) {
    return fail("workflow.payloadSchema must be a Struct schema");
  }
  if (!Layer.isLayer(value.implementation)) {
    return fail(
      "implementation must be a native Layer, normally workflow.toLayer(...)"
    );
  }
  let inputSchema: RegisteredTask["inputSchema"];
  try {
    inputSchema = Schema.toJsonSchemaDocument(payloadSchema);
  } catch (error) {
    return fail(
      `workflow payload schema cannot be described as JSON: ${String(error)}`
    );
  }
  return {
    ...task,
    description: value.description,
    fingerprint,
    implementation: value.implementation,
    inputSchema,
    // This checked boundary uses Effect's own existential workflow representation.
    workflow: workflow as unknown as Workflow.Any,
  };
};

const freezeSources = (
  workspace: string,
  fingerprints: readonly RegisteredTask["fingerprint"][]
) => {
  const root = realpathSync(workspace);
  const snapshots = new Map<string, string>();
  for (const fingerprint of fingerprints) {
    const sources = [
      ...fingerprint.files.map((file) => path.join(root, file)),
      ...(fingerprint.installedSources ?? []),
    ];
    for (const absolute of sources) {
      const digest = sourceDigest(absolute);
      const prior = importedSources.get(absolute);
      if (prior !== undefined && prior !== digest) {
        throw new TaskCatalogError(
          `${path.relative(root, absolute)}: source changed after registration; restart the runner to load this revision`
        );
      }
      snapshots.set(absolute, digest);
    }
  }
  // Freeze source identity even if an import fails after executing dependencies.
  for (const [file, digest] of snapshots) {
    importedSources.set(file, digest);
  }
};

/** Load trusted runtime configuration using the same source checks as automations. */
export const loadWorkspaceConfig = async (
  workspace: string
): Promise<Config<never, unknown> | undefined> => {
  const entrypoint = workspaceEntrypoint(workspace);
  if (!entrypoint) {
    return undefined;
  }
  const fingerprint = fingerprintTask(workspace, entrypoint);
  freezeSources(workspace, [fingerprint]);
  let module: { default?: unknown };
  try {
    module = await importRegistration(workspace, entrypoint);
  } catch (error) {
    throw new TaskCatalogError(
      `${entrypoint}: trusted configuration import failed: ${String(error)}`
    );
  }
  if (fingerprintTask(workspace, entrypoint).digest !== fingerprint.digest) {
    throw new TaskCatalogError(
      `${entrypoint}: source changed during configuration loading; restart the runner`
    );
  }
  const config = module.default;
  if (!record(config) || !Layer.isLayer(config.services)) {
    throw new TaskCatalogError(
      `${entrypoint}: default export must be Effectory.make({ services: Layer })`
    );
  }
  if (
    path.basename(entrypoint) === "effectory.config.ts" &&
    config.workflows !== undefined
  ) {
    throw new TaskCatalogError(
      `${entrypoint}: rename to effectory.run.ts to register workflows explicitly`
    );
  }
  if (
    (path.basename(entrypoint) === "effectory.run.ts" ||
      config.workflows !== undefined) &&
    !Array.isArray(config.workflows)
  ) {
    throw new TaskCatalogError(
      `${entrypoint}: workflows must be an array of named automation definitions`
    );
  }
  // Dynamic module boundary: make checks layer inputs at the authoring site.
  return config as unknown as Config<never, unknown>;
};

const explicitCatalog = (
  workspace: string,
  entrypoint: string,
  workflows: readonly unknown[]
): readonly RegisteredTask[] => {
  const fingerprint = fingerprintTask(workspace, entrypoint);
  const names = new Set<string>();
  const tags = new Set<string>();
  return workflows.map((definition) => {
    if (
      !record(definition) ||
      typeof definition.name !== "string" ||
      !taskName.test(definition.name)
    ) {
      throw new TaskCatalogError(
        `${entrypoint}: each workflow must have a lowercase kebab-case name`
      );
    }
    const registered = validateManifest(
      definition,
      {
        directory: realpathSync(workspace),
        entrypoint,
        name: definition.name,
      },
      fingerprint
    );
    if (names.has(registered.name)) {
      throw new TaskCatalogError(`Duplicate task name ${registered.name}`);
    }
    if (tags.has(registered.workflow._tag)) {
      throw new TaskCatalogError(
        `Duplicate workflow tag ${registered.workflow._tag}`
      );
    }
    names.add(registered.name);
    tags.add(registered.workflow._tag);
    return registered;
  });
};

/**
 * Registration executes trusted module top levels. Source checks are not isolation.
 * Restart the runner after edits: native imports cache the complete module graph.
 */
export const loadTaskCatalog = async (
  workspace: string
): Promise<readonly RegisteredTask[]> => {
  const entrypoint = workspaceEntrypoint(workspace);
  const config = await loadWorkspaceConfig(workspace);
  if (entrypoint && config?.workflows) {
    return explicitCatalog(workspace, entrypoint, config.workflows);
  }
  const candidates = listTaskDirectories(workspace).map((task) => ({
    fingerprint: fingerprintTask(workspace, task.entrypoint),
    task,
  }));
  freezeSources(
    workspace,
    candidates.map(({ fingerprint }) => fingerprint)
  );
  const tasks: RegisteredTask[] = [];
  const tags = new Map<string, string>();
  for (const { task, fingerprint } of candidates) {
    let module: { default?: unknown };
    try {
      // oxlint-disable-next-line no-await-in-loop -- Trusted module top levels register in deterministic order.
      module = await import(pathToFileURL(task.entrypoint).href);
    } catch (error) {
      throw new TaskCatalogError(
        `${task.entrypoint}: trusted module import failed: ${String(error)}`
      );
    }
    if (
      fingerprintTask(workspace, task.entrypoint).digest !== fingerprint.digest
    ) {
      throw new TaskCatalogError(
        `${task.entrypoint}: source changed during trusted module registration; restart the runner`
      );
    }
    const registered = validateManifest(module.default, task, fingerprint);
    const duplicate = tags.get(registered.workflow._tag);
    if (duplicate) {
      throw new TaskCatalogError(
        `Duplicate workflow tag ${registered.workflow._tag} in tasks ${duplicate} and ${task.name}`
      );
    }
    tags.set(registered.workflow._tag, task.name);
    tasks.push(registered);
  }
  return tasks;
};
