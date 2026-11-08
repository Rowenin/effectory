import { createHash } from "node:crypto";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect } from "effect";

import { inventoryUpgradeRepository } from "./upgrade-copy.ts";
import type { UpgradeInventoryEntry } from "./upgrade-copy.ts";
import { decodeFenceFile } from "./upgrade-file-fence.ts";
import type { FenceOwner } from "./upgrade-file-fence.ts";
import { readUpgradeFile } from "./upgrade-record-file.ts";
import { withUpgradeInspection } from "./upgrade-storage.ts";
import { isEmptyUpgradeVault } from "./upgrade-vault-fence.ts";
import { inspectUpgradeVaultIdentity } from "./upgrade-vault-identity.ts";

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const vault = ".effectory/vaults.sqlite";
const vaultFiles = new Set([vault, `${vault}-wal`, `${vault}-journal`]);
const protectedKinds: ReadonlyMap<string, "Credentials" | "Extensions"> =
  new Map([
    [".effectory/credentials.json", "Credentials"],
    ["effectory.extensions.lock.json", "Extensions"],
  ]);
const invalid = () =>
  new OperationError({
    code: "RevisionUnavailable",
    message:
      "Foreign or damaged format fence; preserve the transition for its accepting host",
  });
function normalized(
  root: string,
  entries: readonly UpgradeInventoryEntry[],
  baseline: readonly UpgradeInventoryEntry[],
  owner: FenceOwner,
  previous?: FenceOwner
) {
  const result: UpgradeInventoryEntry[] = [];
  for (const item of entries) {
    if (item.path === `.effectory/upgrade-history/${owner.planId}.json`) {
      continue;
    }
    if (
      item.path === ".effectory/upgrade-history" &&
      !baseline.some((x) => x.path === item.path)
    ) {
      continue;
    }
    if (vaultFiles.has(item.path)) {
      continue;
    }
    const kind = protectedKinds.get(item.path) ?? null;
    if (kind === null) {
      result.push(item);
      continue;
    }
    if (item.kind !== "File") {
      throw invalid();
    }
    const current = decodeFenceFile(
      kind,
      readUpgradeFile(path.join(root, item.path), 8_392_704)
    );
    if (
      current.envelope !== null &&
      ![owner, ...(previous ? [previous] : [])].some(
        (candidate) =>
          current.envelope?.planId === candidate.planId &&
          current.envelope.targetBuild === candidate.targetBuild
      )
    ) {
      throw invalid();
    }
    if (current.contents !== null) {
      result.push({
        ...item,
        bytes: Buffer.byteLength(current.contents),
        digest: createHash("sha256").update(current.contents).digest("hex"),
      });
    }
  }
  return result;
}
/** Recovery image has already been independently verified and remains ownership-pinned. */
export function verifyProtectedSource(
  root: string,
  image: string,
  baseline: readonly UpgradeInventoryEntry[],
  owner: FenceOwner,
  previous?: FenceOwner
) {
  return Effect.gen(function* () {
    const before = yield* inventoryUpgradeRepository(root);
    const actual = yield* Effect.try({
      catch: () => invalid(),
      try: () => normalized(root, before, baseline, owner, previous),
    });
    const expected = yield* Effect.try({
      catch: () => invalid(),
      try: () => normalized(image, baseline, baseline, owner, previous),
    });
    if (!same(expected, actual)) {
      return false;
    }
    const original = baseline.some((x) => x.path === vault);
    const current = before.some((x) => x.path === vault);
    if (original && !current) {
      return false;
    }
    if (original) {
      const identity = (filename: string) =>
        withUpgradeInspection(filename, ({ database }) =>
          Effect.gen(function* () {
            const empty = yield* Effect.try({
              catch: () => invalid(),
              try: () =>
                previous !== undefined &&
                isEmptyUpgradeVault(database, previous, owner),
            });
            return empty
              ? "empty"
              : (yield* inspectUpgradeVaultIdentity(database)).digest;
          })
        );
      const first = yield* identity(path.join(image, vault));
      const second = yield* identity(path.join(root, vault));
      if (first !== second) {
        return false;
      }
    } else if (current) {
      const sentinel = yield* withUpgradeInspection(
        path.join(root, vault),
        ({ database }) =>
          Effect.try({
            catch: () => invalid(),
            try: () => isEmptyUpgradeVault(database, owner),
          })
      );
      if (!sentinel) {
        return false;
      }
    } else if (before.some((x) => vaultFiles.has(x.path))) {
      return false;
    }
    return same(before, yield* inventoryUpgradeRepository(root));
  });
}
