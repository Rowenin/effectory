import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ExtensionLock,
  LockedPackage,
} from "@effectory/runtime/extension-protocol";
import type { Task } from "@offtree/effectory-sdk";
import { Effect, Layer } from "effect";

import { Catalog } from "../src/catalog.ts";
import { verifyArchive } from "../src/extension-archive.ts";
import {
  assertTrusted,
  bindingsFilename,
  bindingSource,
  trustLock,
  lockFilename,
  verifyBindings,
  writeBindings,
} from "../src/extension-bindings.ts";
import { cacheArchive, restoreCache } from "../src/extension-cache.ts";
import { ExtensionSource } from "../src/extension-source.ts";
import { validateExtensions } from "../src/extension-validator.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { revisionCatalogLayer } from "../src/revisions.ts";
import { archiveFixture } from "./fixtures/extension-archive.ts";
import {
  publishedExtension,
  typescript,
  workspace,
} from "./fixtures/published-extension.ts";

const context: Task.RuntimeContext = {
  attempt: 1,
  attemptId: "test",
  invocationPath: "inspect",
  key: (name) => name,
  progress: () => Effect.void,
  publish: () => Effect.die("No publication expected"),
  revision: "test",
  runId: "test",
  taskId: "fixture/tools/inspect",
  taskVersion: 1,
};

test("a generated facade preserves emitted types, exposes canonical services and loads implementations only on inclusion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-bindings-"));
  const repository = path.join(directory, "consumer");
  const marker = Symbol.for("effectory/test/extension-loaded");
  Reflect.deleteProperty(globalThis, marker);
  try {
    const { archive } = await publishedExtension(
      path.join(directory, "publisher")
    );
    const verified = verifyArchive(archive);
    const requested = {
      assetName: "effectory.tgz",
      ref: "v1",
      repository: "fixture/tools",
    };
    const locked: typeof LockedPackage.Type = {
      archiveDigest: verified.archiveDigest,
      dependencies: {},
      manifest: verified.manifest,
      manifestDigest: verified.manifestDigest,
      source: {
        ...requested,
        assetId: 1,
        commit: "a".repeat(40),
        publisherDigest: null,
        releaseId: 1,
        size: archive.length,
      },
    };
    const lock: typeof ExtensionLock.Type = {
      format: 1,
      packages: { "fixture/tools": locked },
      roots: { "fixture/tools": { bindingName: "Tools", source: requested } },
    };
    await mkdir(repository);
    await symlink(
      path.join(workspace, "node_modules"),
      path.join(repository, "node_modules"),
      "dir"
    );
    await Effect.runPromise(
      restoreCache(repository, lock).pipe(
        Effect.provide(
          Layer.merge(
            ownershipLayer(path.join(repository, "owner")),
            Layer.succeed(ExtensionSource, {
              download: () => Effect.succeed(archive),
              resolve: () => Effect.die("Restore must use the lock"),
            })
          )
        )
      )
    );
    writeBindings(repository, lock);
    expect(() => assertTrusted(repository, lock)).toThrow(
      "has not been trusted"
    );
    trustLock(repository, lock);
    assertTrusted(repository, lock);
    verifyBindings(repository, lock);
    const consumer = await readFile(
      path.join(import.meta.dir, "fixtures/published-extension/consumer.txt"),
      "utf-8"
    );
    await writeFile(path.join(repository, "effectory.ts"), consumer);
    await typescript(repository, ["effectory.ts", "effectory.extensions.ts"]);
    await import(pathToFileURL(bindingsFilename(repository)).href);
    expect(Reflect.get(globalThis, marker)).toBeUndefined();
    await writeFile(lockFilename(repository), JSON.stringify(lock));
    await rm(bindingsFilename(repository));
    const state = path.join(repository, ".effectory");
    const catalogLayer = revisionCatalogLayer(repository).pipe(
      Layer.provide(ownershipLayer(path.join(state, "owner")))
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        const application = yield* catalog.get();
        const task = application.registry.tasks.get("fixture/tools/inspect");
        if (!task) {
          return yield* Effect.die("Extension task not registered");
        }
        expect(
          // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- user code loaded at runtime has an unknown error type
          yield* task.execute({ repository: "swamp-club/swamp" }, context)
        ).toBe("loaded/swamp-club/swamp");
        expect(application.registry.workflows.has("local/flow")).toBe(true);
        const candidateLock = {
          ...lock,
          roots: {
            "fixture/tools": {
              bindingName: "CandidateTools",
              source: requested,
            },
          },
        };
        yield* Effect.promise(
          async () =>
            await writeFile(
              path.join(repository, "effectory.ts"),
              consumer.replaceAll("Tools", "CandidateTools")
            )
        );
        const candidate = yield* catalog.prepare(candidateLock);
        // Candidate imports resolve against an overlay, while the live facade stays intact.
        verifyBindings(repository, lock);
        expect(catalog.active).toBe(application.revision);
        yield* catalog.activate(candidate, () => {
          writeBindings(repository, candidateLock);
        });
        verifyBindings(repository, candidateLock);
        expect(catalog.active).toBe(candidate.revision);
        const retained = yield* catalog.get(application.revision);
        expect(retained.registry.workflows.has("local/flow")).toBe(true);
        writeBindings(repository, lock);
      }).pipe(Effect.scoped, Effect.provide(catalogLayer))
    );
    expect(Reflect.get(globalThis, marker)).toBe(true);
    verifyBindings(repository, lock);
    const files = Object.fromEntries(
      [...verified.files]
        .filter(([name]) => name !== "effectory.extension.json")
        .map(([name, bytes]) => [name, new TextDecoder().decode(bytes)])
    );
    const wrongManifest = {
      ...verified.manifest,
      contributions: {
        ...verified.manifest.contributions,
        tasks: [{ id: "fixture/tools/inspect", name: "Renamed", version: 1 }],
      },
    };
    const mismatched = await archiveFixture(wrongManifest, files);
    const mismatchedArchive = verifyArchive(mismatched);
    const wrongPackage: typeof LockedPackage.Type = {
      ...locked,
      archiveDigest: mismatchedArchive.archiveDigest,
      manifest: mismatchedArchive.manifest,
      manifestDigest: mismatchedArchive.manifestDigest,
      source: { ...locked.source, size: mismatched.length },
    };
    const wrongLock: typeof ExtensionLock.Type = {
      ...lock,
      packages: { "fixture/tools": wrongPackage },
    };
    cacheArchive(repository, wrongPackage, mismatched);
    trustLock(repository, wrongLock);
    await expect(
      Effect.runPromise(
        validateExtensions(repository, wrongLock).pipe(
          Effect.provide(ownershipLayer(path.join(state, "owner")))
        )
      )
    ).rejects.toThrow("Extension exports could not be loaded");
    const changed = {
      ...lock,
      roots: { "fixture/tools": { bindingName: "Renamed", source: requested } },
    };
    expect(bindingSource(repository, changed)).not.toBe(
      bindingSource(repository, lock)
    );
    expect(() => verifyBindings(repository, changed)).toThrow("stale");
    expect(() =>
      assertTrusted(path.join(directory, "fresh-checkout"), lock)
    ).toThrow("has not been trusted");
    await rm(path.join(state, "extensions/trust.json"));
    trustLock(repository, wrongLock);
    await expect(
      Effect.runPromise(
        Effect.map(Catalog, (catalog) => catalog.active).pipe(
          Effect.provide(catalogLayer)
        )
      )
    ).rejects.toThrow("retained application requires extension digests");
  } finally {
    Reflect.deleteProperty(globalThis, marker);
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);
