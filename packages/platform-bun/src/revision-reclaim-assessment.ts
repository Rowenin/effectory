/* oxlint-disable no-loop-func -- Each scoped traversal completes before its next iteration. */
import { lstatSync, opendirSync } from "node:fs";
import path from "node:path";

import { Digest } from "@effectory/runtime/extension-protocol";
import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import { Effect, Schema } from "effect";

import { digestOf } from "./application-bundle.ts";
import { hostAbi } from "./host-runtime.ts";
import type { InspectionBudget } from "./inspection-budget.ts";
import { inspectionBudget } from "./inspection-budget.ts";
import { RepositoryLease } from "./ownership.ts";
import { inspectReclaimDependencies } from "./revision-reclaim-dependencies.ts";
import {
  inventoryReclaimRevisions,
  readReclaimFile,
} from "./revision-reclaim-inventory.ts";
import type { ReclaimPreview } from "./revision-reclaim-journal-record.ts";
import type { RevisionReclaimSelector } from "./revision-reclaim-record.ts";
import { revisionReclaimError } from "./revision-reclaim-record.ts";
import {
  readRuntimeStorage,
  readStoredCredentials,
  readStoredLockContents,
} from "./runtime-storage-format.ts";
import { assertRuntimeWriter } from "./runtime-writer-guard.ts";
import { storageError } from "./storage-error.ts";
import { readUpgradeFile, upgradeDirectory } from "./upgrade-record-file.ts";
import { withRuntimeInspection } from "./upgrade-storage.ts";

const io = <A>(body: () => A) =>
  Effect.try({
    catch: (cause) => storageError(cause, "Cannot assess revision reclamation"),
    try: body,
  });
const dependencyNames = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

/** Hash manifests/locks, never application source or installed provider code. */
function sourceDependencies(repository: string, budget: InspectionBudget) {
  return Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* RepositoryLease;
      const pending = [repository];
      const files: { name: string; digest: string }[] = [];
      let bytes = 0;
      while (pending.length > 0) {
        const directory = pending.pop();
        if (directory === undefined || directory === "") {
          break;
        }
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* Effect.acquireRelease(
              io(() => {
                lease.assertActive();
                if (!lstatSync(directory).isDirectory()) {
                  throw revisionReclaimError(
                    "Conflict",
                    "Source dependency directory changed during inspection"
                  );
                }
                return opendirSync(directory);
              }),
              (opened) => Effect.sync(() => opened.closeSync())
            );
            for (;;) {
              const entry = yield* io(() => {
                lease.assertActive();
                const item = handle.readSync();
                if (item) {
                  budget.visit(
                    "source entry",
                    path.relative(repository, path.join(directory, item.name)),
                    false
                  );
                }
                return item;
              });
              if (!entry) {
                break;
              }
              const filename = path.join(directory, entry.name);
              if (dependencyNames.has(entry.name)) {
                const digest = yield* io(() => {
                  const data = readReclaimFile(filename, 268_435_456 - bytes);
                  bytes += data.length;
                  return digestOf(data);
                });
                files.push({
                  digest,
                  name: path.relative(repository, filename),
                });
              } else if (
                entry.isDirectory() &&
                ![".git", "node_modules", ".effectory"].includes(entry.name)
              ) {
                pending.push(filename);
              }
              yield* Effect.yieldNow;
            }
          })
        );
      }
      return files.toSorted((left, right) =>
        left.name.localeCompare(right.name)
      );
    })
  );
}

/** Under offline ownership, inspect only private database copies and inert files. */
export function assessRevisionReclamation(
  repository: string,
  selector: typeof RevisionReclaimSelector.Type,
  planId: string
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const owner = yield* io(() => {
      lease.assertActive();
      assertRuntimeWriter(repository);
      const storage = readRuntimeStorage(repository);
      const credentials = readStoredCredentials(repository);
      const lock = readStoredLockContents(repository);
      const activeText = readUpgradeFile(
        path.join(repository, ".effectory", "active.json"),
        65_536
      );
      let active: string | null = null;
      if (activeText !== null) {
        try {
          active = Schema.decodeUnknownSync(
            Schema.Struct({ revision: Digest })
          )(JSON.parse(activeText), { onExcessProperty: "error" }).revision;
        } catch {
          throw revisionReclaimError(
            "RevisionUnavailable",
            "Active revision metadata is unsupported or damaged; no revision was reclaimed"
          );
        }
      }
      return {
        active,
        credentials: digestOf(canonical(credentials)),
        lock,
        repositoryId: credentials.repositoryId,
        storage,
      };
    });
    const inventory = yield* inventoryReclaimRevisions(repository);
    if (
      selector._tag === "Revision" &&
      !inventory.some((item) => item.revision === selector.revision)
    ) {
      return yield* revisionReclaimError(
        "NotFound",
        "Selected application revision is not retained"
      );
    }
    const budget = inspectionBudget("Revision reclamation inspection");
    const dependencies = yield* sourceDependencies(repository, budget);
    const work = yield* withRuntimeInspection(
      path.join(repository, ".effectory", "state.sqlite"),
      ({ database }) =>
        Effect.gen(function* () {
          yield* io(() => {
            const query = database.prepare<{ user_version: number }, []>(
              "PRAGMA user_version"
            );
            try {
              if (query.get()?.user_version !== 0) {
                throw revisionReclaimError(
                  "RevisionUnavailable",
                  "Unsupported native storage format; no revision was reclaimed"
                );
              }
            } finally {
              query.finalize();
            }
          });
          return yield* inspectReclaimDependencies(
            database,
            inventory.map((item) => item.revision),
            owner.active,
            budget
          );
        })
    );
    const protectedIds = new Set(work.protected.map((item) => item.revision));
    const candidates = inventory.filter(
      (item) =>
        !protectedIds.has(item.revision) &&
        (selector._tag === "Unreferenced" ||
          item.revision === selector.revision)
    );
    const now = Date.now();
    const build = hostAbi();
    const preview: typeof ReclaimPreview.Type = {
      architecture: process.arch,
      binding: digestOf(
        canonical({
          architecture: process.arch,
          build,
          dependencies,
          inventory,
          owner,
          platform: process.platform,
          work: work.digest,
        })
      ),
      format: 1,
      plan: {
        candidates,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 900_000).toISOString(),
        hostBuild: build,
        logicalBytes: candidates.reduce((total, item) => total + item.bytes, 0),
        planId,
        projectedRetainedCount: inventory.length - candidates.length,
        protected: work.protected,
        repositoryId: owner.repositoryId,
        retainedCount: inventory.length,
        scannedBytes: work.bytes,
        scannedRows: work.rows,
        selector,
        status: candidates.length > 0 ? "Ready" : "NoCandidates",
      },
      platform: process.platform,
    };
    return preview;
  });
}

/** A valid hash alone cannot authorize a forged candidate list or protection summary. */
export function assertReclaimAssessment(
  saved: typeof ReclaimPreview.Type,
  current: typeof ReclaimPreview.Type
) {
  const normalized = {
    ...current,
    plan: {
      ...current.plan,
      createdAt: saved.plan.createdAt,
      expiresAt: saved.plan.expiresAt,
    },
  };
  if (canonical(saved) !== canonical(normalized)) {
    throw revisionReclaimError(
      "Conflict",
      "Revision reclamation dependencies, files or preview changed; plan again. No deletion was accepted."
    );
  }
}

/** A previously valid candidate becoming invalid is a stale preview, not an accepted deletion. */
export function recheckReclaimCandidates(
  repository: string,
  preview: typeof ReclaimPreview.Type
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    for (const candidate of preview.plan.candidates) {
      yield* Effect.try({
        catch: () =>
          revisionReclaimError(
            "Conflict",
            "Revision candidate bytes or paths changed since planning; plan again. No deletion was accepted."
          ),
        try: () => {
          lease.assertActive();
          const revisions = path.join(repository, ".effectory", "revisions");
          const directory = path.join(revisions, candidate.revision);
          if (
            !upgradeDirectory(revisions, false) ||
            !upgradeDirectory(directory, false)
          ) {
            throw new Error("Missing candidate");
          }
          const manifest = readReclaimFile(
            path.join(directory, "manifest.json"),
            65_536
          );
          const bundle = readReclaimFile(
            path.join(directory, "application.mjs"),
            16_777_216
          );
          if (
            digestOf(manifest) !== candidate.manifestDigest ||
            digestOf(bundle) !== candidate.bundleDigest ||
            manifest.length + bundle.length !== candidate.bytes
          ) {
            throw new Error("Changed candidate");
          }
        },
      });
      yield* Effect.yieldNow;
    }
  });
}
