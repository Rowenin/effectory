import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { ownershipLayer } from "../src/ownership.ts";
import { withUpgradeInspection } from "../src/upgrade-storage.ts";
import { inspectUpgradeVaultIdentity } from "../src/upgrade-vault-identity.ts";
import { VaultStore } from "../src/vault-store.ts";

test("vault logical identity ignores only the format fence and catches intervening old-format reset", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "effectory-vault-identity-"));
  const prior = process.env.EFFECTORY_KEY_DIR;
  process.env.EFFECTORY_KEY_DIR = path.join(root, "keys");
  const repository = path.join(root, "repo");
  mkdirSync(path.join(repository, ".effectory"), { recursive: true });
  const filename = path.join(repository, ".effectory", "vaults.sqlite");
  const store = new VaultStore(repository, {
    assertActive() {},
    token: "test",
  });
  const read = () =>
    Effect.runPromise(
      withUpgradeInspection(filename, ({ database }) =>
        inspectUpgradeVaultIdentity(database)
      ).pipe(
        Effect.provide(
          ownershipLayer(
            path.join(repository, ".effectory", "state.sqlite.owner")
          )
        )
      )
    );
  try {
    store.init("credentials");
    store.mutate({
      expectedVersion: "0",
      key: "token",
      operation: "Put",
      requestKey: "request",
      value: "CANARY-upgrade-identity",
      vault: "credentials",
    });
    store.close();
    const initial = await read();
    const db = new Database(filename);
    try {
      db.exec("PRAGMA user_version=2; PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    expect(await read()).toEqual(initial);
    const reset = new Database(filename);
    try {
      reset.exec(
        "PRAGMA user_version=1; DELETE FROM vault_values; DELETE FROM vault_receipts; UPDATE vault_meta SET counter=counter+1,absence=counter+1; PRAGMA wal_checkpoint(TRUNCATE)"
      );
    } finally {
      reset.close();
    }
    const changed = await read();
    expect(changed.digest).not.toBe(initial.digest);
  } finally {
    store.close();
    if (prior === undefined) {
      delete process.env.EFFECTORY_KEY_DIR;
    } else {
      process.env.EFFECTORY_KEY_DIR = prior;
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("vault identity distinguishes NUL text, exact large integers, blobs, and unknown columns", async () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE vault_meta(singleton INTEGER PRIMARY KEY,counter INTEGER,absence INTEGER);
    CREATE TABLE vault_identities(id TEXT PRIMARY KEY,key_id TEXT,state TEXT,check_mac TEXT);
    CREATE TABLE vault_values(vault TEXT,key TEXT,version INTEGER,value BLOB,PRIMARY KEY(vault,key));
    CREATE TABLE vault_receipts(serial INTEGER PRIMARY KEY AUTOINCREMENT,vault TEXT,key TEXT,request_key TEXT,mac TEXT,version INTEGER,operation TEXT,UNIQUE(vault,key,request_key));
    INSERT INTO vault_meta VALUES(1,9007199254740992,0);
    INSERT INTO vault_values VALUES('vault','key',1,x'610062');`);
  const read = () => Effect.runPromise(inspectUpgradeVaultIdentity(db));
  try {
    const first = await read();
    db.exec("UPDATE vault_meta SET counter=9007199254740993");
    const second = await read();
    expect(second.digest).not.toBe(first.digest);
    db.exec("UPDATE vault_values SET value=CAST(x'610062' AS TEXT)");
    const third = await read();
    expect(third.digest).not.toBe(second.digest);
    db.exec("UPDATE vault_values SET value=CAST(x'610063' AS TEXT)");
    const fourth = await read();
    expect(fourth.digest).not.toBe(third.digest);
    db.exec("ALTER TABLE vault_values ADD COLUMN unsupported TEXT");
    await expect(read()).rejects.toMatchObject({ code: "RevisionUnavailable" });
  } finally {
    db.close();
  }
});
