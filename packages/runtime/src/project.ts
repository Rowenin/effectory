import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { TaskCatalogError } from "./task.ts";

/** The host's package and compiler configuration are not Effectory configuration. */
export const effectoryProject = (root: string) =>
  existsSync(path.join(root, ".effectory/package.json"))
    ? path.join(root, ".effectory")
    : root;

/** Root registration imports use the same isolated dependency tree as automations. */
export const resolveSourceDependency = (
  root: string,
  project: string,
  specifier: string,
  file: string
) => {
  const resolved = realpathSync(
    Bun.resolveSync(
      specifier,
      project !== root && path.dirname(file) === root
        ? project
        : path.dirname(file)
    )
  );
  if (project !== root) {
    const relative = path.relative(
      path.join(project, "node_modules"),
      resolved
    );
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new TaskCatalogError(
        `${path.relative(root, file)}: ${specifier} must be installed in .effectory/node_modules`
      );
    }
  }
  return resolved;
};
