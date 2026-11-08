import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ExtensionLock,
  LockedPackage,
  ExtensionManifest,
} from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Layer } from "effect";

import { verifyArchive } from "../src/extension-archive.ts";
import {
  lockRevision,
  packagePath,
  restoreCache,
  validateLock,
} from "../src/extension-cache.ts";
import { ExtensionSource } from "../src/extension-source.ts";
import { ownershipLayer } from "../src/ownership.ts";
import {
  archiveFixture,
  fixtureManifest,
} from "./fixtures/extension-archive.ts";

const unavailable = () =>
  new OperationError({ code: "Unavailable", message: "Offline" });
async function fixture(
  id = "acme/tools",
  dependencies: (typeof ExtensionManifest.Type)["dependencies"] = {}
) {
  const archive = await archiveFixture({
    ...fixtureManifest,
    dependencies,
    id,
  });
  const verified = verifyArchive(archive);
  const locked: typeof LockedPackage.Type = {
    archiveDigest: verified.archiveDigest,
    dependencies: {},
    manifest: verified.manifest,
    manifestDigest: verified.manifestDigest,
    source: {
      assetId: 1,
      assetName: "effectory.tgz",
      commit: "a".repeat(40),
      publisherDigest: null,
      ref: "v1",
      releaseId: 1,
      repository: id,
      size: archive.length,
    },
  };
  return { archive, locked };
}
const selector = (source: (typeof LockedPackage.Type)["source"]) => ({
  assetName: source.assetName,
  ref: source.ref,
  repository: source.repository,
});
function snapshot(
  locked: typeof LockedPackage.Type
): typeof ExtensionLock.Type {
  return {
    format: 1,
    packages: { [locked.manifest.id]: locked },
    roots: {
      [locked.manifest.id]: {
        bindingName: "Tools",
        source: selector(locked.source),
      },
    },
  };
}
async function restore(
  repository: string,
  lock: typeof ExtensionLock.Type,
  download: (typeof ExtensionSource.Service)["download"]
) {
  return await Effect.runPromise(
    restoreCache(repository, lock).pipe(
      Effect.provide(
        Layer.merge(
          ownershipLayer(path.join(repository, "owner")),
          Layer.succeed(ExtensionSource, {
            download,
            resolve: () =>
              Effect.die("Locked restore must never resolve a tag"),
          })
        )
      )
    )
  );
}

test("locked restore downloads once, works offline, and fails closed on modified cache files", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "effectory-restore-"));
  const { archive, locked } = await fixture();
  const lock = snapshot(locked);
  let downloads = 0;
  try {
    await restore(repository, lock, () =>
      Effect.sync(() => {
        downloads += 1;
        return archive;
      })
    );
    await restore(repository, lock, () => Effect.fail(unavailable()));
    expect(downloads).toBe(1);
    expect(lockRevision(lock)).toBe(lockRevision(validateLock(lock)));
    const filename = path.join(
      packagePath(repository, locked),
      "contracts.mjs"
    );
    await chmod(filename, 0o600);
    await writeFile(filename, "export const contracts = {};");
    await expect(
      restore(repository, lock, () =>
        Effect.die("Corrupt cache must not trigger a new download")
      )
    ).rejects.toThrow("Modified extension cache");
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("a replaced locked asset fails verification without committing a cache object", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "effectory-replaced-"));
  const { locked } = await fixture();
  const changed = await archiveFixture({
    ...fixtureManifest,
    version: "2.0.0",
  });
  try {
    await expect(
      restore(repository, snapshot(locked), () => Effect.succeed(changed))
    ).rejects.toThrow("digest disagrees");
    expect(
      await Bun.file(
        path.join(packagePath(repository, locked), "contracts.mjs")
      ).exists()
    ).toBe(false);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("shared dependencies resolve to one canonical cache module and reject injected peers", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-dependencies-")
  );
  const shared = await fixture("acme/shared");
  const dependency = {
    "@acme/shared": {
      assetName: "effectory.tgz",
      ref: "v1",
      repository: shared.locked.source.repository,
    },
  };
  const first = await fixture("acme/first", dependency);
  const second = await fixture("acme/second", dependency);
  const withDependency = (locked: typeof LockedPackage.Type) => ({
    ...locked,
    dependencies: { "@acme/shared": shared.locked.manifest.id },
  });
  const lock: typeof ExtensionLock.Type = {
    format: 1,
    packages: {
      "acme/first": withDependency(first.locked),
      "acme/second": withDependency(second.locked),
      "acme/shared": shared.locked,
    },
    roots: {
      "acme/first": {
        bindingName: "First",
        source: selector(first.locked.source),
      },
      "acme/second": {
        bindingName: "Second",
        source: selector(second.locked.source),
      },
    },
  };
  const archives = new Map(
    [shared, first, second].map((item) => [
      item.locked.source.repository,
      item.archive,
    ])
  );
  try {
    await restore(repository, lock, (source) => {
      const archive = archives.get(source.repository);
      return archive ? Effect.succeed(archive) : Effect.fail(unavailable());
    });
    expect(
      await realpath(
        path.join(
          packagePath(repository, first.locked),
          "node_modules/@acme/shared"
        )
      )
    ).toBe(await realpath(packagePath(repository, shared.locked)));
    expect(
      await realpath(
        path.join(
          packagePath(repository, second.locked),
          "node_modules/@acme/shared"
        )
      )
    ).toBe(await realpath(packagePath(repository, shared.locked)));
    const injected = path.join(
      packagePath(repository, first.locked),
      "node_modules/effect"
    );
    await mkdir(injected);
    await expect(
      restore(repository, lock, () => Effect.fail(unavailable()))
    ).rejects.toThrow("Unexpected module");
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("lock validation rejects alias collisions, cycles and mismatched dependency sources", async () => {
  const first = await fixture("acme/first", {
    second: {
      assetName: "effectory.tgz",
      ref: "v1",
      repository: "acme/second",
    },
  });
  const second = await fixture("acme/second", {
    first: { assetName: "effectory.tgz", ref: "v1", repository: "acme/first" },
  });
  const lock: typeof ExtensionLock.Type = {
    format: 1,
    packages: {
      "acme/first": {
        ...first.locked,
        dependencies: { second: "acme/second" },
      },
      "acme/second": {
        ...second.locked,
        dependencies: { first: "acme/first" },
      },
    },
    roots: {
      "acme/first": {
        bindingName: "First",
        source: selector(first.locked.source),
      },
    },
  };
  expect(() => validateLock(lock)).toThrow("dependency cycle");
  expect(() =>
    validateLock({
      ...lock,
      roots: {
        ...lock.roots,
        "acme/second": {
          bindingName: "First",
          source: selector(second.locked.source),
        },
      },
    })
  ).toThrow("Duplicate extension binding");
  expect(() =>
    validateLock({
      ...lock,
      roots: {
        "acme/first": {
          bindingName: "default",
          source: selector(first.locked.source),
        },
      },
    })
  ).toThrow("nonreserved");
  expect(() =>
    validateLock({
      ...lock,
      packages: {
        ...lock.packages,
        "acme/second": {
          ...second.locked,
          source: { ...second.locked.source, ref: "v2" },
        },
      },
    })
  ).toThrow("Dependency source disagrees");
});
