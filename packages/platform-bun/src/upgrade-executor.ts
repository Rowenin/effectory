import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import { Clock, Effect } from "effect";

import { storageError } from "./storage-error.ts";
import { assessRuntimeUpgrade } from "./upgrade-assessment.ts";
import {
  createUpgradeRecoveryCopy,
  verifyUpgradeRecoveryCopy,
} from "./upgrade-copy.ts";
import { fileFence } from "./upgrade-file-fence.ts";
import {
  fingerprintUpgradeRepository,
  upgradeInventoryDigest,
} from "./upgrade-fingerprint.ts";
import { makeUpgradeJournal } from "./upgrade-journal.ts";
import {
  certifiedStorageTransition,
  runtimeUpgradeStepsFor,
} from "./upgrade-policy.ts";
import type { UpgradePolicy } from "./upgrade-policy.ts";
import { upgradePredecessor } from "./upgrade-predecessor.ts";
import { verifyProtectedSource } from "./upgrade-protected-source.ts";
import { publishRuntimeStorage } from "./upgrade-publication.ts";
import { readUpgradeFile } from "./upgrade-record-file.ts";
import { terminalUpgrade } from "./upgrade-record.ts";
import type { UpgradePlan, UpgradeTransition } from "./upgrade-record.ts";
import {
  prepareVaultFence,
  retargetVaultFence,
  vaultFence,
} from "./upgrade-vault-fence.ts";

const refused = (message: string) =>
  new OperationError({ code: "RevisionUnavailable", message });
const conflict = (message: string) =>
  new OperationError({ code: "Conflict", message });
type Step = (name: string) => Effect.Effect<void>;
const noStep: Step = () => Effect.void;
function applicable(plan: typeof UpgradePlan.Type, policy: UpgradePolicy) {
  if (
    plan.status !== "Ready" ||
    ![1, 2, 3].includes(plan.source.storage) ||
    plan.source.storage > plan.target.storage ||
    plan.blockers.length !== 0 ||
    canonical(plan.target) !==
      canonical({ ...policy.execution.current, storage: policy.storage }) ||
    ![2, 3].includes(plan.target.storage) ||
    canonical(plan.migrations) !==
      canonical(runtimeUpgradeStepsFor(plan.target.storage)) ||
    certifiedStorageTransition(policy, plan.source) === undefined
  ) {
    throw refused(
      "This accepting host has no certified executor for the recorded transition; preserve the repository and recovery copy"
    );
  }
}

/** A complete copy left before acceptance is reusable; an incomplete copy is never overwritten. */
function recoveryCopy(repository: string, plan: typeof UpgradePlan.Type) {
  return Effect.gen(function* () {
    const existing = yield* Effect.try({
      catch: (cause) =>
        storageError(cause, "Cannot inspect the upgrade recovery destination"),
      try: () => {
        try {
          return lstatSync(plan.recoveryCopy);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            Reflect.get(error, "code") === "ENOENT"
          ) {
            return null;
          }
          throw error;
        }
      },
    });
    if (existing === null) {
      return yield* createUpgradeRecoveryCopy(
        repository,
        plan.recoveryCopy,
        plan.planId
      );
    }
    const digest = yield* Effect.try({
      catch: (cause) =>
        storageError(
          cause,
          "Preserve the incomplete recovery copy and create a fresh upgrade plan"
        ),
      try: () => {
        if (!existing.isDirectory()) {
          throw conflict(
            "Recovery destination is occupied; create a fresh upgrade plan"
          );
        }
        const text = readUpgradeFile(
          path.join(plan.recoveryCopy, "manifest.json"),
          16_777_216
        );
        if (text === null) {
          throw conflict(
            "Recovery copy is incomplete; preserve it and create a fresh upgrade plan"
          );
        }
        return createHash("sha256").update(text).digest("hex");
      },
    });
    const manifest = yield* verifyUpgradeRecoveryCopy(
      plan.recoveryCopy,
      plan.planId,
      digest
    );
    return { destination: plan.recoveryCopy, digest, manifest };
  });
}

function assertResumePlatform(
  record: typeof UpgradeTransition.Type,
  policy: UpgradePolicy
) {
  if (
    record.acceptance.platform !== policy.platform ||
    record.acceptance.architecture !== policy.architecture
  ) {
    throw refused(
      "Accepted upgrade requires its original host platform and architecture"
    );
  }
}
/** First certified migration changes format fences only; native and host rows stay unchanged. */
export function resumeRuntimeUpgrade(
  repository: string,
  record: typeof UpgradeTransition.Type,
  policy: UpgradePolicy,
  step: Step = noStep,
  verified?: Effect.Success<ReturnType<typeof verifyUpgradeRecoveryCopy>>
) {
  return Effect.gen(function* () {
    yield* Effect.try({
      catch: (cause) => storageError(cause, "Cannot resume runtime transition"),
      try: () => {
        applicable(record.plan, policy);
        assertResumePlatform(record, policy);
      },
    });
    const journal = yield* makeUpgradeJournal(repository);
    const owner = {
      planId: record.plan.planId,
      targetBuild: record.acceptance.targetBuild,
    };
    if (terminalUpgrade(record.phase)) {
      return yield* journal.release(owner.planId, owner.targetBuild);
    }
    const manifest =
      verified ??
      (yield* verifyUpgradeRecoveryCopy(
        record.plan.recoveryCopy,
        owner.planId,
        record.acceptance.recoveryDigest
      ));
    if (
      (record.phase === "Migrating" || record.phase === "Publishing") &&
      record.completedSteps.length < 3
    ) {
      return yield* refused(
        "Upgrade migration progress is inconsistent with its phase"
      );
    }
    if (
      manifest.source !== repository ||
      upgradeInventoryDigest(manifest.entries) !== record.plan.source.identity
    ) {
      return yield* refused(
        "Accepted recovery image does not match the original repository identity"
      );
    }
    const originalVault = manifest.entries.some(
      (entry) => entry.path === ".effectory/vaults.sqlite"
    );
    const image = path.join(record.plan.recoveryCopy, "repository");
    const previous = yield* Effect.try({
      catch: (cause) =>
        storageError(cause, "Cannot validate the predecessor recovery image"),
      try: () => upgradePredecessor(image, record),
    });
    const files = (
      kind: "Credentials" | "Extensions",
      action: "Protect" | "Abort"
    ) =>
      fileFence(
        repository,
        kind,
        owner,
        action,
        undefined,
        kind === "Credentials" ? previous?.credentials : previous?.extensions
      );
    const vault = (action: "Protect" | "Abort") =>
      previous && originalVault
        ? retargetVaultFence(repository, owner, previous.owner, action)
        : vaultFence(repository, owner, action, originalVault).pipe(
            Effect.asVoid
          );
    let current = record;
    const checkpoint = (update: Parameters<typeof journal.checkpoint>[2]) =>
      Effect.gen(function* () {
        current = yield* journal.checkpoint(
          owner.planId,
          owner.targetBuild,
          update,
          Math.max(current.updatedAt, yield* Clock.currentTimeMillis)
        );
        yield* step(
          `checkpoint/${current.phase}/${current.completedSteps.length}`
        );
      });
    const abort = () =>
      Effect.gen(function* () {
        if (current.phase !== "Aborting") {
          yield* checkpoint({
            abortReason: "SourceChanged",
            phase: "Aborting",
          });
        }
        // Undo only this transition's formats. Never restore the old image over a later write.
        yield* vault("Abort");
        yield* step("abort/vault");
        yield* files("Extensions", "Abort");
        yield* step("abort/extensions");
        yield* files("Credentials", "Abort");
        yield* step("abort/credentials");
        yield* checkpoint({ phase: "Aborted" });
        return yield* journal.release(owner.planId, owner.targetBuild);
      });
    if (current.phase === "Aborting") {
      return yield* abort();
    }
    if (current.phase === "Protecting" || current.phase === "Fenced") {
      yield* prepareVaultFence(repository, owner);
      const unchanged = () =>
        verifyProtectedSource(
          repository,
          image,
          manifest.entries,
          owner,
          previous?.owner
        );
      if (!(yield* unchanged())) {
        return yield* abort();
      }
      const fences = [
        files("Credentials", "Protect"),
        vault("Protect"),
        files("Extensions", "Protect"),
      ];
      for (let index = 0; index < fences.length; index += 1) {
        const fence = fences[index];
        const name = current.plan.migrations[index];
        if (fence === undefined || name === undefined) {
          return yield* refused("Incomplete format migration definition");
        }
        yield* fence;
        yield* step(name);
        if (!(yield* unchanged())) {
          return yield* abort();
        }
        if (!current.completedSteps.includes(name)) {
          yield* checkpoint({ completedStep: name });
        }
      }
      yield* checkpoint({ phase: "Fenced" });
      yield* checkpoint({ phase: "Migrating" });
    }
    if (current.phase === "Migrating") {
      yield* checkpoint({ phase: "Publishing" });
    }
    if (current.phase === "Publishing") {
      yield* publishRuntimeStorage(repository, current, previous?.runtime);
      yield* step("runtime-storage-published");
      yield* checkpoint({
        completedStep: `runtime-storage-v${current.plan.target.storage}`,
      });
      yield* checkpoint({ phase: "Complete" });
    }
    return yield* journal.release(owner.planId, owner.targetBuild);
  });
}

/** Policy and every source-derived plan field are recomputed before accepting any transition. */
export function acceptRuntimeUpgrade(
  repository: string,
  saved: { readonly plan: typeof UpgradePlan.Type; readonly digest: string },
  policy: UpgradePolicy,
  step: Step = noStep
) {
  return Effect.gen(function* () {
    yield* Effect.try({
      catch: (cause) =>
        storageError(cause, "Cannot authorize runtime transition"),
      try: () => applicable(saved.plan, policy),
    });
    const fresh = yield* assessRuntimeUpgrade(
      repository,
      saved.plan.planId,
      policy
    );
    if (
      canonical({
        ...fresh,
        createdAt: saved.plan.createdAt,
        expiresAt: saved.plan.expiresAt,
      }) !== canonical(saved.plan)
    ) {
      return yield* conflict(
        "Upgrade policy or source state changed; create a fresh plan. No transition was accepted."
      );
    }
    const copy = yield* recoveryCopy(repository, saved.plan);
    if (
      copy.manifest.source !== repository ||
      upgradeInventoryDigest(copy.manifest.entries) !==
        saved.plan.source.identity
    ) {
      return yield* conflict(
        "Recovery image does not match the planned repository; create a fresh plan"
      );
    }
    const current = yield* fingerprintUpgradeRepository(repository);
    if (current.identity !== saved.plan.source.identity) {
      return yield* conflict(
        "Repository changed while creating the recovery image; no transition was accepted"
      );
    }
    yield* step("copy-verified");
    const journal = yield* makeUpgradeJournal(repository);
    const accepted = yield* journal.accept(
      {
        planDigest: saved.digest,
        planId: saved.plan.planId,
        recoveryDigest: copy.digest,
        sourceIdentity: current.identity,
        targetBuild: policy.execution.current.build,
      },
      yield* Clock.currentTimeMillis
    );
    yield* step("accepted");
    return yield* resumeRuntimeUpgrade(
      repository,
      accepted,
      policy,
      step,
      copy.manifest
    );
  });
}
