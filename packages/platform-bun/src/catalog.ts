import type { Application } from "@effectory/core";
import type { ExtensionLock } from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Context, Effect, Layer } from "effect";

export interface ApplicationRevision {
  readonly revision: string;
  readonly registry: typeof Application.Registry.Service;
}

/** An opaque, process-local candidate; only the preparing catalog can activate it. */
export interface RevisionCandidate {
  readonly revision: string;
  readonly baseRevision: string;
}

export class Catalog extends Context.Service<
  Catalog,
  {
    readonly active: string;
    readonly get: (
      revision?: string
    ) => Effect.Effect<ApplicationRevision, OperationError>;
    readonly prepare: (
      lock?: typeof ExtensionLock.Type
    ) => Effect.Effect<RevisionCandidate, OperationError>;
    readonly activate: (
      candidate: RevisionCandidate,
      publish?: () => void
    ) => Effect.Effect<ApplicationRevision, OperationError>;
  }
>()("effectory/Catalog") {}

/** The caller retains every registry's application Layer for the catalog lifetime. */
export function catalogLayer(
  active: string,
  revisions: ReadonlyMap<string, typeof Application.Registry.Service>
) {
  return Layer.succeed(Catalog, {
    activate: () =>
      Effect.fail(
        new OperationError({
          code: "Unavailable",
          message: "This catalog does not support activation",
        })
      ),
    active,
    get: (requested = active) => {
      const registry = revisions.get(requested);
      return registry
        ? Effect.succeed({ registry, revision: requested })
        : Effect.fail(
            new OperationError({
              code: "RevisionUnavailable",
              message: "Application revision is unavailable",
            })
          );
    },
    prepare: () =>
      Effect.fail(
        new OperationError({
          code: "Unavailable",
          message: "This catalog does not support preparation",
        })
      ),
  });
}
