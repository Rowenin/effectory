import { createHash } from "node:crypto";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect } from "effect";

import { inventoryUpgradeRepository } from "./upgrade-copy.ts";
import type { UpgradeInventoryEntry } from "./upgrade-copy.ts";

export const upgradeInventoryDigest = (
  entries: readonly UpgradeInventoryEntry[]
) => createHash("sha256").update(JSON.stringify(entries)).digest("hex");
const dependencyFiles = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

/** Same bounded file set as recovery copies, including earlier accepted receipts. */
export function fingerprintUpgradeRepository(repository: string) {
  return Effect.gen(function* () {
    const entries = yield* inventoryUpgradeRepository(repository);
    return {
      dependencies: upgradeInventoryDigest(
        entries.filter(
          (entry) =>
            entry.kind === "File" &&
            dependencyFiles.has(path.posix.basename(entry.path))
        )
      ),
      entries,
      identity: upgradeInventoryDigest(entries),
    };
  });
}
export function assertUpgradeFingerprint(expected: string, actual: string) {
  if (expected !== actual) {
    throw new OperationError({
      code: "Conflict",
      message:
        "Repository changed since upgrade planning; create a fresh plan. No transition was accepted.",
    });
  }
}
