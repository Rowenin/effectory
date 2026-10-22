import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { TaskCatalogError } from "./task.ts";

/** Select a single root entry point before evaluating any user code. */
export const workspaceEntrypoint = (workspace: string) => {
  const root = realpathSync(workspace);
  const run = path.join(root, "effectory.run.ts");
  const config = path.join(root, "effectory.config.ts");
  // Refuse pre-rename entry points instead of silently ignoring their contents.
  for (const [legacy, current] of [
    ["factory.run.ts", "effectory.run.ts"],
    ["factory.config.ts", "effectory.config.ts"],
  ] as const) {
    if (existsSync(path.join(root, legacy))) {
      throw new TaskCatalogError(
        `Rename ${legacy} to ${current}; the runner no longer loads ${legacy}`
      );
    }
  }
  if (existsSync(run) && existsSync(config)) {
    throw new TaskCatalogError(
      "Use effectory.run.ts or effectory.config.ts, not both; move services into effectory.run.ts"
    );
  }
  if (existsSync(run)) {
    return run;
  }
  return existsSync(config) ? config : undefined;
};
