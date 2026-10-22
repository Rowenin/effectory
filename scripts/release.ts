import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { packPackages, packageVersion } from "./pack.ts";

const root = path.resolve(import.meta.dir, "..");
const destination = path.join(root, "dist");
const version = packageVersion();
const [tag] = process.argv.slice(2);
if (tag !== undefined && tag !== `v${version}`) {
  throw new Error(`Tag ${tag} must match package version v${version}`);
}
const temporary = mkdtempSync(path.join(tmpdir(), "effectory-release-"));
try {
  const name = `effectory-v${version}`;
  const bundle = path.join(temporary, name);
  mkdirSync(bundle);
  mkdirSync(destination, { recursive: true });
  packPackages(destination);
  const packages = ["sdk", "activities", "runtime", "cli"].map((pkg) => {
    const filename = `effectory-${pkg}-${version}.tgz`;
    const source = path.join(destination, filename);
    const sha256 = createHash("sha256")
      .update(readFileSync(source))
      .digest("hex");
    copyFileSync(source, path.join(bundle, filename));
    return { filename, name: `@effectory/${pkg}`, sha256 };
  });
  writeFileSync(
    path.join(bundle, "release.json"),
    `${JSON.stringify({ packages, version }, null, 2)}\n`
  );
  copyFileSync(
    path.join(root, "scripts/install-release.ts"),
    path.join(bundle, "install.ts")
  );
  const shellInstaller = readFileSync(
    path.join(root, "scripts/install.sh"),
    "utf-8"
  ).replaceAll("@EFFECTORY_RELEASE_TAG@", `v${version}`);
  writeFileSync(path.join(destination, "install.sh"), shellInstaller, {
    mode: 0o755,
  });
  copyFileSync(
    path.join(destination, "install.sh"),
    path.join(bundle, "install.sh")
  );
  const archive = `${name}.tar.gz`;
  const result = Bun.spawnSync(
    ["tar", "-czf", path.join(destination, archive), "-C", temporary, name],
    {
      stderr: "inherit",
      stdout: "inherit",
    }
  );
  if (result.exitCode !== 0) {
    throw new Error("Could not create release archive");
  }
  const checksums = [
    ...packages.map((pkg) => `${pkg.sha256}  ${pkg.filename}`),
    `${createHash("sha256").update(shellInstaller).digest("hex")}  install.sh`,
    `${createHash("sha256")
      .update(readFileSync(path.join(destination, archive)))
      .digest("hex")}  ${archive}`,
  ];
  writeFileSync(
    path.join(destination, "SHA256SUMS"),
    `${checksums.join("\n")}\n`
  );
  const repository = process.env.GITHUB_REPOSITORY ?? "cypress-io/effectory";
  const notes = [
    `Effectory ${version}: local, durable workflows written with Effect.`,
    "",
    "Install the CLI with an authenticated GitHub CLI (Bun 1.4.3+ and Node 24.11.1+ required):",
    "",
    "```sh",
    `gh release download v${version} --repo ${repository} --pattern install.sh`,
    "sh install.sh",
    "effectory --help",
    "```",
    "",
    "Add --workspace /absolute/path/to/repo to sh install.sh to prepare a repository's SDK and dependencies too. The CLI defaults to ~/.local/bin/effectory; --bin-dir and --install-dir customize its location. No shell profiles are modified. The installer verifies the release archive and package checksums.",
    "",
    `The ${archive} bundle also supports workspace-only installation: extract it, then run bun ${name}/install.ts /absolute/path/to/repo. This vendors the packages under .effectory without changing the host package manifest.`,
    "",
    "Dependency installation needs the npm registry or a populated Bun cache. No Effectory packages are published to npm. Stop the runner and finish pending runs before upgrading.",
  ];
  writeFileSync(
    path.join(destination, "RELEASE_NOTES.md"),
    `${notes.join("\n")}\n`
  );
  console.log(`Release bundle: ${path.join(destination, archive)}`);
} finally {
  rmSync(temporary, { force: true, recursive: true });
}
