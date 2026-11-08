import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionLock } from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Application, Vault } from "@offtree/effectory-sdk";
import { building } from "@offtree/effectory-sdk/internal/vault-tracker";
import {
  Context,
  Effect,
  Exit,
  Layer,
  RcMap,
  Schema,
  Scope,
  Semaphore,
} from "effect";

import {
  assertUnchanged,
  buildApplication,
  digestOf,
  revisionUnavailable,
  sourceConflict,
} from "./application-bundle.ts";
import type { Bundle } from "./application-bundle.ts";
import { Catalog } from "./catalog.ts";
import type { RevisionCandidate } from "./catalog.ts";
import { assertTrustedDigests, replaceFile } from "./extension-bindings.ts";
import { prepareExtensions } from "./extension-bootstrap.ts";
import { GitHubSourceLive } from "./extension-source.ts";
import { validateExtensions } from "./extension-validator.ts";
import { hostAbi, installHostModules } from "./host-runtime.ts";
import { RepositoryLease } from "./ownership.ts";
import { RevisionManifest as Manifest } from "./revision-manifest.ts";
import { reclaimedRevisionError } from "./revision-reclaim-history.ts";
import {
  assertRevisionExecutable,
  executionCompatibility,
  executionContract,
  revisionExecutionIdentity,
  runtimeExecutionPolicy,
} from "./runtime-compatibility.ts";
import { readRuntimeStorage } from "./runtime-storage-format.ts";
import { makeVaultStore } from "./vault-store.ts";

function revisionFile(filename: string, maximum: number) {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) {
    throw revisionUnavailable();
  }
  return readFileSync(filename);
}
function loadApplication(
  filename: string,
  parent: Scope.Scope,
  vaults: typeof Vault.LocalStore.Service
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.fork(parent);
      return yield* restore(
        Effect.gen(function* () {
          const imported: unknown = yield* Effect.tryPromise({
            catch: revisionUnavailable,
            try: () => import(pathToFileURL(filename).href),
          });
          const application = yield* Effect.try({
            catch: revisionUnavailable,
            try: () => {
              if (typeof imported !== "object" || imported === null) {
                throw revisionUnavailable();
              }
              const exported: unknown = Reflect.get(imported, "default");
              if (typeof exported !== "object" || exported === null) {
                throw revisionUnavailable();
              }
              const layer: unknown = Reflect.get(exported, "layer");
              if (!Layer.isLayer(layer)) {
                throw revisionUnavailable();
              }
              // The dynamic boundary cannot inspect TypeScript service requirements.
              // Registry construction validates declarations; authoring types check R.
              return layer as Layer.Layer<Application.Registry, unknown>;
            },
          });
          const context = yield* building(
            Layer.buildWithScope(application, scope).pipe(
              Effect.provideService(Vault.LocalStore, vaults)
            )
          ).pipe(Effect.mapError(revisionUnavailable));
          return yield* Effect.try({
            catch: revisionUnavailable,
            try: () => {
              const registry = Context.get(context, Application.Registry);
              return registry;
            },
          });
        })
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void
        )
      );
    })
  );
}

export const revisionCatalogLayer = (repository: string) =>
  Layer.effect(
    Catalog,
    Effect.gen(function* () {
      const lease = yield* RepositoryLease;
      const parent = yield* Effect.scope;
      const hostContext = yield* Effect.context<never>();
      const vaults = yield* makeVaultStore(repository, lease);
      const semaphore = yield* Semaphore.make(1);
      const stateDirectory = path.join(repository, ".effectory");
      const revisionsDirectory = path.join(stateDirectory, "revisions");
      const abi = yield* Effect.try({
        catch: revisionUnavailable,
        try: () => {
          lease.assertActive();
          mkdirSync(revisionsDirectory, { mode: 0o700, recursive: true });
          installHostModules();
          return hostAbi();
        },
      });
      const storage = yield* Effect.try({
        catch: revisionUnavailable,
        try: () => readRuntimeStorage(repository),
      });
      const revisions = new Map<string, string>();
      const archived = new Map<string, typeof Manifest.Type>();
      const executionPolicy = runtimeExecutionPolicy();
      const candidates = new WeakMap<RevisionCandidate, Bundle["inputs"]>();
      let active = "";
      const retained = yield* Effect.try({
        catch: revisionUnavailable,
        try: () => {
          const entries = readdirSync(revisionsDirectory).filter((name) =>
            /^[a-f0-9]{64}$/u.test(name)
          );
          if (entries.length > 256) {
            throw new OperationError({
              code: "LimitExceeded",
              message: "Application revision directory limit reached",
            });
          }
          return entries.filter((revision) => {
            const directory = path.join(revisionsDirectory, revision);
            if (
              !lstatSync(directory).isDirectory() ||
              lstatSync(directory).isSymbolicLink()
            ) {
              throw revisionUnavailable();
            }
            if (existsSync(path.join(directory, "manifest.json"))) {
              return true;
            }
            // A killed or rejected validation never becomes a retained revision.
            rmSync(directory, { force: true, recursive: true });
            return false;
          });
        },
      });
      if (retained.length > 128) {
        return yield* new OperationError({
          code: "LimitExceeded",
          message: "Retained application revision limit reached (128)",
        });
      }
      for (const revision of retained) {
        const directory = path.join(revisionsDirectory, revision);
        const filename = path.join(directory, "application.mjs");
        const storedManifest = yield* Effect.try({
          catch: revisionUnavailable,
          try: () => {
            const manifest = Schema.decodeUnknownSync(Manifest)(
              JSON.parse(
                revisionFile(
                  path.join(directory, "manifest.json"),
                  65_536
                ).toString("utf-8")
              ),
              { onExcessProperty: "error" }
            );
            if (
              digestOf(`${manifest.hostAbi}/${manifest.digest}`) !== revision ||
              digestOf(revisionFile(filename, 16_777_216)) !== manifest.digest
            ) {
              throw revisionUnavailable();
            }
            if (
              storage === null ||
              executionCompatibility(
                revisionExecutionIdentity(manifest),
                executionPolicy
              ) !== "Unavailable"
            ) {
              assertRevisionExecutable(revision, manifest, executionPolicy);
              assertTrustedDigests(repository, manifest.extensionDigests);
            }
            return manifest;
          },
        });
        if (
          executionCompatibility(
            revisionExecutionIdentity(storedManifest),
            executionPolicy
          ) === "Unavailable"
        ) {
          archived.set(revision, storedManifest);
        } else {
          revisions.set(revision, filename);
        }
        yield* Effect.yieldNow;
      }
      const assertExecutable = (revision: string) => {
        const manifest = archived.get(revision);
        if (manifest !== undefined) {
          assertRevisionExecutable(revision, manifest, executionPolicy);
        }
        // Every executable entry was integrity- and compatibility-checked before insertion.
        // This check is safe inside admission transactions: no code or I/O runs.
        if (!revisions.has(revision)) {
          throw new OperationError({
            code: "RevisionUnavailable",
            message: `Application revision ${revision} is unavailable for execution; use its compatible host`,
          });
        }
      };
      // Retained bundles are metadata. Only active borrowers own live Layers.
      // RcMap merges a caller's Context into lookup: restore the catalog's base
      // Context so a task's tags, tracker or Layer memo map cannot leak here.
      const loaded = yield* RcMap.make({
        lookup: (revision: string) =>
          Effect.gen(function* () {
            if (!revisions.has(revision) && !archived.has(revision)) {
              const reclaimed = yield* reclaimedRevisionError(
                repository,
                revision
              );
              if (reclaimed !== null) {
                return yield* reclaimed;
              }
            }
            yield* Effect.try({
              catch: revisionUnavailable,
              try: () => assertExecutable(revision),
            });
            const filename = revisions.get(revision);
            if (!filename) {
              return yield* revisionUnavailable();
            }
            const scope = yield* Effect.scope;
            return yield* loadApplication(filename, scope, vaults.service).pipe(
              Effect.updateContext<never, never>(() =>
                Context.add(
                  Context.add(hostContext, Scope.Scope, scope),
                  Layer.CurrentMemoMap,
                  Layer.makeMemoMapUnsafe()
                )
              )
            );
          }),
      });
      const get = (revision = active) =>
        RcMap.get(loaded, revision).pipe(
          Effect.map((registry) => ({ registry, revision }))
        );
      let activeScope: Scope.Closeable | undefined;
      const prepare = (lock?: typeof ExtensionLock.Type) =>
        Effect.gen(function* () {
          const baseRevision = active;
          if (lock !== undefined) {
            yield* validateExtensions(repository, lock).pipe(
              Effect.provideService(RepositoryLease, lease)
            );
          }
          const bundle = yield* buildApplication(repository, lock);
          const contentDigest = digestOf(bundle.source);
          const revision = digestOf(`${abi}/${contentDigest}`);
          if (archived.has(revision)) {
            yield* Effect.try({
              catch: revisionUnavailable,
              try: () => assertExecutable(revision),
            });
          }
          if (revisions.has(revision)) {
            yield* get(revision);
          } else {
            if (revisions.size + archived.size >= 128) {
              return yield* new OperationError({
                code: "LimitExceeded",
                message: "Retained application revision limit reached (128)",
              });
            }
            const directory = path.join(revisionsDirectory, revision);
            const filename = path.join(directory, "application.mjs");
            yield* Effect.try({
              catch: revisionUnavailable,
              try: () => {
                lease.assertActive();
                mkdirSync(directory, { mode: 0o700, recursive: true });
                replaceFile(filename, bundle.source);
              },
            });
            revisions.set(revision, filename);
            // The validation borrow rolls back immediately if publishing the
            // manifest fails. A successful prepare transfers a borrow to its
            // caller's Scope before releasing validation's temporary borrow.
            const caller = yield* Effect.scope;
            let published = false;
            yield* Effect.gen(function* () {
              yield* get(revision);
              yield* Effect.try({
                catch: revisionUnavailable,
                try: () => {
                  lease.assertActive();
                  replaceFile(
                    path.join(directory, "manifest.json"),
                    JSON.stringify({
                      digest: contentDigest,
                      effectVersion: "4.0.5",
                      executionContract,
                      extensionDigests: [
                        ...new Set(
                          Object.values(lock?.packages ?? {}).map(
                            (pkg) => pkg.archiveDigest
                          )
                        ),
                      ].toSorted(),
                      format: 3,
                      hostAbi: abi,
                    })
                  );
                  published = true;
                },
              });
              yield* get(revision).pipe(
                Effect.provideService(Scope.Scope, caller)
              );
            }).pipe(
              Effect.scoped,
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.isFailure(exit) && !published) {
                    revisions.delete(revision);
                  }
                })
              )
            );
          }
          const candidate = Object.freeze({ baseRevision, revision });
          candidates.set(candidate, bundle.inputs);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              candidates.delete(candidate);
            })
          );
          return candidate;
        }).pipe(semaphore.withPermits(1));
      const activate = (candidate: RevisionCandidate, publish?: () => void) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* Effect.try({
              catch: revisionUnavailable,
              try: () => {
                if (
                  !candidates.has(candidate) ||
                  candidate.baseRevision !== active
                ) {
                  throw sourceConflict();
                }
              },
            });
            // Keep both revisions alive through publication. Existing borrowers of
            // the old revision remain owners after its active pin is released.
            const scope = yield* Scope.fork(parent);
            const result = yield* restore(
              get(candidate.revision).pipe(
                Effect.provideService(Scope.Scope, scope)
              )
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void
              )
            );
            const previous = activeScope;
            yield* Effect.try({
              catch: revisionUnavailable,
              try: () => {
                lease.assertActive();
                const inputs = candidates.get(candidate);
                if (!inputs || candidate.baseRevision !== active) {
                  throw sourceConflict();
                }
                assertUnchanged(inputs);
                // No asynchronous gap between validation and pointer publication.
                publish?.();
                replaceFile(
                  path.join(stateDirectory, "active.json"),
                  JSON.stringify({ revision: candidate.revision })
                );
                active = candidate.revision;
                activeScope = scope;
                candidates.delete(candidate);
              },
            }).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void
              )
            );
            // The returned registry is borrowed too: a later activation must not
            // close it while this caller still uses it.
            yield* get(candidate.revision);
            if (previous) {
              yield* Scope.close(previous, Exit.void);
            }
            return result;
          })
        ).pipe(semaphore.withPermits(1));
      const extensions = yield* prepareExtensions(repository, {
        requireLock: false,
        trust: false,
      }).pipe(Effect.provide(GitHubSourceLive));
      yield* Effect.gen(function* () {
        yield* activate(yield* prepare(extensions?.lock));
      }).pipe(Effect.scoped);
      return {
        activate,
        get active() {
          return active;
        },
        assertExecutable,
        get,
        prepare,
        vaults,
      };
    })
  );
