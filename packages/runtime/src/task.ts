import type { Layer, Schema } from "effect";
import type * as Workflow from "effect/workflow/Workflow";

export interface TaskDirectory {
  readonly name: string;
  readonly directory: string;
  readonly entrypoint: string;
}

export interface TaskFingerprint {
  readonly digest: string;
  /** Sorted workspace-relative paths, including package metadata and bun.lock. */
  readonly files: readonly string[];
  /** Absolute installed SDK paths used to detect cached imports after dependency edits. */
  readonly installedSources?: readonly string[];
}

export interface RegisteredTask extends TaskDirectory {
  readonly description: string;
  readonly workflow: Workflow.Any;
  readonly implementation: Layer.Layer<never, unknown, unknown>;
  readonly fingerprint: TaskFingerprint;
  readonly inputSchema: ReturnType<typeof Schema.toJsonSchemaDocument>;
}

export class TaskCatalogError extends Error {
  override readonly name = "TaskCatalogError";
}
