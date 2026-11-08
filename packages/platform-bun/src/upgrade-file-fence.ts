/* oxlint-disable no-bitwise -- Preserve executable bits while tightening fence file permissions. */
import { chmodSync, lstatSync, renameSync } from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import { validateLock } from "./extension-cache.ts";
import { RepositoryLease } from "./ownership.ts";
import { storageError } from "./storage-error.ts";
import {
  readUpgradeFile,
  writeUpgradeFile,
  removeUpgradeFile,
  flushUpgradePath,
  upgradeDirectory,
} from "./upgrade-record-file.ts";
import {
  UpgradeAcceptance,
  UpgradeId,
  UpgradeDigest,
} from "./upgrade-record.ts";

export type FenceKind = "Credentials" | "Extensions";
export interface FenceOwner {
  readonly planId: string;
  readonly targetBuild: string;
}
export const FileEnvelope = Schema.Struct({
  contents: Schema.NullOr(Schema.String),
  format: Schema.Literal(2),
  kind: Schema.Literals(["Credentials", "Extensions"]),
  planId: UpgradeId,
  targetBuild: UpgradeDigest,
});
const Credentials = Schema.Struct({
  repositoryId: Schema.String,
  token: Schema.String,
});
const limits = { Credentials: 65_536, Extensions: 4_194_304 } as const;
const maximum = (kind: FenceKind) => 2 * limits[kind] + 4096;
const invalid = () =>
  new OperationError({
    code: "RevisionUnavailable",
    message:
      "Unsupported or foreign runtime format fence; preserve the repository for its accepting host",
  });
function legacy(kind: FenceKind, contents: string | null) {
  if (contents === null) {
    if (kind === "Credentials") {
      throw invalid();
    }
    return;
  }
  if (Buffer.byteLength(contents) > limits[kind]) {
    throw invalid();
  }
  try {
    const value = JSON.parse(contents);
    if (kind === "Credentials") {
      Schema.decodeUnknownSync(Credentials)(value, {
        onExcessProperty: "error",
      });
    } else {
      validateLock(value);
    }
  } catch {
    throw invalid();
  }
}
export function decodeFenceFile(kind: FenceKind, contents: string | null) {
  if (contents === null) {
    legacy(kind, null);
    return { contents: null, envelope: null } as const;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw invalid();
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "format") === 2
  ) {
    let envelope: typeof FileEnvelope.Type;
    try {
      envelope = Schema.decodeUnknownSync(FileEnvelope)(value, {
        onExcessProperty: "error",
      });
    } catch {
      throw invalid();
    }
    if (envelope.kind !== kind) {
      throw invalid();
    }
    legacy(kind, envelope.contents);
    return { contents: envelope.contents, envelope };
  }
  legacy(kind, contents);
  return { contents, envelope: null };
}
function matches(envelope: typeof FileEnvelope.Type, owner: FenceOwner) {
  return (
    envelope.planId === owner.planId &&
    envelope.targetBuild === owner.targetBuild
  );
}
function restoredFence(
  prior: ReturnType<typeof decodeFenceFile> | null,
  current: ReturnType<typeof decodeFenceFile>,
  previous?: string
) {
  if (!prior?.envelope) {
    return current.contents;
  }
  return current.contents === prior.contents
    ? previous
    : JSON.stringify({ ...prior.envelope, contents: current.contents });
}
function nextFence(
  kind: FenceKind,
  current: ReturnType<typeof decodeFenceFile>,
  owner: FenceOwner,
  action: "Protect" | "Abort",
  previous?: string
) {
  const prior = previous === undefined ? null : decodeFenceFile(kind, previous);
  if (
    prior !== null &&
    (prior.envelope === null || current.envelope === null)
  ) {
    throw invalid();
  }
  const ours = current.envelope !== null && matches(current.envelope, owner);
  const old =
    prior !== null &&
    prior.envelope !== null &&
    current.envelope !== null &&
    matches(current.envelope, prior.envelope);
  if (current.envelope !== null && !ours && !old) {
    throw invalid();
  }
  if (
    (action === "Protect" && ours) ||
    (action === "Abort" && (old || current.envelope === null))
  ) {
    return;
  }
  if (action === "Protect") {
    return JSON.stringify({
      contents: current.contents,
      format: 2,
      kind,
      ...owner,
    });
  }
  // Restore exact predecessor bytes when unchanged. If a logical value changed,
  // preserve it under the predecessor's owner rather than restoring old data.
  return restoredFence(prior, current, previous);
}
export function fileFence(
  repository: string,
  kind: FenceKind,
  owner: FenceOwner,
  action: "Protect" | "Abort",
  step?: (name: string) => void,
  previous?: string
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    return yield* Effect.try({
      catch: (cause) =>
        storageError(cause, "Runtime format fence storage is unavailable"),
      try: () => {
        lease.assertActive();
        const directory = path.join(repository, ".effectory", "upgrades");
        if (!upgradeDirectory(directory, false)) {
          throw invalid();
        }
        const active = readUpgradeFile(
          path.join(directory, "active.json"),
          65_536
        );
        if (active === null) {
          throw invalid();
        }
        let acceptance: typeof UpgradeAcceptance.Type;
        try {
          acceptance = Schema.decodeUnknownSync(UpgradeAcceptance)(
            JSON.parse(active),
            { onExcessProperty: "error" }
          );
        } catch {
          throw invalid();
        }
        if (
          acceptance.planId !== owner.planId ||
          acceptance.targetBuild !== owner.targetBuild
        ) {
          throw invalid();
        }
        const filename =
          kind === "Credentials"
            ? path.join(repository, ".effectory", "credentials.json")
            : path.join(repository, "effectory.extensions.lock.json");
        const current = decodeFenceFile(
          kind,
          readUpgradeFile(filename, maximum(kind))
        );
        const next = nextFence(kind, current, owner, action, previous);
        if (next === undefined) {
          return;
        }
        if (next === null) {
          removeUpgradeFile(filename, maximum(kind));
          return;
        }
        // Staging lives inside the private control tree, never beside user files.
        const staging = path.join(
          directory,
          `fence-${kind.toLowerCase()}.json`
        );
        writeUpgradeFile(staging, next, maximum(kind), true);
        const executable =
          current.contents === null ? 0 : lstatSync(filename).mode & 0o111;
        chmodSync(staging, 0o600 | executable);
        flushUpgradePath(staging);
        step?.("file-staged");
        renameSync(staging, filename);
        flushUpgradePath(path.dirname(filename));
        flushUpgradePath(directory);
        step?.("file-installed");
      },
    });
  });
}
