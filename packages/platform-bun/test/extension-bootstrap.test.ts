import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ExtensionLock,
  LockedPackage,
} from "@effectory/runtime/extension-protocol";
import { Effect } from "effect";

import { verifyArchive } from "../src/extension-archive.ts";
import {
  assertTrusted,
  lockFilename,
  verifyBindings,
} from "../src/extension-bindings.ts";
import { cacheArchive } from "../src/extension-cache.ts";
import { ownershipLayer, RepositoryLease } from "../src/ownership.ts";
import { archiveFixture } from "./fixtures/extension-archive.ts";

const workspace = path.resolve(import.meta.dir, "../../..");
async function restore(repository: string, trust: boolean) {
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(workspace, "packages/cli/src/main.ts"),
      "extension",
      "restore",
      "--repository",
      repository,
      "--json",
      ...(trust ? ["--trust"] : []),
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr, stdout };
}

test("restore CLI requires local trust, works without an application, and refuses concurrent ownership", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "effectory-bootstrap-"));
  try {
    const archive = await archiveFixture();
    const verified = verifyArchive(archive);
    const source = {
      assetName: "effectory.tgz",
      ref: "v1",
      repository: "acme/tools",
    };
    const locked: typeof LockedPackage.Type = {
      archiveDigest: verified.archiveDigest,
      dependencies: {},
      manifest: verified.manifest,
      manifestDigest: verified.manifestDigest,
      source: {
        ...source,
        assetId: 1,
        commit: "a".repeat(40),
        publisherDigest: null,
        releaseId: 1,
        size: archive.length,
      },
    };
    const lock: typeof ExtensionLock.Type = {
      format: 1,
      packages: { "acme/tools": locked },
      roots: { "acme/tools": { bindingName: "Tools", source } },
    };
    cacheArchive(repository, locked, archive);
    await writeFile(lockFilename(repository), JSON.stringify(lock));
    const untrusted = await restore(repository, false);
    expect(untrusted.code).not.toBe(0);
    expect(untrusted.stderr).toContain("has not been trusted");
    const trusted = await restore(repository, true);
    expect(trusted.code).toBe(0);
    expect(JSON.parse(trusted.stdout)).toHaveProperty("trusted", true);
    verifyBindings(repository, lock);
    assertTrusted(repository, lock);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* RepositoryLease;
        const occupied = yield* Effect.promise(() => restore(repository, true));
        expect(occupied.code).not.toBe(0);
      }).pipe(
        Effect.provide(
          ownershipLayer(path.join(repository, ".effectory/state.sqlite.owner"))
        )
      )
    );
    const offline = await restore(repository, false);
    expect(offline.code).toBe(0);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
}, 15_000);
