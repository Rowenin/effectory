import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Databases live in the user directory, isolated by canonical workspace path. */
export const workspacePaths = (workspace: string) => {
  const effectory = path.join(workspace, ".effectory");
  const state = path.join(effectory, "state");
  const identity = createHash("sha256")
    .update(
      existsSync(workspace) ? realpathSync(workspace) : path.resolve(workspace)
    )
    .digest("hex");
  const databaseDirectory = path.join(
    homedir(),
    ".effectory",
    "workspaces",
    identity
  );
  return {
    database: path.join(databaseDirectory, "runtime.sqlite"),
    databaseDirectory,
    legacyDatabase: path.join(state, "runtime.sqlite"),
    marker: path.join(effectory, "workspace.json"),
    socket: path.join(state, "control.sock"),
    state,
  };
};
