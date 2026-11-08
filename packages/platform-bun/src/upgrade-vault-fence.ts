import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import { RepositoryLease } from "./ownership.ts";
import { storageError } from "./storage-error.ts";
import type { FenceOwner } from "./upgrade-file-fence.ts";
import { readUpgradeFile, flushUpgradePath } from "./upgrade-record-file.ts";
import { UpgradeAcceptance } from "./upgrade-record.ts";
import { withUpgradeInspection } from "./upgrade-storage.ts";
import { inspectUpgradeVaultIdentity } from "./upgrade-vault-identity.ts";

const invalid = () =>
  new OperationError({
    code: "RevisionUnavailable",
    message:
      "Unsupported or foreign vault format fence; preserve the repository for its accepting host",
  });
function owned(repository: string, owner: FenceOwner) {
  const raw = readUpgradeFile(
    path.join(repository, ".effectory/upgrades/active.json"),
    65_536
  );
  if (raw === null) {
    throw invalid();
  }
  let active: typeof UpgradeAcceptance.Type;
  try {
    active = Schema.decodeUnknownSync(UpgradeAcceptance)(JSON.parse(raw), {
      onExcessProperty: "error",
    });
  } catch {
    throw invalid();
  }
  if (
    active.planId !== owner.planId ||
    active.targetBuild !== owner.targetBuild
  ) {
    throw invalid();
  }
}
function present(filename: string) {
  try {
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 67_108_864) {
      throw invalid();
    }
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
}
function version(db: Database) {
  const statement = db.prepare<{ user_version: number }, []>(
    "PRAGMA user_version"
  );
  try {
    return statement.get()?.user_version;
  } finally {
    statement.finalize();
  }
}
const sentinelSchema =
  "CREATE TABLE effectory_upgrade_empty(planId TEXT NOT NULL,targetBuild TEXT NOT NULL)";
export function isEmptyUpgradeVault(
  db: Database,
  owner: FenceOwner,
  previous?: FenceOwner
) {
  if (version(db) !== 2) {
    return false;
  }
  const s = db.prepare<{ name: string; type: string; sql: string | null }, []>(
    "SELECT name,type,sql FROM sqlite_master LIMIT 3"
  );
  let tables;
  try {
    tables = s.all();
  } finally {
    s.finalize();
  }
  if (
    tables.length !== 1 ||
    tables[0]?.type !== "table" ||
    tables[0].name !== "effectory_upgrade_empty" ||
    tables[0].sql !== sentinelSchema
  ) {
    return false;
  }
  const r = db.prepare<{ planId: string; targetBuild: string }, []>(
    "SELECT planId,targetBuild FROM effectory_upgrade_empty LIMIT 2"
  );
  let rows;
  try {
    rows = r.all();
  } finally {
    r.finalize();
  }
  if (
    rows.length !== 1 ||
    ![owner, ...(previous ? [previous] : [])].some(
      (candidate) =>
        rows[0]?.planId === candidate.planId &&
        rows[0].targetBuild === candidate.targetBuild
    )
  ) {
    throw invalid();
  }
  return true;
}
/** Finish private staging cleanup before source inventory enforces single-link files. */
export function prepareVaultFence(repository: string, owner: FenceOwner) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const filename = path.join(repository, ".effectory/vaults.sqlite");
    const staging = path.join(
      repository,
      ".effectory/upgrades/vault-fence.sqlite"
    );
    const io = <A>(body: () => A) =>
      Effect.try({
        catch: (cause) =>
          storageError(cause, "Vault format fence storage is unavailable"),
        try: () => {
          lease.assertActive();
          owned(repository, owner);
          return body();
        },
      });
    // A kill between link and unlink leaves the owned staging inode linked twice.
    // Only unlink that private name after proving it is the current target inode.
    yield* io(() => {
      if (existsSync(filename) && existsSync(staging)) {
        const a = lstatSync(filename);
        const b = lstatSync(staging);
        if (
          a.isFile() &&
          b.isFile() &&
          a.dev === b.dev &&
          a.ino === b.ino &&
          a.nlink === 2 &&
          b.nlink === 2
        ) {
          unlinkSync(staging);
          flushUpgradePath(path.dirname(staging));
        }
      }
    });
    // The private staging database has no authority until linked at filename.
    // A killed SQLite construction may leave an empty file or hot journal. Those
    // owned scratch files can be discarded; never do this to the source database.
    yield* io(() => {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        const file = staging + suffix;
        if (present(file)) {
          unlinkSync(file);
          flushUpgradePath(path.dirname(file));
        }
      }
    });
  });
}
export function vaultFence(
  repository: string,
  owner: FenceOwner,
  action: "Protect" | "Abort",
  originalExists: boolean,
  step?: (name: string) => void
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const filename = path.join(repository, ".effectory/vaults.sqlite");
    const staging = path.join(
      repository,
      ".effectory/upgrades/vault-fence.sqlite"
    );
    const io = <A>(body: () => A) =>
      Effect.try({
        catch: (cause) =>
          storageError(cause, "Vault format fence storage is unavailable"),
        try: () => {
          lease.assertActive();
          owned(repository, owner);
          return body();
        },
      });
    yield* prepareVaultFence(repository, owner);
    const exists = yield* io(() => present(filename));
    if (!exists) {
      if (originalExists) {
        return yield* invalid();
      }
      if (action === "Abort") {
        return { kind: "Absent" as const };
      }
      yield* io(() => {
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          if (existsSync(filename + suffix)) {
            throw invalid();
          }
        }
        const db = new Database(staging, { create: true });
        try {
          chmodSync(staging, 0o600);
          step?.("vault-staging-created");
          db.run(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE effectory_upgrade_empty(planId TEXT NOT NULL,targetBuild TEXT NOT NULL);"
          );
          db.query("INSERT INTO effectory_upgrade_empty VALUES(?,?)").run(
            owner.planId,
            owner.targetBuild
          );
          db.run("PRAGMA user_version=2; COMMIT;");
          step?.("vault-staging-committed");
        } finally {
          db.close();
        }
        flushUpgradePath(staging);
        flushUpgradePath(path.dirname(staging));
        step?.("vault-staging-ready");
        linkSync(staging, filename);
        flushUpgradePath(path.dirname(filename));
        step?.("vault-linked");
        unlinkSync(staging);
        flushUpgradePath(path.dirname(staging));
      });
      return { kind: "Empty" as const };
    }
    const inspected = yield* withUpgradeInspection(filename, ({ database }) =>
      Effect.gen(function* () {
        const v = version(database);
        if (v !== 0 && v !== 1 && v !== 2) {
          return yield* invalid();
        }
        if (v === 2 && isEmptyUpgradeVault(database, owner)) {
          return { empty: true, version: v };
        }
        if (v !== 2 && !originalExists) {
          return { empty: false, version: v };
        }
        if (!originalExists) {
          return yield* invalid();
        }
        yield* inspectUpgradeVaultIdentity(database);
        return { empty: false, version: v };
      })
    );
    if (inspected.empty) {
      if (originalExists) {
        return yield* invalid();
      }
      if (action === "Abort") {
        yield* io(() => {
          // Sentinel was installed checkpointed in DELETE mode. Unexpected journals
          // are not deleted; they can belong to unverified writes.
          for (const suffix of ["-wal", "-journal"]) {
            if (
              existsSync(filename + suffix) &&
              lstatSync(filename + suffix).size > 0
            ) {
              throw invalid();
            }
          }
          unlinkSync(filename);
          flushUpgradePath(path.dirname(filename));
        });
        return { kind: "Absent" as const };
      }
      return { kind: "Empty" as const };
    }
    if (
      (action === "Protect" && inspected.version === 2) ||
      (action === "Abort" &&
        (inspected.version === 1 || inspected.version === 0))
    ) {
      return { kind: "Existing" as const };
    }
    if (!originalExists && action === "Protect") {
      return yield* new OperationError({
        code: "Conflict",
        message:
          "A vault appeared after upgrade planning; abort without replacing it",
      });
    }
    yield* io(() => {
      const db = new Database(filename, { create: false, readwrite: true });
      try {
        db.run("PRAGMA synchronous=FULL;");
        db.transaction(() => {
          if (version(db) !== inspected.version) {
            throw invalid();
          }
          db.run(`PRAGMA user_version=${action === "Protect" ? 2 : 1}`);
          step?.("vault-version-written");
        }).immediate();
        step?.("vault-version-committed");
        const checkpoint = db.prepare<{ busy: number }, []>(
          "PRAGMA wal_checkpoint(TRUNCATE)"
        );
        try {
          if (checkpoint.get()?.busy !== 0) {
            throw new OperationError({
              code: "Unavailable",
              message:
                "Vault format fence checkpoint is busy; resume this transition",
            });
          }
        } finally {
          checkpoint.finalize();
        }
      } finally {
        db.close();
      }
      flushUpgradePath(filename);
      flushUpgradePath(path.dirname(filename));
    });
    return { kind: "Existing" as const };
  });
}

/** A format-2 database keeps its format and contents; only an empty sentinel has an owner. */
export function retargetVaultFence(
  repository: string,
  owner: FenceOwner,
  previous: FenceOwner,
  action: "Protect" | "Abort",
  step?: (name: string) => void
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const filename = path.join(repository, ".effectory/vaults.sqlite");
    const empty = yield* withUpgradeInspection(filename, ({ database }) =>
      Effect.gen(function* () {
        const sentinel = yield* Effect.try({
          catch: () => invalid(),
          try: () => {
            if (version(database) !== 2) {
              throw invalid();
            }
            return isEmptyUpgradeVault(database, owner, previous);
          },
        });
        if (!sentinel) {
          yield* inspectUpgradeVaultIdentity(database);
        }
        return sentinel;
      })
    );
    // Ordinary databases are unchanged, including an intervening valid reset.
    if (!empty) {
      return;
    }
    // The sentinel is a tiny immutable ownership record. Never update it in place:
    // a killed rollback-mode transaction would make read-only upgrade inspection
    // refuse its hot journal. Publish a complete replacement with one rename.
    yield* prepareVaultFence(repository, owner);
    yield* Effect.try({
      catch: (cause) =>
        storageError(cause, "Cannot transfer empty vault ownership"),
      try: () => {
        lease.assertActive();
        owned(repository, owner);
        if (!present(filename)) {
          throw invalid();
        }
        const destination = action === "Protect" ? owner : previous;
        const source = action === "Protect" ? previous : owner;
        const original = new Database(filename, { readonly: true });
        try {
          if (!isEmptyUpgradeVault(original, destination, source)) {
            throw invalid();
          }
          const row = original
            .query<{ planId: string; targetBuild: string }, []>(
              "SELECT planId,targetBuild FROM effectory_upgrade_empty"
            )
            .get();
          if (
            row?.planId === destination.planId &&
            row.targetBuild === destination.targetBuild
          ) {
            return;
          }
        } finally {
          original.close();
        }
        const staging = path.join(
          repository,
          ".effectory/upgrades/vault-fence.sqlite"
        );
        const db = new Database(staging, { create: true });
        try {
          chmodSync(staging, 0o600);
          db.run(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE"
          );
          db.run(sentinelSchema);
          db.query("INSERT INTO effectory_upgrade_empty VALUES(?,?)").run(
            destination.planId,
            destination.targetBuild
          );
          db.run("PRAGMA user_version=2");
          step?.("vault-owner-written");
          db.run("COMMIT");
          step?.("vault-owner-committed");
        } finally {
          db.close();
        }
        flushUpgradePath(staging);
        renameSync(staging, filename);
        flushUpgradePath(path.dirname(filename));
        flushUpgradePath(path.dirname(staging));
        step?.("vault-owner-installed");
      },
    });
  });
}
