import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";

import {
  readRuntimeStorage,
  readStoredCredentials,
  readStoredLockContents,
} from "./runtime-storage-format.ts";
import { readUpgradeFile } from "./upgrade-record-file.ts";
import type { UpgradeTransition } from "./upgrade-record.ts";

const invalid = () =>
  new OperationError({
    code: "RevisionUnavailable",
    message:
      "Recovery image does not contain the recorded completed predecessor",
  });

/** Read only from the independently verified image, never from partially transferred source files. */
export function upgradePredecessor(
  image: string,
  transition: typeof UpgradeTransition.Type
) {
  if (transition.plan.source.storage === 1) {
    return;
  }
  const storage = readRuntimeStorage(image);
  if (
    storage === null ||
    storage.targetBuild !== transition.plan.source.build ||
    storage.repositoryId !== transition.plan.repositoryId ||
    storage.platform !== transition.acceptance.platform ||
    storage.architecture !== transition.acceptance.architecture
  ) {
    throw invalid();
  }
  readStoredCredentials(image);
  readStoredLockContents(image);
  const credentials = readUpgradeFile(
    path.join(image, ".effectory/credentials.json"),
    135_168
  );
  const extensions = readUpgradeFile(
    path.join(image, "effectory.extensions.lock.json"),
    8_392_704
  );
  const runtime = readUpgradeFile(
    path.join(image, ".effectory/runtime-storage.json"),
    65_536
  );
  if (credentials === null || extensions === null || runtime === null) {
    throw invalid();
  }
  return {
    credentials,
    extensions,
    owner: { planId: storage.planId, targetBuild: storage.targetBuild },
    runtime,
  };
}
