import { Extension } from "@effectory/core";
import type { ExtensionManifest } from "@effectory/runtime/extension-protocol";
import { Effect, Schema } from "effect";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Extension export must be an object");
  }
  return value as Record<string, unknown>;
}
function sameEntries(
  actual: readonly {
    readonly id: string;
    readonly name?: string;
    readonly version?: number;
    readonly target?: { readonly id: string; readonly version: number };
  }[],
  expected: typeof actual
) {
  const normalize = (entries: typeof actual) =>
    entries
      .map((entry) =>
        JSON.stringify({
          id: entry.id,
          name: entry.name,
          target: entry.target,
          version: entry.version,
        })
      )
      .toSorted();
  if (
    JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))
  ) {
    throw new Error("Executable contributions disagree with their manifest");
  }
}

/** Called only after local trust and byte verification, inside a disposable process. */
export async function validateExports(
  manifest: typeof ExtensionManifest.Type,
  contractsModule: unknown,
  implementationModule: unknown,
  archiveDigest: string
) {
  const contracts = record(contractsModule)[manifest.contracts.export];
  const definition = record(implementationModule)[manifest.entrypoint.export];
  // These casts cross the module boundary. Extension.load checks SDK provenance
  // and exact codec identities before any fields are used below.
  const descriptor = Extension.installed(
    record(contracts) as unknown as Extension.Contracts<Extension.Definition>,
    () =>
      Promise.resolve(record(definition) as unknown as Extension.Definition),
    archiveDigest
  );
  const loaded = await Effect.runPromise(
    Extension.load(Extension.use(descriptor))
  );
  if (loaded.id !== manifest.id || loaded.version !== manifest.version) {
    throw new Error("Executable identity disagrees with its manifest");
  }
  for (const task of Object.values(loaded.tasks)) {
    if (
      typeof task.execute !== "function" ||
      !Schema.isSchema(task.inputSchema) ||
      !Schema.isSchema(task.successSchema) ||
      !Schema.isSchema(task.errorSchema)
    ) {
      throw new TypeError("Extension task has no implementation");
    }
  }
  sameEntries(
    Object.entries(loaded.tasks).map(([name, task]) => ({
      id: task.id,
      name,
      version: task.spec.version,
    })),
    manifest.contributions.tasks
  );
  sameEntries(
    Object.entries(loaded.workflows).map(([name, workflow]) => ({
      id: workflow.id,
      name,
      version: workflow.spec.version,
    })),
    manifest.contributions.workflows
  );
  sameEntries(
    Object.entries(loaded.artifacts).map(([name, artifact]) => ({
      id: artifact.id,
      name,
      version: artifact.version,
    })),
    manifest.contributions.artifacts
  );
  sameEntries(
    loaded.implementations.map((provider) => ({
      id: provider.providerId,
      target: { id: provider.id, version: provider.spec.version },
    })),
    manifest.contributions.implementations
  );
  sameEntries(
    loaded.patches.map((patch) => ({
      id: patch.id,
      target: { id: patch.target.id, version: patch.target.spec.version },
    })),
    manifest.contributions.patches
  );
}
