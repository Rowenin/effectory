/* oxlint-disable no-await-in-loop -- Bounded source and declaration walks keep file handles and build ordering controlled. */
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { ResolvedGitSource } from "@effectory/runtime/extension-protocol";
import {
  ExtensionId,
  ExtensionManifest,
  ExportName,
  ArchivePath,
  extensionLimits,
} from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { canonical, encode } from "@offtree/effectory-sdk/internal/boundary";
import { Effect, Schema } from "effect";

import {
  archivePath,
  digest,
  packArchive,
  verifyArchive,
} from "./extension-archive.ts";
import type { SourceCommand } from "./extension-source-command.ts";

export const SourceManifest = Schema.Struct({
  capabilities: ExtensionManifest.fields.capabilities,
  contracts: Schema.Struct({ export: ExportName, file: ArchivePath }),
  contributions: ExtensionManifest.fields.contributions,
  dependencies: ExtensionManifest.fields.dependencies,
  entrypoint: Schema.Struct({ export: ExportName, file: ArchivePath }),
  format: Schema.Literal(1),
  id: ExtensionId,
});
const Package = Schema.Struct({
  name: Schema.NonEmptyString,
  packageManager: Schema.optionalKey(Schema.String),
  peerDependencies: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String)
  ),
  version: Schema.NonEmptyString,
});
const failure = () =>
  new OperationError({
    code: "InvalidInput",
    message:
      "Source extension build failed; check source metadata, locked dependencies, entry points and host peer versions",
  });

async function json(filename: string): Promise<unknown> {
  return JSON.parse(await readFile(filename, "utf-8"));
}
function relative(root: string, filename: string) {
  const name = path.relative(root, filename).split(path.sep).join("/");
  if (name.startsWith("../") || name === ".." || path.isAbsolute(name)) {
    throw failure();
  }
  return name;
}
async function regular(root: string, filename: string) {
  const stat = await lstat(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > extensionLimits.expandedBytes ||
    relative(root, await realpath(filename)) !== relative(root, filename)
  ) {
    throw failure();
  }
  return filename;
}
async function tree(root: string, directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === ".git" || item.name === "node_modules") {
      continue;
    }
    const filename = path.join(directory, item.name);
    if (item.isSymbolicLink()) {
      throw failure();
    }
    if (item.isDirectory()) {
      files.push(...(await tree(root, filename)));
    } else {
      files.push(await regular(root, filename));
    }
    if (files.length > 10_000) {
      throw failure();
    }
  }
  return files;
}
function declarationsPath(filename: string) {
  return filename.replace(/\.(?:mts|cts|tsx|ts)$/u, ".d.mts");
}

async function prepareSource(
  root: string,
  source: typeof ResolvedGitSource.Type
) {
  const files = await tree(root, root);
  let size = 0;
  for (const file of files) {
    const stat = await lstat(file);
    size += stat.size;
  }
  if (size > 134_217_728) {
    throw failure();
  }
  const directory = path.join(root, source.path);
  if (relative(root, await realpath(directory)) !== relative(root, directory)) {
    throw failure();
  }
  const metadata = Schema.decodeUnknownSync(SourceManifest)(
    await json(
      await regular(
        root,
        path.join(directory, "effectory.extension.source.json")
      )
    ),
    { onExcessProperty: "error" }
  );
  const pkg = Schema.decodeUnknownSync(Package)(
    await json(await regular(root, path.join(directory, "package.json")))
  );
  let install = directory;
  while (!existsSync(path.join(install, "bun.lock"))) {
    if (install === root) {
      throw failure();
    }
    install = path.dirname(install);
  }
  const rootPackage = Schema.decodeUnknownSync(Package)(
    await json(path.join(install, "package.json"))
  );
  if (
    rootPackage.packageManager !== `bun@${source.toolchain.bun}` ||
    pkg.peerDependencies?.effect !== source.toolchain.effect ||
    pkg.peerDependencies["@offtree/effectory-sdk"] !== source.toolchain.sdk
  ) {
    throw failure();
  }
  const lockfile = await regular(root, path.join(install, "bun.lock"));
  const lockBytes = await readFile(lockfile);
  const entries = {
    contracts: await regular(
      root,
      path.join(directory, archivePath(metadata.contracts.file))
    ),
    extension: await regular(
      root,
      path.join(directory, archivePath(metadata.entrypoint.file))
    ),
  };
  const staging = path.join(root, ".effectory-source-build");
  if (existsSync(staging)) {
    throw failure();
  }
  await mkdir(staging);
  return {
    directory,
    entries,
    install,
    lockBytes,
    lockfile,
    metadata,
    pkg,
    staging,
  };
}
type Prepared = Awaited<ReturnType<typeof prepareSource>>;
async function prepareCompiler(root: string, prepared: Prepared) {
  if (
    digest(await readFile(prepared.lockfile)) !== digest(prepared.lockBytes)
  ) {
    throw failure();
  }
  const compiler = await realpath(
    path.join(
      path.dirname(
        Bun.resolveSync("typescript/package.json", prepared.install)
      ),
      "bin/tsc"
    )
  );
  await regular(root, compiler);
  const compilerPackage = Schema.decodeUnknownSync(Package)(
    await json(path.resolve(path.dirname(compiler), "../package.json"))
  );
  const types = path.join(prepared.staging, "types");
  const config = path.join(prepared.staging, "tsconfig.json");
  const availableTypes = ["bun", "node"].filter((name) =>
    existsSync(path.join(prepared.install, "node_modules", "@types", name))
  );
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        declaration: true,
        emitDeclarationOnly: true,
        exactOptionalPropertyTypes: true,
        lib: ["ES2024", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "Bundler",
        outDir: types,
        rootDir: root,
        skipLibCheck: true,
        strict: true,
        target: "ES2024",
        typeRoots: [path.join(prepared.install, "node_modules", "@types")],
        types: availableTypes,
      },
      files: Object.values(prepared.entries),
    })
  );
  return { compiler, compilerVersion: compilerPackage.version, config, types };
}
type Compiler = Awaited<ReturnType<typeof prepareCompiler>>;
async function inventoryFiles(
  inputs: Readonly<Record<string, unknown>>,
  files: Map<string, Uint8Array>
) {
  const inventory = new Map<string, { name: string; version: string }>();
  const names = Object.keys(inputs).toSorted();
  for (const input of names) {
    let directory = path.dirname(path.resolve(input));
    if (!input.includes("node_modules")) {
      continue;
    }
    while (!existsSync(path.join(directory, "package.json"))) {
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw failure();
      }
      directory = parent;
    }
    const pkg = Schema.decodeUnknownSync(Package)(
      await json(path.join(directory, "package.json"))
    );
    if (pkg.name === "effect" || pkg.name === "@offtree/effectory-sdk") {
      throw failure();
    }
    const identity = `${pkg.name}@${pkg.version}`;
    if (inventory.has(identity)) {
      continue;
    }
    inventory.set(identity, { name: pkg.name, version: pkg.version });
    for (const license of ["LICENSE", "LICENSE.txt", "LICENSE.md"]) {
      const filename = path.join(directory, license);
      if (existsSync(filename)) {
        files.set(`licenses/${inventory.size}.txt`, await readFile(filename));
        break;
      }
    }
  }
  return inventory;
}
/** Bun chunk names include checkout paths; name chunks from their normalized contents. */
async function bundledFiles(outputs: readonly Bun.BuildArtifact[]) {
  const bytes = new Map<string, Uint8Array>();
  for (const output of outputs) {
    bytes.set(
      archivePath(output.path.replace(/^\.\//u, "")),
      new Uint8Array(await output.arrayBuffer())
    );
  }
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const [name, data] of bytes) {
    if (!/^chunk-[a-z0-9]+\.mjs$/u.test(name)) {
      continue;
    }
    const normalized = new TextDecoder()
      .decode(data)
      .replaceAll(/\.\/chunk-[a-z0-9]+\.mjs/gu, "./chunk.mjs");
    const target = `chunk-${digest(normalized)}.mjs`;
    if (used.has(target)) {
      throw failure();
    }
    used.add(target);
    names.set(name, target);
  }
  const files = new Map<string, Uint8Array>();
  for (const [name, data] of bytes) {
    let content = data;
    if (name.endsWith(".mjs")) {
      let text = new TextDecoder().decode(data);
      for (const [original, target] of names) {
        text = text
          .replaceAll(`"./${original}"`, `"./${target}"`)
          .replaceAll(`'./${original}'`, `'./${target}'`);
      }
      content = new TextEncoder().encode(text);
    }
    files.set(names.get(name) ?? name, content);
  }
  return files;
}
async function bundleSource(
  root: string,
  source: typeof ResolvedGitSource.Type,
  prepared: Prepared,
  built: Compiler
) {
  const wrappers: string[] = [];
  for (const [name, entry] of Object.entries(prepared.entries)) {
    const filename = path.join(prepared.staging, `${name}.ts`);
    const target = `../${relative(root, entry)}`;
    const exportName =
      name === "contracts"
        ? prepared.metadata.contracts.export
        : prepared.metadata.entrypoint.export;
    await writeFile(
      filename,
      `export * from ${JSON.stringify(target)};\n${exportName === "default" ? `export { default } from ${JSON.stringify(target)};\n` : ""}`
    );
    wrappers.push(filename);
  }
  const result = await Bun.build({
    entrypoints: wrappers,
    env: "disable",
    external: [
      "effect",
      "effect/*",
      "@offtree/effectory-sdk",
      "@offtree/effectory-sdk/*",
      ...Object.keys(prepared.metadata.dependencies),
    ],
    format: "esm",
    metafile: true,
    minify: true,
    naming: {
      asset: "[name]-[hash].[ext]",
      chunk: "chunk-[hash].mjs",
      entry: "[name].mjs",
    },
    root,
    splitting: true,
    target: "bun",
  });
  if (!result.success || result.metafile === undefined) {
    throw failure();
  }
  const files = await bundledFiles(result.outputs);
  for (const file of await tree(built.types, built.types)) {
    const name = relative(built.types, file).replace(
      /\.d\.(?:ts|mts|cts)$/u,
      ".d.mts"
    );
    const contents = await readFile(file, "utf-8");
    const declaration = contents.replaceAll(
      /(?<quote>["'])(?<module>\.[^"'\n]+)\.(?:ts|mts|cts|js|mjs)\k<quote>/gu,
      '"$<module>.mjs"'
    );
    files.set(
      archivePath(`types/${name}`),
      new TextEncoder().encode(declaration)
    );
  }
  for (const [name, entry] of Object.entries(prepared.entries)) {
    const exportName =
      name === "contracts"
        ? prepared.metadata.contracts.export
        : prepared.metadata.entrypoint.export;
    const target = declarationsPath(relative(root, entry));
    files.set(
      `${name}.d.mts`,
      new TextEncoder().encode(
        `export * from "./types/${target.replace(/\.d\.mts$/u, ".mjs")}";\n${exportName === "default" ? `export { default } from "./types/${target.replace(/\.d\.mts$/u, ".mjs")}";\n` : ""}`
      )
    );
  }
  const inventory = await inventoryFiles(result.metafile.inputs, files);
  const manifest: typeof ExtensionManifest.Type = {
    capabilities: prepared.metadata.capabilities,
    contracts: {
      export: prepared.metadata.contracts.export,
      file: "contracts.mjs",
      types: "contracts.d.mts",
    },
    contributions: prepared.metadata.contributions,
    dependencies: prepared.metadata.dependencies,
    dependencyInventory: [...inventory.values()].toSorted((a, b) => {
      if (a.name === b.name) {
        return 0;
      }
      return a.name < b.name ? -1 : 1;
    }),
    // Legacy wire tags stay stable; sourceBuild records and checks the actual host peers.
    effectVersion: "4.0.5",
    entrypoint: {
      export: prepared.metadata.entrypoint.export,
      file: "extension.mjs",
      types: "extension.d.mts",
    },
    files: Object.fromEntries(
      [...files].map(([name, bytes]) => [name, digest(bytes)])
    ),
    id: prepared.metadata.id,
    manifestVersion: 1,
    sdkVersion: "0.0.0",
    sourceBuild: {
      lockfile: relative(root, prepared.lockfile),
      lockfileDigest: digest(prepared.lockBytes),
      toolchain: source.toolchain,
      typescript: built.compilerVersion,
    },
    version: prepared.pkg.version,
  };
  files.set(
    "effectory.extension.json",
    new TextEncoder().encode(
      `${canonical(encode(ExtensionManifest, manifest))}\n`
    )
  );
  const archive = packArchive(files);
  verifyArchive(archive);
  return archive;
}
/** Host-controlled build only: no repository build scripts or package lifecycle scripts. */
export function buildSourceExtension(
  root: string,
  source: typeof ResolvedGitSource.Type,
  command: typeof SourceCommand.Service
) {
  return Effect.gen(function* () {
    const prepared = yield* Effect.tryPromise({
      catch: failure,
      try: async () => await prepareSource(root, source),
    });
    const bun = new TextDecoder()
      .decode(yield* command.run("bun", ["--version"]))
      .trim();
    if (bun !== source.toolchain.bun) {
      return yield* new OperationError({
        code: "Conflict",
        message:
          "Source builds require a Bun executable matching the pinned host Bun version",
      });
    }
    yield* command.run(
      "bun",
      ["install", "--frozen-lockfile", "--ignore-scripts"],
      { cwd: prepared.install, timeoutMillis: 300_000 }
    );
    const built = yield* Effect.tryPromise({
      catch: failure,
      try: async () => await prepareCompiler(root, prepared),
    });
    yield* command.run("bun", [built.compiler, "-p", built.config], {
      cwd: prepared.install,
      timeoutMillis: 120_000,
    });
    return yield* Effect.tryPromise({
      catch: failure,
      try: async () => await bundleSource(root, source, prepared, built),
    });
  });
}
