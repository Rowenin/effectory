import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import { ownershipLayer } from "./ownership.ts";
import { storageError } from "./storage-error.ts";
import { assessRuntimeUpgrade } from "./upgrade-assessment.ts";
import {
  acceptRuntimeUpgrade,
  resumeRuntimeUpgrade,
} from "./upgrade-executor.ts";
import {
  assertUpgradeFingerprint,
  fingerprintUpgradeRepository,
} from "./upgrade-fingerprint.ts";
import { makeUpgradeJournal } from "./upgrade-journal.ts";
import {
  certifiedStorageTransition,
  runtimeUpgradePolicy,
} from "./upgrade-policy.ts";
import { UpgradeId, terminalUpgrade } from "./upgrade-record.ts";

export type UpgradeAction =
  | { readonly kind: "Plan" }
  | { readonly kind: "Apply" | "Inspect"; readonly planId: string };

/** Validate before SQLite opens the separate ownership file; never create runtime state. */
function location(repository: string, action: UpgradeAction) {
  return Effect.try({
    catch: (cause) =>
      storageError(cause, "Cannot acquire offline runtime upgrade ownership"),
    try: () => {
      if (action.kind !== "Plan" && !Schema.is(UpgradeId)(action.planId)) {
        throw new OperationError({
          code: "InvalidInput",
          message: "Invalid upgrade plan ID",
        });
      }
      const root = realpathSync(repository);
      const state = path.join(root, ".effectory");
      if (!lstatSync(state).isDirectory()) {
        throw new OperationError({
          code: "InvalidInput",
          message:
            "Runtime upgrade requires a real initialized state directory",
        });
      }
      const owner = path.join(state, "state.sqlite.owner");
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try {
          const stat = lstatSync(owner + suffix);
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576) {
            throw new OperationError({
              code: "InvalidInput",
              message:
                "Upgrade ownership files must be bounded single-link regular files",
            });
          }
        } catch (error) {
          if (
            typeof error !== "object" ||
            error === null ||
            Reflect.get(error, "code") !== "ENOENT"
          ) {
            throw error;
          }
        }
      }
      return { owner, root };
    },
  });
}

/** Offline commands: no RPC connection, daemon auto-start, application import or service acquisition. */
export function runtimeUpgrade(repository: string, action: UpgradeAction) {
  return Effect.gen(function* () {
    const { owner, root } = yield* location(repository, action);
    return yield* Effect.gen(function* () {
      const journal = yield* makeUpgradeJournal(root);
      if (action.kind === "Plan") {
        const plan = yield* assessRuntimeUpgrade(root, crypto.randomUUID());
        return yield* journal.savePlan(plan);
      }
      const saved = yield* journal.inspect(action.planId);
      if (action.kind === "Inspect") {
        return saved;
      }
      const policy = runtimeUpgradePolicy();
      if (saved._tag === "Accepted") {
        const record = saved.transition;
        // A receipt wins over expiration/source changes, including when read by
        // a later build. Only the accepting build may release its own pointer.
        if (terminalUpgrade(record.phase)) {
          return record.acceptance.targetBuild ===
            policy.execution.current.build &&
            record.acceptance.platform === process.platform &&
            record.acceptance.architecture === process.arch
            ? yield* journal.release(
                action.planId,
                policy.execution.current.build
              )
            : record;
        }
        return yield* resumeRuntimeUpgrade(root, record, policy);
      }
      if (
        Date.now() >= saved.plan.expiresAt ||
        saved.plan.target.build !== policy.execution.current.build
      ) {
        return yield* new OperationError({
          code: "Conflict",
          message:
            "Upgrade plan expired or belongs to another target build; create a fresh plan. No transition was accepted.",
        });
      }
      const current = yield* fingerprintUpgradeRepository(root);
      yield* Effect.try({
        catch: (cause) => storageError(cause, "Cannot revalidate upgrade plan"),
        try: () =>
          assertUpgradeFingerprint(
            saved.plan.source.identity,
            current.identity
          ),
      });
      if (
        saved.plan.status !== "Ready" ||
        certifiedStorageTransition(policy, saved.plan.source) === undefined
      ) {
        return yield* new OperationError({
          code: "RevisionUnavailable",
          message: `Upgrade plan ${action.planId} has no applicable certified transition. Use upgrade inspect ${action.planId} to review blocking work and required compatibility; no runtime data was changed.`,
        });
      }
      return yield* acceptRuntimeUpgrade(root, saved, policy);
    }).pipe(
      Effect.provide(ownershipLayer(owner)),
      Effect.scoped,
      Effect.catchTag("RepositoryBusy", () =>
        Effect.fail(
          new OperationError({
            code: "Conflict",
            message:
              "Repository is owned by another process; stop the compatible daemon before running offline upgrade commands",
          })
        )
      )
    );
  });
}
