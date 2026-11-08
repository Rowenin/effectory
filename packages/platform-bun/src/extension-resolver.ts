import {
  GitHubSource,
  LockedPackage,
  extensionLimits,
} from "@effectory/runtime/extension-protocol";
import type {
  ExtensionChange,
  ResolutionSnapshot,
  ExtensionLock,
} from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { canonical, encode } from "@offtree/effectory-sdk/internal/boundary";
import { Effect } from "effect";

import { digest, verifyArchive } from "./extension-archive.ts";
import { cacheArchive, lockRevision, validateLock } from "./extension-cache.ts";
import { ExtensionSource } from "./extension-source.ts";
import { RepositoryLease } from "./ownership.ts";

const fail = (message: string) =>
  new OperationError({ code: "Conflict", message });
const boundary = <A>(evaluate: () => A) =>
  Effect.try({
    catch: (error) =>
      error instanceof OperationError
        ? error
        : new OperationError({
            code: "InvalidInput",
            message: "Extension dependency resolution failed validation",
          }),
    try: evaluate,
  });
const sourceKey = (source: typeof GitHubSource.Type) =>
  digest(
    canonical(
      encode(GitHubSource, {
        assetName: source.assetName,
        ref: source.ref,
        repository: source.repository,
      })
    )
  );

/** Resolve only changed roots; retain the exact dependency closures of unchanged packages. */
export function resolveExtensionChange(
  repository: string,
  previous: typeof ExtensionLock.Type,
  request: typeof ExtensionChange.Type,
  saved: typeof ResolutionSnapshot.Type,
  checkpoint: (
    resolved: typeof ResolutionSnapshot.Type
  ) => Effect.Effect<void, OperationError>
) {
  return Effect.gen(function* () {
    const source = yield* ExtensionSource;
    const lease = yield* RepositoryLease;
    const base = yield* boundary(() => validateLock(previous));
    if (lockRevision(base) !== request.expectedRevision) {
      return yield* fail("Installed extension registry changed");
    }
    const root = request.kind === "Add" ? null : base.roots[request.id];
    if (request.kind !== "Add" && !root) {
      return yield* new OperationError({
        code: "NotFound",
        message: "Extension is not an installed root",
      });
    }
    const roots = Object.fromEntries(
      Object.entries(base.roots).filter(
        ([id]) => request.kind === "Add" || id !== request.id
      )
    );
    const packages: Record<string, typeof LockedPackage.Type> = {};
    const resolutions = { ...saved };
    const bySource = new Map<string, string>();
    const visiting = new Set<string>();
    let downloaded = 0;
    let expanded = 0;
    function put(locked: typeof LockedPackage.Type) {
      const existing = packages[locked.manifest.id];
      if (
        existing &&
        canonical(encode(LockedPackage, existing)) !==
          canonical(encode(LockedPackage, locked))
      ) {
        throw fail(
          `Conflicting locked providers for extension ${locked.manifest.id}`
        );
      }
      packages[locked.manifest.id] = locked;
      bySource.set(sourceKey(locked.source), locked.manifest.id);
      if (Object.keys(packages).length > extensionLimits.packages) {
        throw new OperationError({
          code: "LimitExceeded",
          message: "Extension dependency closure exceeds 128 packages",
        });
      }
    }
    function retain(id: string): void {
      const locked = base.packages[id];
      if (!locked) {
        throw fail("Missing retained dependency");
      }
      if (packages[id]) {
        put(locked);
        return;
      }
      put(locked);
      for (const child of Object.values(locked.dependencies)) {
        retain(child);
      }
    }
    yield* boundary(() => {
      for (const id of Object.keys(roots)) {
        retain(id);
      }
    });
    const visit = (
      selector: typeof GitHubSource.Type,
      force = false
    ): Effect.Effect<string, OperationError> =>
      Effect.gen(function* () {
        const key = sourceKey(selector);
        if (visiting.has(key)) {
          return yield* fail("Extension dependencies contain a cycle");
        }
        const found = bySource.get(key);
        if (!force && found !== undefined) {
          return found;
        }
        const retained = Object.values(base.packages).find(
          (pkg) => sourceKey(pkg.source) === key
        );
        if (!force && retained) {
          yield* boundary(() => retain(retained.manifest.id));
          return retained.manifest.id;
        }
        visiting.add(key);
        let resolved = resolutions[key];
        if (resolved === undefined) {
          resolved = yield* source.resolve(selector);
          resolutions[key] = resolved;
          // Pin the release/asset identity before downloading it; restart never re-resolves this tag.
          yield* checkpoint({ ...resolutions });
        }
        if (sourceKey(resolved) !== key) {
          return yield* fail(
            "Saved release resolution disagrees with the requested source"
          );
        }
        const bytes = yield* source.download(resolved);
        downloaded += bytes.length;
        if (downloaded > 268_435_456) {
          return yield* new OperationError({
            code: "LimitExceeded",
            message: "Extension operation download budget exceeds 256 MiB",
          });
        }
        const archive = yield* boundary(() => verifyArchive(bytes));
        for (const value of archive.files.values()) {
          expanded += value.length;
        }
        if (expanded > 134_217_728) {
          return yield* new OperationError({
            code: "LimitExceeded",
            message: "Extension operation expansion budget exceeds 128 MiB",
          });
        }
        const old = base.packages[archive.manifest.id];
        // An unchanged archive keeps its existing transitive lock, even if dependency tags moved.
        if (old?.archiveDigest === archive.archiveDigest) {
          const unchanged = { ...old, source: resolved };
          yield* boundary(() => {
            for (const child of Object.values(old.dependencies)) {
              retain(child);
            }
            put(unchanged);
          });
          visiting.delete(key);
          return archive.manifest.id;
        }
        if (packages[archive.manifest.id]) {
          return yield* fail(
            `Multiple versions of ${archive.manifest.id} are required`
          );
        }
        if (
          visiting.size + Object.keys(packages).length >
          extensionLimits.packages
        ) {
          return yield* new OperationError({
            code: "LimitExceeded",
            message: "Extension dependency closure exceeds 128 packages",
          });
        }
        const dependencies: Record<string, string> = {};
        for (const [name, dependency] of Object.entries(
          archive.manifest.dependencies
        )) {
          dependencies[name] = yield* visit(dependency);
        }
        const locked: typeof LockedPackage.Type = {
          archiveDigest: archive.archiveDigest,
          dependencies,
          manifest: archive.manifest,
          manifestDigest: archive.manifestDigest,
          source: resolved,
        };
        yield* boundary(() => {
          lease.assertActive();
          put(locked);
          cacheArchive(repository, locked, bytes);
        });
        visiting.delete(key);
        return archive.manifest.id;
      });
    if (request.kind !== "Remove") {
      const selector = yield* boundary(() => {
        if (request.kind === "Add") {
          return request.source;
        }
        if (!root) {
          throw fail("Missing installed root");
        }
        return { ...root.source, ref: request.ref };
      });
      const id = yield* visit(selector, true);
      if (request.kind === "Update" && id !== request.id) {
        return yield* fail("An update cannot change extension identity");
      }
      if (request.kind === "Add" && base.roots[id]) {
        return yield* fail("Extension is already installed; use update");
      }
      const alias =
        request.kind === "Add" ? request.bindingName : root?.bindingName;
      roots[id] = {
        source: selector,
        ...(alias === undefined ? {} : { bindingName: alias }),
      };
    }
    return yield* boundary(() => {
      const lock = validateLock({ format: 1, packages, roots });
      if (Buffer.byteLength(JSON.stringify(lock)) > extensionLimits.lockBytes) {
        throw new OperationError({
          code: "LimitExceeded",
          message: "Extension lock exceeds 4 MiB",
        });
      }
      return lock;
    });
  });
}
