import { lstatSync } from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect } from "effect";

import { RepositoryLease } from "./ownership.ts";
import { inspectRevisionManifests } from "./revision-manifest.ts";
import {
  assertRevisionExecutable,
  executionCompatibility,
  revisionExecutionIdentity,
  runtimeExecutionPolicy,
} from "./runtime-compatibility.ts";
import {
  readRuntimeStorage,
  readStoredCredentials,
  readStoredLockContents,
} from "./runtime-storage-format.ts";
import { inspectUpgradeMaintenance } from "./upgrade-maintenance.ts";
import { inspectUpgradeOutbox } from "./upgrade-outbox.ts";
import { inspectUpgradeRecovery } from "./upgrade-recovery.ts";
import { withRuntimeInspection } from "./upgrade-storage.ts";
import { assertUpgradeIdle } from "./upgrade-transition-gate.ts";
import { inspectUpgradeWork } from "./upgrade-work.ts";

/** Must run under offline ownership, before credentials or any recovery mutates state. */
export function preflightRuntime(repository: string) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const readiness = yield* Effect.try({
      catch: (cause) =>
        cause instanceof OperationError
          ? cause
          : new OperationError({
              code: "RevisionUnavailable",
              message:
                "Retained application metadata is unsupported or damaged; preserve the repository for its compatible host",
            }),
      try: () => {
        lease.assertActive();
        assertUpgradeIdle(repository);
        const policy = runtimeExecutionPolicy();
        const storage = readRuntimeStorage(repository);
        if (storage !== null) {
          if (
            storage.targetBuild !== policy.current.build ||
            storage.platform !== process.platform ||
            storage.architecture !== process.arch ||
            storage.effectVersion !== policy.current.effect
          ) {
            throw new OperationError({
              code: "RevisionUnavailable",
              message: `Runtime storage was accepted by host build ${storage.targetBuild}; use offline upgrade plan/apply with a certified host before execution`,
            });
          }
          readStoredCredentials(repository);
          readStoredLockContents(repository);
        }
        const executable = new Set<string>();
        for (const { manifest, revision } of inspectRevisionManifests(
          repository
        )) {
          const compatibility = executionCompatibility(
            revisionExecutionIdentity(manifest),
            policy
          );
          if (storage === null) {
            assertRevisionExecutable(revision, manifest, policy);
            if (compatibility !== "ExactBuild") {
              throw new OperationError({
                code: "RevisionUnavailable",
                message:
                  "Certified execution requires the offline storage upgrade first; run upgrade plan and upgrade apply with this host",
              });
            }
          }
          if (compatibility !== "Unavailable") {
            executable.add(revision);
          }
        }
        return { executable, storage };
      },
    });
    const filename = path.join(repository, ".effectory", "state.sqlite");
    const exists = yield* Effect.try({
      catch: () =>
        new OperationError({
          code: "Unavailable",
          message: "Cannot inspect runtime storage before startup",
        }),
      try: () => {
        try {
          lstatSync(filename);
          return true;
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            Reflect.get(error, "code") === "ENOENT"
          ) {
            return false;
          }
          throw error;
        }
      },
    });
    if (!exists) {
      if (readiness.storage !== null) {
        return yield* new OperationError({
          code: "RevisionUnavailable",
          message:
            "Upgraded runtime database is missing; preserve the recovery copy",
        });
      }
      return;
    }
    yield* withRuntimeInspection(filename, ({ database }) =>
      Effect.gen(function* () {
        yield* Effect.try({
          catch: () =>
            new OperationError({
              code: "RevisionUnavailable",
              message:
                "Unsupported native runtime storage format; no startup mutations were performed",
            }),
          try: () => {
            const version = database.prepare<{ user_version: number }, []>(
              "PRAGMA user_version"
            );
            try {
              if (version.get()?.user_version !== 0) {
                throw new Error("Unknown format");
              }
            } finally {
              version.finalize();
            }
          },
        });
        yield* inspectUpgradeOutbox(database);
        yield* inspectUpgradeRecovery(database);
        yield* inspectUpgradeMaintenance(database);
        if (readiness.storage !== null) {
          const work = yield* inspectUpgradeWork(database);
          if (
            work.revisions.some(
              (group) => !readiness.executable.has(group.revision)
            )
          ) {
            return yield* new OperationError({
              code: "RevisionUnavailable",
              message:
                "Pending work requires archived or missing application code; use its compatible host and recovery copy before execution",
            });
          }
        }
      })
    );
  });
}
