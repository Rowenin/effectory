import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionManifest } from "@effectory/runtime/extension-protocol";

import { digest } from "../../src/extension-archive.ts";

export const fixtureFiles = {
  "contracts.d.mts": "export declare const contracts: unknown;",
  "contracts.mjs":
    'throw new Error("Manifest inspection must not execute contracts");',
  "extension.d.mts":
    "declare const extension: unknown; export default extension;",
  "extension.mjs":
    'throw new Error("Manifest inspection must not execute handlers");',
};
export const fixtureManifest: typeof ExtensionManifest.Type = {
  capabilities: [],
  contracts: {
    export: "contracts",
    file: "contracts.mjs",
    types: "contracts.d.mts",
  },
  contributions: {
    artifacts: [],
    implementations: [],
    patches: [],
    tasks: [],
    workflows: [],
  },
  dependencies: {},
  dependencyInventory: [],
  effectVersion: "4.0.5",
  entrypoint: {
    export: "default",
    file: "extension.mjs",
    types: "extension.d.mts",
  },
  files: Object.fromEntries(
    Object.entries(fixtureFiles).map(([name, contents]) => [
      name,
      digest(contents),
    ])
  ),
  id: "acme/tools",
  manifestVersion: 1,
  sdkVersion: "0.0.0",
  version: "1.0.0",
};

/** A system tar producer keeps parser tests independent of the parser itself. */
export async function archiveFixture(
  manifest: unknown = fixtureManifest,
  files: Readonly<Record<string, string>> = fixtureFiles
) {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-archive-"));
  const archive = path.join(directory, "bundle.tgz");
  const contents = {
    ...files,
    "effectory.extension.json": JSON.stringify(manifest),
  };
  try {
    await Promise.all(
      Object.entries(contents).map(([name, value]) =>
        writeFile(path.join(directory, name), value)
      )
    );
    const process = Bun.spawn(
      [
        "tar",
        "--format=ustar",
        "-czf",
        archive,
        "-C",
        directory,
        ...Object.keys(contents),
      ],
      { stderr: "pipe", stdout: "ignore" }
    );
    if ((await process.exited) !== 0) {
      throw new Error(await new Response(process.stderr).text());
    }
    return new Uint8Array(await Bun.file(archive).arrayBuffer());
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
