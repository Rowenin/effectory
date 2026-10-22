import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { packPackages, packageVersion } from "./pack.ts";

const [target] = process.argv.slice(2);
if (!target) {
  throw new Error("Usage: bun run dogfood /path/to/repo");
}
const workspace = path.resolve(target);
const project = path.join(workspace, ".effectory");
const initialize = Bun.spawnSync(
  [
    process.execPath,
    path.resolve(import.meta.dir, "../packages/cli/src/main.ts"),
    "init",
    "--workspace",
    workspace,
  ],
  { stderr: "inherit", stdout: "inherit" }
);
if (initialize.exitCode !== 0) {
  process.exit(initialize.exitCode);
}
packPackages(path.join(project, "vendor"));
const filename = path.join(project, "package.json");
const metadata = JSON.parse(readFileSync(filename, "utf-8"));
const version = packageVersion();
const packages = Object.fromEntries(
  ["sdk", "activities", "runtime", "cli"].map((name) => [
    `@effectory/${name}`,
    `./vendor/effectory-${name}-${version}.tgz`,
  ])
);
writeFileSync(
  filename,
  `${JSON.stringify(
    {
      ...metadata,
      dependencies: { ...metadata.dependencies, ...packages },
      overrides: { ...metadata.overrides, ...packages },
    },
    null,
    2
  )}\n`
);
const install = Bun.spawnSync([process.execPath, "install", "--force"], {
  cwd: project,
  stderr: "inherit",
  stdout: "inherit",
});
process.exitCode = install.exitCode;
