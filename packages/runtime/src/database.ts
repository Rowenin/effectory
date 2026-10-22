import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { claimWorkspace } from "./host.ts";
import { workspacePaths } from "./paths.ts";

/** Publish a complete SQLite snapshot, including WAL contents, before removing the old file. */
export const prepareDatabase = (workspace: string) => {
  const paths = workspacePaths(workspace);
  mkdirSync(paths.databaseDirectory, { mode: 0o700, recursive: true });
  if (!existsSync(paths.legacyDatabase)) {
    return paths.database;
  }
  if (existsSync(paths.database)) {
    throw new Error(
      "Both workspace and user databases exist. Stop the runners and resolve the workspace database before restarting."
    );
  }
  const db = new Database(paths.legacyDatabase);
  const temporary = `${paths.database}.${randomUUID()}.tmp`;
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.transaction(() => {
      const release = claimWorkspace({
        db,
        transaction: (body) => db.transaction(body).immediate(),
      });
      release();
      writeFileSync(temporary, db.serialize(), {
        flag: "wx",
        flush: true,
        mode: 0o600,
      });
      // A concurrent migration cannot overwrite a published database.
      linkSync(temporary, paths.database);
    }).immediate();
  } finally {
    db.close();
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
  }
  unlinkSync(paths.legacyDatabase);
  for (const suffix of ["-wal", "-shm"]) {
    const filename = `${paths.legacyDatabase}${suffix}`;
    if (existsSync(filename)) {
      unlinkSync(filename);
    }
  }
  return paths.database;
};
