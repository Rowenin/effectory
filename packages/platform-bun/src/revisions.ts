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

import { Application } from "@effectory/core";
import { Digest } from "@effectory/runtime/extension-protocol";
import type { ExtensionLock } from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Context, Effect, Exit, Layer, Schema, Scope, Semaphore } from "effect";

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

const Manifest = Schema.Struct({
  digest: Digest,
  effectVersion: Schema.Literal("4.0.5"),
  extensionDigests: Schema.Array(Digest).check(Schema.isMaxLength(128)),
  format: Schema.Literal(2),
  hostAbi: Digest,
});
function revisionFile(filename: string, maximum: number) {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) {
    throw revisionUnavailable();
  }
  return readFileSync(filename);
}
function loadApplication(filename: string, parent: Scope.Scope) {
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
          const context = yield* Layer.buildWithScope(application, scope).pipe(
            Effect.mapError(revisionUnavailable)
          );
          return yield* Effect.try({
            catch: revisionUnavailable,
            try: () => Context.get(context, Application.Registry),
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
      const revisions = new Map<string, typeof Application.Registry.Service>();
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
        yield* Effect.try({
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
              manifest.hostAbi !== abi ||
              digestOf(`${manifest.hostAbi}/${manifest.digest}`) !== revision ||
              digestOf(revisionFile(filename, 16_777_216)) !== manifest.digest
            ) {
              throw revisionUnavailable();
            }
            assertTrustedDigests(repository, manifest.extensionDigests);
          },
        });
        revisions.set(revision, yield* loadApplication(filename, parent));
      }
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
          if (!revisions.has(revision)) {
            if (revisions.size >= 128) {
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
            const registry = yield* loadApplication(filename, parent);
            yield* Effect.try({
              catch: revisionUnavailable,
              try: () => {
                lease.assertActive();
                // This marker is written only after the application's Layer validates.
                replaceFile(
                  path.join(directory, "manifest.json"),
                  JSON.stringify({
                    digest: contentDigest,
                    effectVersion: "4.0.5",
                    extensionDigests: [
                      ...new Set(
                        Object.values(lock?.packages ?? {}).map(
                          (pkg) => pkg.archiveDigest
                        )
                      ),
                    ].toSorted(),
                    format: 2,
                    hostAbi: abi,
                  })
                );
              },
            });
            revisions.set(revision, registry);
          }
          const candidate = Object.freeze({ baseRevision, revision });
          candidates.set(candidate, bundle.inputs);
          return candidate;
        }).pipe(semaphore.withPermits(1));
      const activate = (candidate: RevisionCandidate, publish?: () => void) =>
        Effect.try({
          catch: revisionUnavailable,
          try: () => {
            lease.assertActive();
            const inputs = candidates.get(candidate);
            const registry = revisions.get(candidate.revision);
            if (!inputs || !registry || candidate.baseRevision !== active) {
              throw sourceConflict();
            }
            assertUnchanged(inputs);
            // No asynchronous gap between validation, administrative publication and pointer swap.
            publish?.();
            replaceFile(
              path.join(stateDirectory, "active.json"),
              JSON.stringify({ revision: candidate.revision })
            );
            active = candidate.revision;
            candidates.delete(candidate);
            return { registry, revision: active };
          },
        });
      const extensions = yield* prepareExtensions(repository, {
        requireLock: false,
        trust: false,
      }).pipe(Effect.provide(GitHubSourceLive));
      yield* activate(yield* prepare(extensions?.lock));
      return {
        activate,
        get active() {
          return active;
        },
        get: (revision = active) => {
          const registry = revisions.get(revision);
          return registry
            ? Effect.succeed({ registry, revision })
            : Effect.fail(revisionUnavailable());
        },
        prepare,
      };
    })
  );
