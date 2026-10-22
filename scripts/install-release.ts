import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const [target] = process.argv.slice(2);
if (!target) {
  throw new Error("Usage: bun install.ts /path/to/repo");
}
const workspace = path.resolve(target);
if (!statSync(workspace).isDirectory()) {
  throw new Error("The target workspace must be an existing directory");
}
const project = path.join(workspace, ".effectory");
const marker = path.join(project, "workspace.json");
if (existsSync(marker)) {
  const config = JSON.parse(readFileSync(marker, "utf-8"));
  if (
    config.version !== 1 ||
    (config.project !== undefined && config.project !== ".effectory")
  ) {
    throw new Error("Incompatible Effectory workspace marker");
  }
}
const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dir, "release.json"), "utf-8")
) as {
  version: string;
  packages: { name: string; filename: string; sha256: string }[];
};
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(manifest.version)) {
  throw new Error("Invalid release version");
}
const packageNames = ["sdk", "activities", "runtime", "cli"].map(
  (name) => `@effectory/${name}`
);
if (
  manifest.packages.length !== packageNames.length ||
  new Set(manifest.packages.map((pkg) => pkg.name)).size !== packageNames.length
) {
  throw new Error(
    "Release must include exactly the SDK, activities, runtime, and CLI"
  );
}
// Verify all release assets before writing to the target repository.
for (const pkg of manifest.packages) {
  if (
    !packageNames.includes(pkg.name) ||
    pkg.filename !==
      `effectory-${pkg.name.split("/")[1]}-${manifest.version}.tgz`
  ) {
    throw new Error("Unexpected release package");
  }
  const source = path.join(import.meta.dir, pkg.filename);
  const digest = createHash("sha256")
    .update(readFileSync(source))
    .digest("hex");
  if (digest !== pkg.sha256) {
    throw new Error(`Checksum mismatch: ${pkg.filename}`);
  }
}
const filename = path.join(project, "package.json");
const metadata = existsSync(filename)
  ? JSON.parse(readFileSync(filename, "utf-8"))
  : { name: "effectory-workspace", private: true, type: "module" };
mkdirSync(path.join(project, "vendor"), { recursive: true });
for (const pkg of manifest.packages) {
  copyFileSync(
    path.join(import.meta.dir, pkg.filename),
    path.join(project, "vendor", pkg.filename)
  );
}
const packages = Object.fromEntries(
  manifest.packages.map((pkg) => [pkg.name, `./vendor/${pkg.filename}`])
);
writeFileSync(
  filename,
  `${JSON.stringify(
    {
      ...metadata,
      dependencies: { ...metadata.dependencies, ...packages, effect: "4.0.5" },
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
if (install.exitCode !== 0) {
  process.exit(install.exitCode);
}
const initialize = Bun.spawnSync(
  [
    process.execPath,
    path.join(project, "node_modules/.bin/effectory"),
    "init",
    "--workspace",
    workspace,
  ],
  { cwd: workspace, stderr: "inherit", stdout: "inherit" }
);
process.exitCode = initialize.exitCode;
if (initialize.exitCode === 0) {
  console.log(
    `Installed Effectory ${manifest.version}. Run .effectory/node_modules/.bin/effectory workflow list from ${workspace}`
  );
}
