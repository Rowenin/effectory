import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  digest,
  verifyArchive,
} from "../../packages/platform-bun/src/extension-archive.ts";
import type { ExtensionManifest } from "../../packages/runtime/src/extension-protocol.ts";
import { contracts } from "./src/contracts.ts";

const root = path.resolve(import.meta.dir, "../..");
const source = path.join(import.meta.dir, "src");

async function command(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`AWS vault extension build failed: ${stdout}\n${stderr}`);
  }
}

/** Build a release archive; never publish or modify the core runtime. */
export async function buildAwsVaultExtension(outdir: string) {
  const staging = await mkdtemp(
    path.join(tmpdir(), "effectory-aws-vault-build-")
  );
  try {
    const contents = path.join(staging, "archive");
    const types = path.join(staging, "types");
    await mkdir(contents);
    const config = path.join(staging, "tsconfig.json");
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: types,
          plugins: [],
          rootDir: source,
          typeRoots: [path.join(root, "node_modules/@types")],
        },
        extends: path.join(root, "tsconfig.json"),
        include: [path.join(source, "**/*.ts")],
      })
    );
    await command([path.join(root, "node_modules/.bin/tsc"), "-p", config]);
    const bundle = await Bun.build({
      entrypoints: [
        path.join(source, "contracts.ts"),
        path.join(source, "extension.ts"),
      ],
      external: [
        "effect",
        "effect/*",
        "@offtree/effectory-sdk",
        "@offtree/effectory-sdk/*",
      ],
      format: "esm",
      naming: {
        asset: "[name]-[hash].[ext]",
        chunk: "chunk-[hash].mjs",
        entry: "[name].mjs",
      },
      outdir: contents,
      splitting: true,
      target: "bun",
    });
    if (!bundle.success) {
      throw new Error(
        `AWS vault extension bundle failed: ${bundle.logs.join("\n")}`
      );
    }
    await Promise.all(
      ["contracts", "extension", "options"].map(async (name) => {
        const declaration = await readFile(
          path.join(types, `${name}.d.ts`),
          "utf-8"
        );
        await writeFile(
          path.join(contents, `${name}.d.mts`),
          declaration.replaceAll(
            /"(?<module>\.\/[^"\n]+)\.ts"/gu,
            '"$<module>.mjs"'
          )
        );
      })
    );
    const dependencies = [
      ["@distilled.cloud/aws", "@distilled.cloud/aws/Credentials"],
      ["@distilled.cloud/core", "@distilled.cloud/core/telemetry"],
      ["@distilled.cloud/aws4signer", "@distilled.cloud/aws4signer"],
    ] as const;
    const inventory = await Promise.all(
      dependencies.map(async ([name, entry]) => {
        const directory = path.resolve(
          path.dirname(
            Bun.resolveSync(
              entry,
              name === "@distilled.cloud/aws4signer"
                ? path.dirname(
                    Bun.resolveSync(
                      "@distilled.cloud/aws/Credentials",
                      import.meta.dir
                    )
                  )
                : import.meta.dir
            )
          ),
          ".."
        );
        const metadata = JSON.parse(
          await readFile(path.join(directory, "package.json"), "utf-8")
        ) as { name: string; version: string };
        if (metadata.name !== name) {
          throw new Error(`Unexpected dependency resolution for ${name}`);
        }
        const suffix = name.split("/").at(-1);
        await copyFile(
          path.join(directory, "LICENSE"),
          path.join(contents, `LICENSE-distilled-${suffix}.txt`)
        );
        return { name, version: metadata.version };
      })
    );
    await copyFile(
      path.join(root, "LICENSE"),
      path.join(contents, "LICENSE.txt")
    );
    const entries = await readdir(contents);
    const names = entries.toSorted();
    const files = Object.fromEntries(
      await Promise.all(
        names.map(
          async (name) =>
            [name, digest(await readFile(path.join(contents, name)))] as const
        )
      )
    );
    const manifest: typeof ExtensionManifest.Type = {
      capabilities: ["network", "environment", "filesystem", "process"],
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
      dependencyInventory: inventory,
      effectVersion: "4.0.5",
      entrypoint: {
        export: "default",
        file: "extension.mjs",
        types: "extension.d.mts",
      },
      files,
      id: contracts.id,
      manifestVersion: 1,
      sdkVersion: "0.0.0",
      version: contracts.version,
    };
    await writeFile(
      path.join(contents, "effectory.extension.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    const archive = path.join(staging, "effectory-aws-vault.tgz");
    await command([
      "tar",
      "--format=ustar",
      "-czf",
      archive,
      "-C",
      contents,
      ...names,
      "effectory.extension.json",
    ]);
    const bytes = await readFile(archive);
    const checked = verifyArchive(bytes);
    await mkdir(outdir, { recursive: true });
    const filename = path.join(outdir, "effectory-aws-vault.tgz");
    await writeFile(filename, bytes);
    await writeFile(
      path.join(outdir, "SHA256SUMS"),
      `${checked.archiveDigest}  effectory-aws-vault.tgz\n`
    );
    return {
      archive: filename,
      digest: checked.archiveDigest,
      files: checked.files.size,
      manifest,
    };
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}
