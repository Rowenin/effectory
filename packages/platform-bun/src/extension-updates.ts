import { ExtensionOutdatedRequest } from "@effectory/runtime/extension-protocol";
import type {
  ExtensionLock,
  ExtensionUpdatePage,
} from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import { lockRevision } from "./extension-cache.ts";
import { latestRelease } from "./extension-source.ts";

/** A bounded page of metadata checks; never downloads, imports or changes a lock. */
export const extensionUpdates = (
  lock: typeof ExtensionLock.Type,
  input: typeof ExtensionOutdatedRequest.Type
) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeEffect(ExtensionOutdatedRequest)(
      input,
      { onExcessProperty: "error" }
    ).pipe(
      Effect.mapError(
        () =>
          new OperationError({
            code: "InvalidInput",
            message: "Invalid extension update query",
          })
      )
    );
    const revision = lockRevision(lock);
    if (
      (request.afterId !== undefined && request.revision === undefined) ||
      (request.revision !== undefined && request.revision !== revision)
    ) {
      return yield* new OperationError({
        code: "Conflict",
        message: "Update pages require the same installed registry revision",
      });
    }
    const ids = Object.keys(lock.roots).toSorted();
    if (request.afterId !== undefined && !ids.includes(request.afterId)) {
      return yield* new OperationError({
        code: "InvalidInput",
        message: "Unknown extension update page position",
      });
    }
    const start =
      request.afterId === undefined ? 0 : ids.indexOf(request.afterId) + 1;
    const selected = ids.slice(start, start + (request.limit ?? 20));
    const items = yield* Effect.forEach(
      selected,
      (id) =>
        Effect.gen(function* () {
          const current = lock.roots[id]?.source;
          if (!current) {
            return yield* new OperationError({
              code: "InvalidInput",
              message: "Missing installed extension source",
            });
          }
          const result = yield* Effect.result(latestRelease(current));
          return result._tag === "Success"
            ? {
                changed:
                  "kind" in current
                    ? result.success.ref !== lock.packages[id]?.source.commit
                    : result.success.ref !== current.ref,
                current,
                error: null,
                id,
                latest: result.success,
              }
            : {
                changed: null,
                current,
                error: result.failure,
                id,
                latest: null,
              };
        }),
      { concurrency: 4 }
    );
    return {
      items,
      nextAfterId:
        start + selected.length < ids.length ? (selected.at(-1) ?? null) : null,
      revision,
    } satisfies typeof ExtensionUpdatePage.Type;
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(
          new OperationError({
            code: "Unavailable",
            message: "Extension update query exceeded 30 seconds",
          })
        ),
    })
  );
