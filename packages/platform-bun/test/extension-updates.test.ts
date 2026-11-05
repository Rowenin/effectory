import { expect, test } from "bun:test";

import type {
  ExtensionLock,
  LockedPackage,
} from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Layer } from "effect";

import { lockRevision } from "../src/extension-cache.ts";
import { GhCommand } from "../src/extension-source.ts";
import { extensionUpdates } from "../src/extension-updates.ts";
import { fixtureManifest } from "./fixtures/extension-archive.ts";

const source = (repository: string) => ({
  assetName: "effectory.tgz",
  ref: "v1",
  repository,
});
const locked = (id: string): typeof LockedPackage.Type => ({
  archiveDigest: "a".repeat(64),
  dependencies: {},
  manifest: { ...fixtureManifest, id },
  manifestDigest: "b".repeat(64),
  source: {
    ...source(id),
    assetId: 1,
    commit: "a".repeat(40),
    publisherDigest: null,
    releaseId: 1,
    size: 100,
  },
});
const lock: typeof ExtensionLock.Type = {
  format: 1,
  packages: { "acme/one": locked("acme/one"), "acme/two": locked("acme/two") },
  roots: {
    "acme/one": { source: source("acme/one") },
    "acme/two": { source: source("acme/two") },
  },
};

test("update discovery pages one registry snapshot without downloading or mutating packages", async () => {
  const seen: string[] = [];
  const before = JSON.stringify(lock);
  await Effect.runPromise(
    Effect.gen(function* () {
      const page = yield* extensionUpdates(lock, { limit: 1 });
      expect(page.nextAfterId).toBe("acme/one");
      expect(page.items[0]?.latest?.ref).toBe("v2");
      expect(page.items[0]?.changed).toBe(true);
      expect(
        (yield* Effect.result(extensionUpdates(lock, { afterId: "acme/one" })))
          ._tag
      ).toBe("Failure");
      expect(
        (yield* Effect.result(
          extensionUpdates(lock, {
            afterId: "acme/one",
            revision: "f".repeat(64),
          })
        ))._tag
      ).toBe("Failure");
      const next = yield* extensionUpdates(lock, {
        afterId: "acme/one",
        revision: page.revision,
      });
      expect(next.items[0]?.error?.code).toBe("Unavailable");
      expect(next.nextAfterId).toBeNull();
      expect(next.revision).toBe(lockRevision(lock));
      expect(seen).toEqual([
        "repos/acme/one/releases/latest",
        "repos/acme/two/releases/latest",
      ]);
      expect(JSON.stringify(lock)).toBe(before);
    }).pipe(
      Effect.provide(
        Layer.succeed(GhCommand, {
          run: (args) =>
            Effect.suspend(() => {
              const endpoint = args.at(3) ?? "";
              seen.push(endpoint);
              if (endpoint === "repos/acme/two/releases/latest") {
                return Effect.fail(
                  new OperationError({
                    code: "Unavailable",
                    message: "Private repository is unavailable",
                  })
                );
              }
              return Effect.succeed(
                new TextEncoder().encode(
                  JSON.stringify({
                    assets: [{ id: 2, name: "effectory.tgz", size: 100 }],
                    draft: false,
                    id: 2,
                    tag_name: "v2",
                  })
                )
              );
            }),
        })
      )
    )
  );
});
