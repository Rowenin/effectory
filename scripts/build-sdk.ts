/**
 * Builds the package for `@offtree/effectory-sdk` from `packages/core`.
 *
 *   bun scripts/build-sdk.ts                  # writes dist/sdk
 *   bun scripts/build-sdk.ts --outdir out/sdk
 *
 * `scripts/release-assets.ts` packs it into the tarball each GitHub Release
 * carries; projects install it from that URL.
 *
 * Projects install the SDK for types and editor support; the Effectory binary
 * supplies its own copy at runtime. The package is still complete JavaScript, so
 * it also runs under plain Bun or Node. `effect` is an exact peer dependency:
 * the project pins the same version the binary embeds.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(import.meta.dir, "..");
const source = path.join(root, "packages", "core");
const repository = "Rowenin/effectory";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { outdir: { default: "dist/sdk", type: "string" } },
});
const outdir = path.resolve(root, values.outdir);

interface SourceManifest {
  readonly dependencies: Record<string, string>;
  readonly exports: Record<string, string>;
  readonly name: string;
  readonly version: string;
}
const manifest = JSON.parse(
  readFileSync(path.join(source, "package.json"), "utf-8")
) as SourceManifest;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

rmSync(outdir, { force: true, recursive: true });
mkdirSync(outdir, { recursive: true });

// Compile with the workspace's compiler settings, emitting JS and declarations.
const configDirectory = mkdtempSync(path.join(tmpdir(), "effectory-sdk-"));
try {
  const config = path.join(configDirectory, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        declaration: true,
        noEmit: false,
        outDir: path.join(outdir, "dist"),
        plugins: [],
        rewriteRelativeImportExtensions: true,
        rootDir: path.join(source, "src"),
        // The SDK uses no Bun or Node globals; keep their types out of it.
        types: [],
      },
      extends: path.join(root, "tsconfig.json"),
      include: [path.join(source, "src", "**", "*.ts")],
    })
  );
  const compiled = Bun.spawnSync(
    [path.join(root, "node_modules", ".bin", "tsc"), "-p", config],
    { cwd: root, stderr: "inherit", stdout: "inherit" }
  );
  if (compiled.exitCode !== 0) {
    fail(`tsc exited ${compiled.exitCode}`);
  }
} finally {
  rmSync(configDirectory, { force: true, recursive: true });
}

// tsc rewrites `.ts` specifiers in JavaScript but keeps them in declarations.
const emitted = readdirSync(path.join(outdir, "dist"));
for (const name of emitted.filter((file) => file.endsWith(".d.ts"))) {
  const filename = path.join(outdir, "dist", name);
  writeFileSync(
    filename,
    readFileSync(filename, "utf-8").replaceAll(
      /(?<prefix>from |import\()"(?<module>\.\/[^"]+)\.ts"/gu,
      '$<prefix>"$<module>.js"'
    )
  );
}

// Published output must not reference TypeScript sources or workspace packages.
for (const name of emitted) {
  const text = readFileSync(path.join(outdir, "dist", name), "utf-8");
  for (const match of text.matchAll(/from "(?<specifier>[^"]+)"/gu)) {
    const specifier = match.groups?.specifier;
    if (
      specifier !== undefined &&
      (specifier.endsWith(".ts") ||
        !(
          specifier.startsWith("./") ||
          specifier === "effect" ||
          specifier.startsWith("effect/")
        ))
    ) {
      fail(`dist/${name} imports ${specifier}`);
    }
  }
}

const exportsMap = Object.fromEntries(
  Object.entries(manifest.exports).map(([key, target]) => {
    if (key === "./package.json") {
      return [key, "./package.json"];
    }
    const base = path.basename(target, ".ts");
    if (!emitted.includes(`${base}.js`) || !emitted.includes(`${base}.d.ts`)) {
      fail(`export ${key} has no compiled output for ${target}`);
    }
    // Conditions match in order, and `types` must come first.
    const conditions = Object.fromEntries([
      ["types", `./dist/${base}.d.ts`],
      ["default", `./dist/${base}.js`],
    ]);
    return [key, conditions];
  })
);

const effectVersion = manifest.dependencies.effect;
if (effectVersion === undefined) {
  fail("packages/core must depend on effect");
}

const published = {
  bugs: { url: `https://github.com/${repository}/issues` },
  description:
    "Authoring SDK for Effectory applications and extensions. The Effectory binary provides the runtime.",
  exports: exportsMap,
  files: ["dist"],
  homepage: `https://github.com/${repository}#readme`,
  keywords: ["effect", "effectory", "workflow", "automation"],
  license: "MIT",
  name: manifest.name,
  peerDependencies: { effect: effectVersion },
  publishConfig: { access: "public" },
  repository: {
    directory: "packages/core",
    type: "git",
    url: `git+https://github.com/${repository}.git`,
  },
  type: "module",
  version: manifest.version,
};
writeFileSync(
  path.join(outdir, "package.json"),
  `${JSON.stringify(published, null, 2)}\n`
);
cpSync(path.join(root, "LICENSE"), path.join(outdir, "LICENSE"));
writeFileSync(
  path.join(outdir, "README.md"),
  `# ${manifest.name}

The authoring SDK for [Effectory](https://github.com/${repository}).

Effectory runs as a single binary that embeds this SDK and \`effect\`. Install
the package in a project for types and editor support. Its version, and the
version of \`effect\`, must match the binary exactly:

\`\`\`sh
effectory init my-project   # writes effectory.ts and pins both packages
cd my-project && bun install
\`\`\`

After upgrading the binary, run \`effectory upgrade\` to update the pins, and
\`effectory doctor sdk\` to check them.

This release needs \`effect@${effectVersion}\`.
`
);

// The built package must load through its own export map.
const smoke = (await import(
  pathToFileURL(path.join(outdir, "dist", "index.js")).href
)) as Record<string, unknown>;
for (const name of ["Application", "Task", "Workflow"]) {
  if (smoke[name] === undefined) {
    fail(`dist/index.js does not export ${name}`);
  }
}

process.stdout.write(
  `${JSON.stringify({ name: manifest.name, outdir, version: manifest.version })}\n`
);
