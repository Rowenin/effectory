import { renameSync } from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import { Effect, Schema } from "effect";

import { RepositoryLease } from "./ownership.ts";
import type { RuntimeStorage } from "./runtime-storage-format.ts";
import { storageError } from "./storage-error.ts";
import {
  flushUpgradePath,
  readUpgradeFile,
  writeUpgradeFile,
} from "./upgrade-record-file.ts";
import { UpgradeAcceptance } from "./upgrade-record.ts";
import type { UpgradeTransition } from "./upgrade-record.ts";

const invalid = () =>
  new OperationError({
    code: "RevisionUnavailable",
    message: "Runtime format publication does not match its active transition",
  });
/** Published under an active intent; normal startup still refuses until the receipt commits. */
export function publishRuntimeStorage(
  repository: string,
  transition: typeof UpgradeTransition.Type,
  previous?: string
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    yield* Effect.try({
      catch: (cause) =>
        storageError(cause, "Cannot publish upgraded runtime format"),
      try: () => {
        lease.assertActive();
        const { plan, acceptance } = transition;
        if (
          transition.phase !== "Publishing" ||
          (plan.target.storage !== 2 && plan.target.storage !== 3) ||
          plan.target.contract === null
        ) {
          throw invalid();
        }
        const state = path.join(repository, ".effectory");
        const active = readUpgradeFile(
          path.join(state, "upgrades/active.json"),
          65_536
        );
        if (
          active === null ||
          canonical(
            Schema.decodeUnknownSync(UpgradeAcceptance)(JSON.parse(active), {
              onExcessProperty: "error",
            })
          ) !== canonical(acceptance)
        ) {
          throw invalid();
        }
        const value: typeof RuntimeStorage.Type = {
          architecture: acceptance.architecture,
          effectVersion: plan.target.effect,
          executionContract: plan.target.contract,
          format: plan.target.storage,
          planId: plan.planId,
          platform: acceptance.platform,
          repositoryId: plan.repositoryId,
          targetBuild: plan.target.build,
        };
        const encoded = canonical(value);
        const filename = path.join(state, "runtime-storage.json");
        const prior = readUpgradeFile(filename, 65_536);
        if (prior === encoded) {
          return;
        }
        if (prior !== (previous ?? null)) {
          throw invalid();
        }
        const staging = path.join(state, "upgrades/runtime-storage.json");
        writeUpgradeFile(staging, encoded, 65_536, true);
        renameSync(staging, filename);
        flushUpgradePath(state);
        flushUpgradePath(path.dirname(staging));
      },
    });
  });
}
