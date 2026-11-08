import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Layer } from "effect";

import {
  assertTrusted,
  lockFilename,
  readLock,
  trustLock,
  writeBindings,
} from "./extension-bindings.ts";
import { lockRevision, restoreCache } from "./extension-cache.ts";
import { GitHubSourceLive } from "./extension-source.ts";
import { ownershipLayer, RepositoryLease } from "./ownership.ts";
import { assertRuntimeWriter } from "./runtime-writer-guard.ts";

const failure = (cause: unknown) =>
  cause instanceof OperationError
    ? cause
    : new OperationError({
        code: "InvalidInput",
        message:
          "Extension lock or repository files are invalid or unavailable",
      });

/** Must run under repository ownership, before any application module import. */
export function prepareExtensions(
  repository: string,
  options: { readonly trust: boolean; readonly requireLock: boolean }
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const snapshot = yield* Effect.try({
      catch: failure,
      try: () => {
        lease.assertActive();
        assertRuntimeWriter(repository);
        if (!existsSync(lockFilename(repository))) {
          if (options.requireLock) {
            throw new OperationError({
              code: "NotFound",
              message:
                "No effectory.extensions.lock.json exists in this repository",
            });
          }
          return null;
        }
        const lock = readLock(repository);
        // Startup cannot authorize new code. Explicit bootstrap may download and
        // inspect a locked archive before recording the requested trust decision.
        if (!options.trust) {
          assertTrusted(repository, lock);
        }
        return lock;
      },
    });
    if (snapshot === null) {
      return null;
    }
    const lock = yield* restoreCache(repository, snapshot);
    return yield* Effect.try({
      catch: failure,
      try: () => {
        lease.assertActive();
        if (options.trust) {
          trustLock(repository, lock);
        }
        assertTrusted(repository, lock);
        writeBindings(repository, lock);
        return {
          bindings: "effectory.extensions.ts",
          lock,
          packages: Object.keys(lock.packages).length,
          revision: lockRevision(lock),
          trusted: true,
        };
      },
    });
  });
}

/** Local bootstrap: refuses to race an owning daemon, and never updates refs. */
export function restoreExtensions(
  repository: string,
  options: { readonly trust: boolean }
) {
  const directory = path.join(repository, ".effectory");
  return Effect.gen(function* () {
    yield* Effect.try({
      catch: failure,
      try: () => mkdirSync(directory, { mode: 0o700, recursive: true }),
    });
    return yield* prepareExtensions(repository, {
      ...options,
      requireLock: true,
    }).pipe(
      Effect.map((result) =>
        result === null
          ? null
          : {
              bindings: result.bindings,
              packages: result.packages,
              revision: result.revision,
              trusted: result.trusted,
            }
      ),
      Effect.provide(
        Layer.merge(
          ownershipLayer(path.join(directory, "state.sqlite.owner")),
          GitHubSourceLive
        )
      )
    );
  });
}

export { parseSource } from "./extension-source.ts";
