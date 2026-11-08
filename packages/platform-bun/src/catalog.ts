import type { ExtensionLock } from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import type { Application } from "@offtree/effectory-sdk";
import type { Scope } from "effect";
import { Context, Effect, Layer } from "effect";

import type { VaultStore } from "./vault-store.ts";

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
    readonly vaults?: VaultStore;
    /** Metadata-only, synchronous admission check; never acquires application services. */
    readonly assertExecutable: (revision: string) => void;
    readonly get: (
      revision?: string
    ) => Effect.Effect<ApplicationRevision, OperationError, Scope.Scope>;
    readonly prepare: (
      lock?: typeof ExtensionLock.Type
    ) => Effect.Effect<RevisionCandidate, OperationError, Scope.Scope>;
    readonly activate: (
      candidate: RevisionCandidate,
      publish?: () => void
    ) => Effect.Effect<ApplicationRevision, OperationError, Scope.Scope>;
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
    assertExecutable: (revision) => {
      if (!revisions.has(revision)) {
        throw new OperationError({
          code: "RevisionUnavailable",
          message: `Application revision ${revision} is unavailable for execution`,
        });
      }
    },
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
