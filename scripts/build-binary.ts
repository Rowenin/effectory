/**
 * Compiles the Effectory CLI, daemon and runtime into standalone executables.
 *
 *   bun scripts/build-binary.ts                       # this machine's platform
 *   bun scripts/build-binary.ts --target all          # every release target
 *   bun scripts/build-binary.ts --target bun-linux-x64 --outdir dist/bin
 *
 * Each binary embeds Bun, `effect` and `@offtree/effectory-sdk`; projects install the
 * npm SDK only for types. The host ABI is computed from the same sources a
 * source run would hash, so retained revisions stay valid across the two.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { sourceAbi } from "../packages/platform-bun/src/host-runtime.ts";

const releaseTargets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-arm64",
  "bun-linux-x64",
  "bun-linux-arm64-musl",
  "bun-linux-x64-musl",
] as const;

const root = path.resolve(import.meta.dir, "..");
const { values } = parseArgs({
  options: {
    outdir: { default: "dist/bin", type: "string" },
    target: { multiple: true, type: "string" },
  },
});
const requested = values.target ?? [`bun-${process.platform}-${process.arch}`];
const targets = requested.includes("all") ? [...releaseTargets] : requested;
const outdir = path.resolve(root, values.outdir);

for (const script of [
  "scripts/generate-host-modules.ts",
  "scripts/generate-agent-assets.ts",
]) {
  const generated = Bun.spawnSync([process.execPath, script, "--check"], {
    cwd: root,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (generated.exitCode !== 0) {
    process.exit(1);
  }
}

const { version } = JSON.parse(
  readFileSync(path.join(root, "packages/cli/package.json"), "utf-8")
) as { version: string };
const abi = sourceAbi();
mkdirSync(outdir, { recursive: true });

const sums: string[] = [];
const built: { target: string; file: string; bytes: number }[] = [];
for (const target of targets) {
  const name = `effectory-${target.replace(/^bun-/u, "")}`;
  const outfile = path.join(outdir, name);
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "packages/cli/src/main.ts",
      "--compile",
      `--target=${target}`,
      "--define",
      `EFFECTORY_HOST_ABI=${JSON.stringify(abi)}`,
      "--outfile",
      outfile,
    ],
    { cwd: root, stderr: "inherit", stdout: "pipe" }
  );
  if (result.exitCode !== 0) {
    console.error(`Build failed for ${target}`);
    process.exit(1);
  }
  const bytes = readFileSync(outfile);
  sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
  built.push({ bytes: bytes.length, file: outfile, target });
}
writeFileSync(path.join(outdir, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(JSON.stringify({ abi, built, version }, null, 2));
