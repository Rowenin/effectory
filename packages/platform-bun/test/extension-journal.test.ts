import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ExtensionChange,
  ExtensionLock,
} from "@effectory/runtime/extension-protocol";
import { Effect } from "effect";

import { verifyArchive } from "../src/extension-archive.ts";
import { readLock, verifyBindings } from "../src/extension-bindings.ts";
import { emptyLock, lockRevision } from "../src/extension-cache.ts";
import { createExtensionJournal } from "../src/extension-journal.ts";
import { RepositoryLease, ownershipLayer } from "../src/ownership.ts";
import { archiveFixture } from "./fixtures/extension-archive.ts";

const source = {
  assetName: "effectory.tgz",
  ref: "v1",
  repository: "acme/tools",
};
const request: typeof ExtensionChange.Type = {
  bindingName: "Tools",
  expectedRevision: lockRevision(emptyLock),
  kind: "Add",
  requestKey: "install",
  source,
  trust: true,
};
async function fixtureLock(): Promise<typeof ExtensionLock.Type> {
  const bytes = await archiveFixture();
  const archive = verifyArchive(bytes);
  return {
    format: 1,
    packages: {
      "acme/tools": {
        archiveDigest: archive.archiveDigest,
        dependencies: {},
        manifest: archive.manifest,
        manifestDigest: archive.manifestDigest,
        source: {
          ...source,
          assetId: 1,
          commit: "a".repeat(40),
          publisherDigest: null,
          releaseId: 1,
          size: bytes.length,
        },
      },
    },
    roots: { "acme/tools": { bindingName: "Tools", source } },
  };
}
async function withJournal<A>(
  repository: string,
  use: (journal: ReturnType<typeof createExtensionJournal>) => A
) {
  return await Effect.runPromise(
    Effect.gen(function* () {
      const lease = yield* RepositoryLease;
      const db = yield* Effect.acquireRelease(
        Effect.sync(
          () => new Database(path.join(repository, ".effectory/state.sqlite"))
        ),
        (database) => Effect.sync(() => database.close())
      );
      return use(createExtensionJournal(db, repository, lease));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ownershipLayer(path.join(repository, ".effectory/state.sqlite.owner"))
      )
    )
  );
}

for (const phase of ["intent", "lock", "bindings", "pointer"]) {
  test(`extension activation recovers process death after ${phase}`, async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), "effectory-activation-journal-")
    );
    await mkdir(path.join(repository, ".effectory"));
    try {
      const lock = await fixtureLock();
      const accepted = await withJournal(repository, (journal) => {
        journal.recover();
        const receipt = journal.accept(request, "owner", "a".repeat(64));
        journal.start(receipt.operationId, "owner");
        journal.candidate(receipt.operationId, "owner", lock);
        return receipt;
      });
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "fixtures/extension-activation-worker.ts"),
          repository,
          phase,
        ],
        { stderr: "pipe", stdout: "ignore" }
      );
      const code = await child.exited;
      expect(code, await new Response(child.stderr).text()).not.toBe(0);
      const completed = await withJournal(repository, (journal) => {
        expect(journal.intent()).not.toBeNull();
        journal.recover();
        expect(journal.registry().revision).toBe(lockRevision(lock));
        expect(journal.intent()).toBeNull();
        // Receipt lookup precedes expected-revision checks even after the mutation commits.
        return journal.accept(request, "owner", "c".repeat(64));
      });
      expect(completed.operationId).toBe(accepted.operationId);
      expect(completed.status).toBe("Succeeded");
      expect(completed.result).toEqual({
        applicationRevision: "b".repeat(64),
        installedRevision: lockRevision(lock),
      });
      expect(readLock(repository)).toEqual(lock);
      verifyBindings(repository, lock);
      expect(
        JSON.parse(
          await readFile(
            path.join(repository, ".effectory/active.json"),
            "utf-8"
          )
        )
      ).toEqual({ revision: "b".repeat(64) });
    } finally {
      await rm(repository, { force: true, recursive: true });
    }
  });
}

test("extension receipts reject changed input and stale candidates, and inspection is actor-scoped", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-operation-receipts-")
  );
  await mkdir(path.join(repository, ".effectory"));
  try {
    const lock = await fixtureLock();
    await withJournal(repository, (journal) => {
      journal.recover();
      const first = journal.accept(request, "owner", "a".repeat(64));
      const second = journal.accept(
        { ...request, requestKey: "second" },
        "owner",
        "a".repeat(64)
      );
      expect(() =>
        journal.accept({ ...request, trust: false }, "owner", "a".repeat(64))
      ).toThrow("different extension input");
      expect(() => journal.get(first.operationId, "other")).toThrow(
        "not found"
      );
      expect(journal.list("other")).toEqual([]);
      expect(
        journal.list("owner", first.sequence, 1).map((item) => item.operationId)
      ).toEqual([second.operationId]);
      journal.start(first.operationId, "owner");
      journal.candidate(first.operationId, "owner", lock);
      journal.begin(first.operationId, "owner", "b".repeat(64));
      journal.publish();
      journal.finish();
      journal.start(second.operationId, "owner");
      journal.candidate(second.operationId, "owner", emptyLock);
      expect(() =>
        journal.begin(second.operationId, "owner", "c".repeat(64))
      ).toThrow("registry changed");
      expect(journal.registry().revision).toBe(lockRevision(lock));
    });
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});
