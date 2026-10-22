import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { prepareDatabase } from "@effectory/runtime/database";
import { claimWorkspace } from "@effectory/runtime/host";
import { workspacePaths } from "@effectory/runtime/paths";
import { RuntimeStore } from "@effectory/runtime/store";

test("user databases isolate workspaces and use the same path through symlinks", () => {
  const root = mkdtempSync(path.join(tmpdir(), "effectory-paths-"));
  try {
    const other = path.join(root, "other");
    mkdirSync(other);
    const alias = path.join(root, "alias");
    symlinkSync(other, alias);
    const paths = workspacePaths(root);
    expect(
      paths.database.startsWith(
        path.join(homedir(), ".effectory", "workspaces") + path.sep
      )
    ).toBe(true);
    expect(paths.database).not.toBe(workspacePaths(other).database);
    expect(workspacePaths(alias).database).toBe(workspacePaths(other).database);
    expect(paths.socket).toBe(path.join(root, ".effectory/state/control.sock"));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("migration preserves WAL records and refuses a live legacy owner", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "effectory-migrate-"));
  const paths = workspacePaths(workspace);
  mkdirSync(paths.state, { recursive: true });
  const legacy = new Database(paths.legacyDatabase, { create: true });
  let store: RuntimeStore | undefined;
  try {
    legacy.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE effectory_owner (id INTEGER PRIMARY KEY, pid INTEGER, nonce TEXT, identity TEXT);
      CREATE TABLE proof (value TEXT);
      INSERT INTO proof VALUES ('preserved');`);
    const release = claimWorkspace({
      db: legacy,
      transaction: (body) => legacy.transaction(body).immediate(),
    });
    expect(() => prepareDatabase(workspace)).toThrow("already owned");
    expect(existsSync(paths.database)).toBe(false);
    release();
    store = new RuntimeStore(workspace);
    expect(store.db.query("SELECT value FROM proof").get()).toEqual({
      value: "preserved",
    });
    expect(existsSync(paths.legacyDatabase)).toBe(false);
    expect(store.filename).toBe(paths.database);
    expect(() => prepareDatabase(workspace)).not.toThrow();
  } finally {
    store?.close();
    legacy.close();
    rmSync(paths.databaseDirectory, { force: true, recursive: true });
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("migration refuses to overwrite a user database", () => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), "effectory-migrate-conflict-")
  );
  const paths = workspacePaths(workspace);
  const store = new RuntimeStore(workspace);
  try {
    const legacy = new Database(paths.legacyDatabase, { create: true });
    legacy.close();
    expect(() => prepareDatabase(workspace)).toThrow(
      "Both workspace and user databases exist"
    );
    expect(existsSync(paths.legacyDatabase)).toBe(true);
  } finally {
    store.close();
    rmSync(paths.databaseDirectory, { force: true, recursive: true });
    rmSync(workspace, { force: true, recursive: true });
  }
});
