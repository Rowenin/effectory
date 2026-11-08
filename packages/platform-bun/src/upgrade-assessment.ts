import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Cause, Clock, Effect, Exit, Schema } from "effect";

import { RepositoryLease } from "./ownership.ts";
import { inspectRevisionManifests } from "./revision-manifest.ts";
import { revisionExecutionIdentity } from "./runtime-compatibility.ts";
import {
  readRuntimeStorage,
  readStoredCredentials,
} from "./runtime-storage-format.ts";
import { snapshotMarker } from "./snapshot-marker.ts";
import { storageError } from "./storage-error.ts";
import {
  assertUpgradeFingerprint,
  fingerprintUpgradeRepository,
} from "./upgrade-fingerprint.ts";
import { inspectUpgradeMaintenance } from "./upgrade-maintenance.ts";
import { inspectUpgradeOutbox } from "./upgrade-outbox.ts";
import {
  certifiedStorageTransition,
  runtimeUpgradePolicy,
  runtimeUpgradeStepsFor,
  upgradeRevisionDisposition,
} from "./upgrade-policy.ts";
import type { UpgradePolicy } from "./upgrade-policy.ts";
import { readUpgradeFile } from "./upgrade-record-file.ts";
import type { UpgradePlan } from "./upgrade-record.ts";
import { inspectUpgradeRecovery } from "./upgrade-recovery.ts";
import { withUpgradeInspection } from "./upgrade-storage.ts";
import { assertUpgradeIdle } from "./upgrade-transition-gate.ts";
import { isEmptyUpgradeVault } from "./upgrade-vault-fence.ts";
import { inspectUpgradeVaultIdentity } from "./upgrade-vault-identity.ts";
import { inspectUpgradeWork } from "./upgrade-work.ts";

const Credentials = Schema.Struct({
  repositoryId: Schema.String.check(Schema.isMaxLength(256)),
  token: Schema.String.check(Schema.isMaxLength(4096)),
});
const countsInto = (
  target: Record<string, number>,
  prefix: string,
  counts: Readonly<Record<string, number>>
) => {
  for (const [name, count] of Object.entries(counts)) {
    target[`${prefix}.${name}`] = count;
  }
};

/** No Catalog, schema migration, native runner, author import or provider acquisition. */
export function assessRuntimeUpgrade(
  repository: string,
  planId: string,
  policy: UpgradePolicy = runtimeUpgradePolicy()
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    yield* Effect.try({
      catch: (cause) => storageError(cause, "Cannot inspect upgrade ownership"),
      try: () => {
        lease.assertActive();
        assertUpgradeIdle(repository);
      },
    });
    const before = yield* fingerprintUpgradeRepository(repository);
    const metadata = yield* Effect.try({
      catch: (cause) =>
        storageError(cause, "Runtime upgrade metadata is unavailable"),
      try: () => {
        lease.assertActive();
        assertUpgradeIdle(repository);
        if (
          readUpgradeFile(path.join(repository, snapshotMarker), 65_536) !==
          null
        ) {
          throw new OperationError({
            code: "Conflict",
            message: "Cannot plan an upgrade of an incomplete repository copy",
          });
        }
        const storage = readRuntimeStorage(repository);
        if (
          storage !== null &&
          (storage.platform !== policy.platform ||
            storage.architecture !== policy.architecture)
        ) {
          throw new OperationError({
            code: "RevisionUnavailable",
            message:
              "Stored runtime platform and architecture have no certified transition on this host",
          });
        }
        const text = readUpgradeFile(
          path.join(repository, ".effectory", "credentials.json"),
          135_168
        );
        if (text === null) {
          throw new OperationError({
            code: "NotFound",
            message:
              "Runtime repository credentials are missing; initialize the repository with its compatible host first",
          });
        }
        let repositoryId: string;
        try {
          const credentials = Schema.decodeExit(Credentials)(
            readStoredCredentials(repository),
            { onExcessProperty: "error" }
          );
          if (Exit.isFailure(credentials)) {
            throw Cause.squash(credentials.cause);
          }
          ({ repositoryId } = credentials.value);
        } catch {
          throw new OperationError({
            code: "RevisionUnavailable",
            message:
              "Repository credentials use an unsupported or damaged format",
          });
        }
        try {
          return {
            repositoryId,
            revisions: inspectRevisionManifests(repository),
            storage,
          };
        } catch (error) {
          if (error instanceof OperationError) {
            throw error;
          }
          throw new OperationError({
            code: "RevisionUnavailable",
            message:
              "Retained revision metadata is unsupported or damaged; preserve it for its compatible host",
          });
        }
      },
    });
    const inspection = yield* withUpgradeInspection(
      path.join(repository, ".effectory", "state.sqlite"),
      ({ database }) =>
        Effect.gen(function* () {
          yield* Effect.try({
            catch: () =>
              new OperationError({
                code: "RevisionUnavailable",
                message: "Runtime database has an unsupported storage version",
              }),
            try: () => {
              const statement = database.prepare<{ user_version: number }, []>(
                "PRAGMA user_version"
              );
              try {
                if (statement.get()?.user_version !== 0) {
                  throw new Error("Unsupported storage version");
                }
              } finally {
                statement.finalize();
              }
            },
          });
          const outbox = yield* inspectUpgradeOutbox(database);
          const recovery = yield* inspectUpgradeRecovery(database);
          const maintenance = yield* inspectUpgradeMaintenance(database);
          const execution = yield* inspectUpgradeWork(database);
          return { execution, maintenance, outbox, recovery };
        })
    );
    if (
      before.entries.some((entry) => entry.path === ".effectory/vaults.sqlite")
    ) {
      yield* withUpgradeInspection(
        path.join(repository, ".effectory", "vaults.sqlite"),
        ({ database }) =>
          Effect.gen(function* () {
            yield* Effect.try({
              catch: () =>
                new OperationError({
                  code: "RevisionUnavailable",
                  message: "Vault database has an unsupported storage version",
                }),
              try: () => {
                const statement = database.prepare<
                  { user_version: number },
                  []
                >("PRAGMA user_version");
                try {
                  if (
                    statement.get()?.user_version !==
                    (metadata.storage === null ? 1 : 2)
                  ) {
                    throw new Error("Unsupported vault version");
                  }
                } finally {
                  statement.finalize();
                }
              },
            });
            const { storage } = metadata;
            if (storage !== null) {
              const empty = yield* Effect.try({
                catch: (cause) =>
                  storageError(cause, "Cannot inspect upgraded vault format"),
                try: () =>
                  isEmptyUpgradeVault(database, {
                    planId: storage.planId,
                    targetBuild: storage.targetBuild,
                  }),
              });
              if (empty) {
                return;
              }
            }
            yield* inspectUpgradeVaultIdentity(database);
          })
      );
    }
    const builds = new Set(
      metadata.revisions.map(({ manifest }) => manifest.hostAbi)
    );
    const source = {
      build:
        metadata.storage?.targetBuild ??
        (builds.size === 1 ? ([...builds][0] ?? null) : null),
      dependencies: before.dependencies,
      identity: before.identity,
      storage: metadata.storage?.format ?? 1,
    };
    const edge = certifiedStorageTransition(policy, source);
    const blockers: string[] = [];
    if (edge === undefined) {
      blockers.push(
        "This host has no certified storage transition for this repository's predecessor build and platform. Use the compatible host; no version label or build-hash match grants upgrade permission."
      );
    }
    const known = new Set(metadata.revisions.map(({ revision }) => revision));
    if (
      inspection.execution.revisions.some(
        ({ revision }) => !known.has(revision)
      )
    ) {
      blockers.push(
        "Pending work references a missing retained revision; recover it with the compatible host before upgrading."
      );
    }
    const revisions = metadata.revisions.map(({ manifest, revision }) => ({
      disposition: upgradeRevisionDisposition(
        revisionExecutionIdentity(manifest),
        policy,
        edge !== undefined || source.storage === policy.storage
      ),
      execution: revisionExecutionIdentity(manifest),
      revision,
    }));
    const affected = inspection.execution.revisions.filter(
      (group) =>
        revisions.find((item) => item.revision === group.revision)
          ?.disposition !== "Executable"
    );
    if (affected.length > 0) {
      blockers.push(
        "Nonterminal runs, report work or scheduled admissions require incompatible retained code. Finish or deliberately cancel that work with the compatible host, then plan again."
      );
    }
    if (
      Object.values(inspection.maintenance.counts).some((count) => count > 0)
    ) {
      blockers.push(
        "Filesystem, extension or retirement recovery is pending. Complete it with the compatible host before upgrading."
      );
    }
    const work: Record<string, number> = {};
    countsInto(work, "execution", inspection.execution.counts);
    countsInto(work, "outbox", inspection.outbox.counts);
    countsInto(work, "recovery", inspection.recovery.counts);
    countsInto(work, "maintenance", inspection.maintenance.counts);
    if (
      revisions.some((item) => item.disposition !== "Executable") &&
      [
        ...Object.values(inspection.outbox.counts),
        ...Object.values(inspection.recovery.counts),
      ].some((count) => count > 0)
    ) {
      blockers.push(
        "Pending execution or recovery continuations must settle before a breaking transition."
      );
    }
    const after = yield* fingerprintUpgradeRepository(repository);
    yield* Effect.try({
      catch: (cause) =>
        storageError(cause, "Cannot bind upgrade plan to repository state"),
      try: () => assertUpgradeFingerprint(before.identity, after.identity),
    });
    let status: (typeof UpgradePlan.Type)["status"] = "Ready";
    if (blockers.length > 0) {
      status = "Blocked";
    }
    if (edge === undefined) {
      status = "Unsupported";
    }
    const now = yield* Clock.currentTimeMillis;
    const plan: typeof UpgradePlan.Type = {
      blockers,
      createdAt: now,
      expiresAt: now + 900_000,
      format: 1,
      migrations: [1, 2, 3].includes(source.storage)
        ? [...runtimeUpgradeStepsFor(policy.storage)]
        : [],
      planId,
      recoveryCopy: path.join(
        path.dirname(repository),
        `.effectory-upgrade-${planId}`
      ),
      repositoryId: metadata.repositoryId,
      revisions,
      source,
      status,
      target: { ...policy.execution.current, storage: policy.storage },
      work,
      workByRevision: inspection.execution.revisions,
    };
    return plan;
  });
}
