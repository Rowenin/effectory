import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ExtensionChange,
  GitHubSource,
  ResolutionSnapshot,
} from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Layer } from "effect";

import {
  emptyLock,
  lockRevision,
  restoreCache,
} from "../src/extension-cache.ts";
import { resolveExtensionChange } from "../src/extension-resolver.ts";
import { ExtensionSource } from "../src/extension-source.ts";
import { ownershipLayer } from "../src/ownership.ts";
import {
  archiveFixture,
  fixtureManifest,
} from "./fixtures/extension-archive.ts";

const selector = (
  repository: string,
  ref = "v1"
): typeof GitHubSource.Type => ({
  assetName: "effectory.tgz",
  ref,
  repository,
});
function sourceFixture(archives: ReadonlyMap<string, Uint8Array>) {
  const entries = [...archives];
  const resolutions: string[] = [];
  const downloads: number[] = [];
  return {
    downloads,
    layer: Layer.succeed(ExtensionSource, {
      download: (source) =>
        Effect.sync(() => {
          if ("kind" in source) {
            throw new Error("Expected release source");
          }
          downloads.push(source.assetId);
          const bytes = entries[source.assetId - 1]?.[1];
          if (!bytes) {
            throw new Error("Unexpected asset");
          }
          return bytes;
        }),
      resolve: (source) =>
        Effect.sync(() => {
          if ("kind" in source) {
            throw new Error("Expected release source");
          }
          const key = `${source.repository}@${source.ref}`;
          resolutions.push(key);
          const index = entries.findIndex(([name]) => name === key);
          const bytes = entries[index]?.[1];
          if (!bytes) {
            throw new Error(`Unexpected source ${key}`);
          }
          return {
            ...source,
            assetId: index + 1,
            commit: "a".repeat(40),
            publisherDigest: null,
            releaseId: index + 1,
            size: bytes.length,
          };
        }),
    }),
    resolutions,
  };
}

test("extension changes preserve shared locked dependencies, aliases, and required versions", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "effectory-resolver-"));
  const dependency = selector("acme/contracts");
  const archives = new Map([
    [
      "acme/contracts@v1",
      await archiveFixture({ ...fixtureManifest, id: "acme/contracts" }),
    ],
    [
      "acme/tools@v1",
      await archiveFixture({
        ...fixtureManifest,
        dependencies: { "@acme/contracts": dependency },
      }),
    ],
    [
      "acme/tools@v2",
      await archiveFixture({
        ...fixtureManifest,
        dependencies: { "@acme/contracts": dependency },
        version: "2.0.0",
      }),
    ],
    [
      "acme/consumer@v1",
      await archiveFixture({
        ...fixtureManifest,
        dependencies: { "@acme/tools": selector("acme/tools") },
        id: "acme/consumer",
      }),
    ],
  ]);
  const source = sourceFixture(archives);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const initial = yield* resolveExtensionChange(
          repository,
          emptyLock,
          {
            bindingName: "Tools",
            expectedRevision: lockRevision(emptyLock),
            kind: "Add",
            requestKey: "add",
            source: selector("acme/tools"),
            trust: false,
          },
          {},
          () => Effect.void
        );
        yield* restoreCache(repository, initial);
        expect(Object.keys(initial.packages).toSorted()).toEqual([
          "acme/contracts",
          "acme/tools",
        ]);
        expect(initial.roots["acme/tools"]?.bindingName).toBe("Tools");
        const updated = yield* resolveExtensionChange(
          repository,
          initial,
          {
            expectedRevision: lockRevision(initial),
            id: "acme/tools",
            kind: "Update",
            ref: "v2",
            requestKey: "update",
            trust: false,
          },
          {},
          () => Effect.void
        );
        expect(updated.packages["acme/contracts"]).toEqual(
          initial.packages["acme/contracts"]
        );
        expect(updated.roots["acme/tools"]?.bindingName).toBe("Tools");
        expect(source.resolutions).toEqual([
          "acme/tools@v1",
          "acme/contracts@v1",
          "acme/tools@v2",
        ]);
        const shared = yield* resolveExtensionChange(
          repository,
          initial,
          {
            expectedRevision: lockRevision(initial),
            kind: "Add",
            requestKey: "shared",
            source: selector("acme/consumer"),
            trust: false,
          },
          {},
          () => Effect.void
        );
        const conflict = yield* Effect.result(
          resolveExtensionChange(
            repository,
            shared,
            {
              expectedRevision: lockRevision(shared),
              id: "acme/tools",
              kind: "Update",
              ref: "v2",
              requestKey: "conflict",
              trust: false,
            },
            {},
            () => Effect.void
          )
        );
        expect(conflict._tag).toBe("Failure");
        const removed = yield* resolveExtensionChange(
          repository,
          shared,
          {
            expectedRevision: lockRevision(shared),
            id: "acme/tools",
            kind: "Remove",
            requestKey: "remove",
          },
          {},
          () => Effect.void
        );
        expect(Object.keys(removed.roots)).toEqual(["acme/consumer"]);
        expect(removed.packages["acme/tools"]).toEqual(
          initial.packages["acme/tools"]
        );
        expect(
          Object.keys(
            (yield* resolveExtensionChange(
              repository,
              removed,
              {
                expectedRevision: lockRevision(removed),
                id: "acme/consumer",
                kind: "Remove",
                requestKey: "remove-last",
              },
              {},
              () => Effect.void
            )).packages
          )
        ).toEqual([]);
      }).pipe(
        Effect.provide(
          Layer.merge(
            ownershipLayer(path.join(repository, "owner")),
            source.layer
          )
        )
      )
    );
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("an interrupted download resumes the saved asset identity without resolving its mutable tag", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-resolve-recovery-")
  );
  const archive = await archiveFixture();
  let saved: typeof ResolutionSnapshot.Type = {};
  const request: typeof ExtensionChange.Type = {
    expectedRevision: lockRevision(emptyLock),
    kind: "Add",
    requestKey: "add",
    source: selector("acme/tools"),
    trust: false,
  };
  const checkpoint = (value: typeof ResolutionSnapshot.Type) =>
    Effect.sync(() => {
      saved = value;
    });
  try {
    const source = sourceFixture(new Map([["acme/tools@v1", archive]]));
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* ExtensionSource;
        const interrupted = yield* Effect.result(
          resolveExtensionChange(
            repository,
            emptyLock,
            request,
            {},
            checkpoint
          ).pipe(
            Effect.provideService(ExtensionSource, {
              ...fixture,
              download: () =>
                Effect.fail(
                  new OperationError({
                    code: "Unavailable",
                    message: "Interrupted transfer",
                  })
                ),
            })
          )
        );
        expect(interrupted._tag).toBe("Failure");
        expect(Object.keys(saved)).toHaveLength(1);
        const lock = yield* resolveExtensionChange(
          repository,
          emptyLock,
          request,
          saved,
          checkpoint
        ).pipe(
          Effect.provideService(ExtensionSource, {
            ...fixture,
            resolve: () => Effect.die("Must not resolve the tag twice"),
          })
        );
        expect(lock.packages["acme/tools"]?.source).toMatchObject({
          assetId: 1,
        });
        expect(source.resolutions).toEqual(["acme/tools@v1"]);
      }).pipe(
        Effect.provide(
          Layer.merge(
            ownershipLayer(path.join(repository, "owner")),
            source.layer
          )
        )
      )
    );
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});
