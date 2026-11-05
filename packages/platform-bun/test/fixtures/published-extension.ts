import {
  cp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { ExtensionManifest } from "@effectory/runtime/extension-protocol";

import { digest } from "../../src/extension-archive.ts";
import { archiveFixture, fixtureManifest } from "./extension-archive.ts";

export const workspace = path.resolve(import.meta.dir, "../../../..");
export async function typescript(
  directory: string,
  files: string[],
  declaration = false
) {
  const command = Bun.spawn(
    [
      process.execPath,
      path.join(workspace, "node_modules/typescript/bin/tsc"),
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "--target",
      "es2024",
      "--strict",
      "--skipLibCheck",
      "--types",
      "bun",
      "--allowImportingTsExtensions",
      ...(declaration
        ? ["--declaration", "--emitDeclarationOnly", "--outDir", "dist"]
        : ["--noEmit"]),
      ...files,
    ],
    { cwd: directory, stderr: "pipe", stdout: "pipe" }
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited,
  ]);
  if (exit !== 0) {
    throw new Error(`Type fixture failed:\n${stdout}\n${stderr}`);
  }
}

export async function publishedExtension(
  directory: string,
  options?: { readonly prefix: string; readonly version: string }
) {
  const config = options ?? { prefix: "", version: "1.0.0" };
  await mkdir(directory, { recursive: true });
  await cp(path.join(import.meta.dir, "published-extension"), directory, {
    recursive: true,
  });
  await Promise.all(
    ["contracts.mts", "extension.mts"].map(async (filename) => {
      const source = await readFile(path.join(directory, filename), "utf-8");
      await writeFile(
        path.join(directory, filename),
        source.replaceAll('"1.0.0"', JSON.stringify(config.version)).replace(
          // oxlint-disable-next-line no-template-curly-in-string -- Match literal publisher source.
          "`${client.prefix}/${repository}`",
          `\`${config.prefix}\${client.prefix}/\${repository}\``
        )
      );
    })
  );
  await symlink(
    path.join(workspace, "node_modules"),
    path.join(directory, "node_modules"),
    "dir"
  );
  await typescript(directory, ["contracts.mts", "extension.mts"], true);
  const output = await Bun.build({
    entrypoints: [
      path.join(directory, "contracts.mts"),
      path.join(directory, "extension.mts"),
    ],
    external: ["effect", "effect/*", "@effectory/core", "@effectory/core/*"],
    format: "esm",
    naming: {
      asset: "[name]-[hash].[ext]",
      chunk: "chunk-[hash].mjs",
      entry: "[name].mjs",
    },
    outdir: path.join(directory, "dist"),
    splitting: true,
    target: "bun",
  });
  if (!output.success) {
    throw new Error(`Fixture bundle failed: ${output.logs.join("\n")}`);
  }
  const filenames = await readdir(path.join(directory, "dist"));
  const files = Object.fromEntries(
    await Promise.all(
      filenames.map(
        async (name) =>
          [
            name,
            await readFile(path.join(directory, "dist", name), "utf-8"),
          ] as const
      )
    )
  );
  const manifest: typeof ExtensionManifest.Type = {
    ...fixtureManifest,
    contributions: {
      artifacts: [{ id: "fixture/tools/report", name: "Report", version: 1 }],
      implementations: [],
      patches: [],
      tasks: [{ id: "fixture/tools/inspect", name: "Inspect", version: 1 }],
      workflows: [],
    },
    files: Object.fromEntries(
      Object.entries(files).map(([name, contents]) => [name, digest(contents)])
    ),
    id: "fixture/tools",
    version: config.version,
  };
  const archive = await archiveFixture(manifest, files);
  await writeFile(path.join(directory, "bundle.tgz"), archive);
  return { archive, manifest };
}
