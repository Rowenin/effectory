import { createHash } from "node:crypto";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import { Schema } from "effect";

import { decodeFenceFile } from "./upgrade-file-fence.ts";
import { runtimeUpgradeStepsFor } from "./upgrade-policy.ts";
import { readUpgradeFile, upgradeDirectory } from "./upgrade-record-file.ts";
import {
  UpgradeDigest,
  UpgradeId,
  UpgradeTransition,
} from "./upgrade-record.ts";
import { assertUpgradeIdle } from "./upgrade-transition-gate.ts";

export const RuntimeStorage = Schema.Struct({
  architecture: Schema.String.check(Schema.isPattern(/^[a-z0-9_-]{1,32}$/u)),
  effectVersion: Schema.String.check(Schema.isMaxLength(64)),
  executionContract: Schema.String.check(Schema.isMaxLength(4096)),
  format: Schema.Literals([2, 3]),
  planId: UpgradeId,
  platform: Schema.String.check(Schema.isPattern(/^[a-z0-9_-]{1,32}$/u)),
  repositoryId: Schema.String.check(Schema.isMaxLength(256)),
  targetBuild: UpgradeDigest,
});
export const StoredCredentials = Schema.Struct({
  repositoryId: Schema.String,
  token: Schema.String,
});
const invalid = () =>
  new OperationError({
    code: "RevisionUnavailable",
    message:
      "Runtime storage is unsupported or has no completed matching upgrade receipt; preserve the repository and use its accepting host",
  });
const decode = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  text: string
): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(text), {
      onExcessProperty: "error",
    });
  } catch {
    throw invalid();
  }
};

/** File-only readiness check. It never opens storage or acquires application code. */
export function readRuntimeStorage(repository: string) {
  assertUpgradeIdle(repository);
  const state = path.join(repository, ".effectory");
  if (!upgradeDirectory(state, false)) {
    return null;
  }
  const text = readUpgradeFile(
    path.join(state, "runtime-storage.json"),
    65_536
  );
  if (text === null) {
    return null;
  }
  const value = decode(RuntimeStorage, text);
  if (!upgradeDirectory(path.join(state, "upgrade-history"), false)) {
    throw invalid();
  }
  const receiptText = readUpgradeFile(
    path.join(state, "upgrade-history", `${value.planId}.json`),
    4_194_304
  );
  if (receiptText === null) {
    throw invalid();
  }
  const receipt = decode(UpgradeTransition, receiptText);
  if (
    receipt.phase !== "Complete" ||
    receipt.acceptance.platform !== value.platform ||
    receipt.acceptance.architecture !== value.architecture ||
    canonical(receipt.plan.migrations) !==
      canonical(runtimeUpgradeStepsFor(value.format)) ||
    receipt.acceptance.planId !== value.planId ||
    receipt.plan.planId !== value.planId ||
    receipt.acceptance.targetBuild !== value.targetBuild ||
    receipt.plan.target.build !== value.targetBuild ||
    receipt.plan.repositoryId !== value.repositoryId ||
    receipt.plan.target.storage !== value.format ||
    receipt.plan.target.contract !== value.executionContract ||
    receipt.plan.target.effect !== value.effectVersion ||
    canonical(receipt.completedSteps) !== canonical(receipt.plan.migrations) ||
    receipt.acceptance.planDigest !==
      createHash("sha256").update(canonical(receipt.plan)).digest("hex")
  ) {
    throw invalid();
  }
  return value;
}

function storedFile(repository: string, kind: "Credentials" | "Extensions") {
  const storage = readRuntimeStorage(repository);
  const filename =
    kind === "Credentials"
      ? path.join(repository, ".effectory/credentials.json")
      : path.join(repository, "effectory.extensions.lock.json");
  const value = decodeFenceFile(
    kind,
    readUpgradeFile(filename, kind === "Credentials" ? 135_168 : 8_392_704)
  );
  if (storage === null) {
    if (value.envelope !== null) {
      throw invalid();
    }
  } else if (
    value.envelope === null ||
    value.envelope.planId !== storage.planId ||
    value.envelope.targetBuild !== storage.targetBuild
  ) {
    throw invalid();
  }
  return { contents: value.contents, storage };
}
export function readStoredCredentials(repository: string) {
  const { contents, storage } = storedFile(repository, "Credentials");
  if (contents === null) {
    throw invalid();
  }
  const credentials = decode(StoredCredentials, contents);
  if (storage !== null && credentials.repositoryId !== storage.repositoryId) {
    throw invalid();
  }
  return credentials;
}
export function readStoredLockContents(repository: string) {
  return storedFile(repository, "Extensions").contents;
}
/** Preserve the downgrade fence when a normal extension activation changes the logical lock. */
export function encodeStoredLock(repository: string, contents: string) {
  const storage = readRuntimeStorage(repository);
  const current = decodeFenceFile(
    "Extensions",
    readUpgradeFile(
      path.join(repository, "effectory.extensions.lock.json"),
      8_392_704
    )
  );
  decodeFenceFile("Extensions", contents);
  if (storage === null) {
    if (current.envelope !== null) {
      throw invalid();
    }
    return contents;
  }
  if (
    current.envelope === null ||
    current.envelope.planId !== storage.planId ||
    current.envelope.targetBuild !== storage.targetBuild
  ) {
    throw invalid();
  }
  return JSON.stringify({ ...current.envelope, contents });
}
