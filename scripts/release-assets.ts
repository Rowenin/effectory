/**
 * Builds every file a GitHub Release carries, in one directory:
 *
 *   effectory-<platform>               standalone binaries (all release targets)
 *   offtree-effectory-sdk-<v>.tgz      the authoring SDK, installed by URL
 *   effectory-aws-vault.tgz            the AWS vault extension
 *   install.sh                         the installer
 *   SHA256SUMS                         checksums of all of the above
 *
 *   bun scripts/release-assets.ts                     # dist/release
 *   gh release create v0.1.0 dist/release/* --title "Effectory v0.1.0"
 *
 * CI and a local machine produce the same set. The SDK is not on npm; projects
 * install it from the release, as `effectory init` and `upgrade` pin it.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { Schema } from "effect";

const root = path.resolve(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    outdir: { default: "dist/release", type: "string" },
    target: { default: ["all"], multiple: true, type: "string" },
  },
});
const outdir = path.resolve(root, values.outdir);

function run(command: readonly string[]) {
  const result = Bun.spawnSync([...command], {
    cwd: root,
    stderr: "inherit",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    process.stderr.write(`${command.join(" ")} exited ${result.exitCode}\n`);
    process.exit(1);
  }
  return result.stdout.toString();
}

const bun = process.execPath;
run([
  bun,
  "scripts/build-binary.ts",
  ...values.target.flatMap((target) => ["--target", target]),
  "--outdir",
  outdir,
]);

const sdkDirectory = path.join(root, "dist", "sdk");
run([bun, "scripts/build-sdk.ts", "--outdir", sdkDirectory]);
const { version } = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String }))
)(readFileSync(path.join(sdkDirectory, "package.json"), "utf-8"));
const sdkArchive = `offtree-effectory-sdk-${version}.tgz`;
const packed = Bun.spawnSync(
  [bun, "pm", "pack", "--destination", outdir, "--quiet"],
  { cwd: sdkDirectory, stderr: "inherit", stdout: "pipe" }
);
if (packed.exitCode !== 0 || !readdirSync(outdir).includes(sdkArchive)) {
  process.stderr.write(`SDK packing did not produce ${sdkArchive}\n`);
  process.exit(1);
}

const extensionDirectory = path.join(root, "dist", "extensions", "aws-vault");
run([
  bun,
  "scripts/build-aws-vault-extension.ts",
  "--outdir",
  extensionDirectory,
]);
copyFileSync(
  path.join(extensionDirectory, "effectory-aws-vault.tgz"),
  path.join(outdir, "effectory-aws-vault.tgz")
);
copyFileSync(path.join(root, "install.sh"), path.join(outdir, "install.sh"));

const assets = readdirSync(outdir)
  .filter((name) => name !== "SHA256SUMS")
  .toSorted();
writeFileSync(
  path.join(outdir, "SHA256SUMS"),
  `${assets
    .map(
      (name) =>
        `${createHash("sha256")
          .update(readFileSync(path.join(outdir, name)))
          .digest("hex")}  ${name}`
    )
    .join("\n")}\n`
);
process.stdout.write(
  `${JSON.stringify({ assets: [...assets, "SHA256SUMS"], outdir, version })}\n`
);
