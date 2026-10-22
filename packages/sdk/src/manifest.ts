import type { Layer } from "effect";
import type * as Workflow from "effect/workflow/Workflow";

/** A trusted module's default export. Payload/result schemas belong to Workflow. */
export interface TaskManifest<W extends Workflow.Any = Workflow.Any> {
  /** Defaults to the directory name; when supplied it must match that name. */
  readonly name?: string;
  readonly description: string;
  readonly workflow: W;
  /** Native registration Layer. The host owns supplying its required services. */
  readonly implementation: Layer.Layer<never, unknown, unknown>;
}

/** Preserve the concrete Workflow and native Layer types at the authoring site. */
export const defineTask = <const T extends TaskManifest>(manifest: T): T =>
  manifest;
