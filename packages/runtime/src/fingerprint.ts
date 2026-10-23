import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";

import { workspaceEntrypoint } from "./entrypoint.ts";
import { effectoryProject, resolveSourceDependency } from "./project.ts";
import { TaskCatalogError } from "./task.ts";
import type { TaskFingerprint } from "./task.ts";

const transpiler = new Bun.Transpiler({ loader: "ts" });
const sdkModules = new Set([
  "services",
  "effectory",
  "artifact-store",
  "manifest",
  "task",
  "records",
  "errors",
  "activity",
  "automation",
  "authoring",
  "index",
]);
const authoringPackages = [
  { label: "SDK", modules: sdkModules, name: "@effectory/sdk" },
  {
    label: "activities",
    modules: new Set(["index", "process"]),
    name: "@effectory/activities",
  },
  { label: "T3", modules: new Set(["index"]), name: "@effectory/t3" },
];
const supportedPackages = ["effect", "@effect/platform-bun"];
const parsedSources = new Map<string, readonly string[]>();

// TypeScript 7's sync native API is incompatible with Bun's pipe descriptors.
// Parse in an isolated Bun process using its async API, preserving this sync catalog API.
// The virtual filesystem contains only source text. Task modules are never evaluated.
const parserProgram = `
const { API } = await import(${JSON.stringify(import.meta.resolve("typescript/unstable/async"))});
const { SyntaxKind } = await import(${JSON.stringify(import.meta.resolve("typescript/unstable/ast"))});
const source = await Bun.stdin.text();
const file = "/__effectory_parser__/source.ts";
const api = new API({ fs: {
  readFile: p => p === file ? source : null,
  fileExists: p => p === file,
  directoryExists: () => true,
  getAccessibleEntries: () => ({ files: [], directories: [] }),
}});
try {
  const snapshot = await api.updateSnapshot({ openFiles: [file] });
  const project = await snapshot.getDefaultProjectForFile(file);
  if (!project) throw new Error("TypeScript parser did not create a source project");
  const diagnostics = await project.program.getSyntacticDiagnostics(file);
  if (diagnostics.length) throw new Error("invalid TypeScript: " + JSON.stringify(diagnostics));
  const root = await project.program.getSourceFile(file);
  if (!root) throw new Error("TypeScript parser did not return source");
  const imports = new Set();
  const forbidden = new Set(["require", "eval", "Function"]);
  const visit = node => {
    if ((node.kind === SyntaxKind.CallExpression && node.expression.kind === SyntaxKind.ImportKeyword) ||
        node.kind === SyntaxKind.ImportEqualsDeclaration ||
        (node.kind === SyntaxKind.MetaProperty && node.keywordToken === SyntaxKind.ImportKeyword)) {
      throw new Error("dynamic import/import.meta/import-equals is unsupported; use static imports");
    }
    if (node.kind === SyntaxKind.Identifier && forbidden.has(node.text)) {
      throw new Error("unsupported dynamic code loading identifier: " + node.text);
    }
    if (node.kind === SyntaxKind.ImportDeclaration || node.kind === SyntaxKind.ExportDeclaration) {
      if (node.moduleSpecifier) {
        if (node.moduleSpecifier.kind !== SyntaxKind.StringLiteral) throw new Error("unsupported nonliteral module specifier");
        if (node.attributes) throw new Error("unsupported import attributes");
        imports.add(node.moduleSpecifier.text);
      }
    }
    if (node.kind === SyntaxKind.ImportType) {
      const literal = node.argument.literal;
      if (!literal || literal.kind !== SyntaxKind.StringLiteral) throw new Error("unsupported import type");
      imports.add(literal.text);
    }
    node.forEachChild(visit);
  };
  visit(root);
  console.log(JSON.stringify({ imports: [...imports] }));
  await snapshot.dispose();
} catch (error) {
  console.log(JSON.stringify({ error: String(error) }));
} finally {
  await api.close();
}
`;

const sourceImports = (file: string, source: string): readonly string[] => {
  const cached = parsedSources.get(source);
  if (cached) {
    return cached;
  }
  // Bun also rejects syntax it cannot execute, independently of TypeScript's parser.
  try {
    transpiler.transformSync(source);
  } catch (error) {
    throw new TaskCatalogError(`${file}: invalid TypeScript: ${String(error)}`);
  }
  const result = Bun.spawnSync(
    [process.execPath, "--no-install", "--eval", parserProgram],
    {
      stderr: "pipe",
      stdin: Buffer.from(source),
      stdout: "pipe",
      timeout: 10_000,
    }
  );
  if (result.exitCode !== 0) {
    throw new TaskCatalogError(
      `${file}: local TypeScript parser failed: ${result.stderr.toString()}`
    );
  }
  const parsed: unknown = JSON.parse(result.stdout.toString());
  if (typeof parsed !== "object" || parsed === null) {
    throw new TaskCatalogError(`${file}: invalid parser response`);
  }
  const response = parsed as Record<string, unknown>;
  if (typeof response.error === "string") {
    throw new TaskCatalogError(`${file}: ${response.error}`);
  }
  if (
    !Array.isArray(response.imports) ||
    !response.imports.every((value: unknown) => typeof value === "string")
  ) {
    throw new TaskCatalogError(`${file}: invalid parser imports`);
  }
  const imports: readonly string[] = response.imports;
  parsedSources.set(source, imports);
  return imports;
};

const visitWorkspaceEntrypoint = (
  workspace: string,
  visit: (file: string) => void
) => {
  const entrypoint = workspaceEntrypoint(workspace);
  if (entrypoint) {
    visit(entrypoint);
  }
};

/**
 * This is a reproducible source identity for trusted code, not a sandbox.
 * Supports explicit relative .ts imports/reexports and the packages above.
 * Dynamic loading/import attributes are rejected. Arithmetic, regexes and templates parse natively.
 * Installed dependency bytes must match bun.lock. Runtime data is not source.
 */
export const fingerprintTask = (
  workspace: string,
  entrypoint: string
): TaskFingerprint => {
  const root = realpathSync(workspace);
  // An isolated Effectory project does not inherit host repository configuration.
  const project = effectoryProject(root);
  const registration = workspaceEntrypoint(root);
  const files = new Map<string, Buffer>();
  const installedPackages = new Map<string, Buffer>();
  const installedSources = new Set<string>();
  const installedAuthoringRoots = new Map<string, string>();
  const visitedSources = new Set<string>();
  const fail = (file: string, reason: string): never => {
    throw new TaskCatalogError(`${path.relative(root, file)}: ${reason}`);
  };
  const resolveDependency = (specifier: string, file: string): string =>
    resolveSourceDependency(root, project, specifier, file);
  const checkPath = (file: string) => {
    const relative = path.relative(root, file);
    if (
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    ) {
      fail(file, "source dependency escapes workspace");
    }
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (lstatSync(current).isSymbolicLink()) {
        fail(current, "symlink source/configuration is unsupported");
      }
    }
    if (!lstatSync(file).isFile()) {
      fail(file, "expected a regular file");
    }
  };
  const add = (file: string) => {
    checkPath(file);
    const relative = path.relative(root, file).split(path.sep).join("/");
    files.set(relative, readFileSync(file));
  };
  // Lock and package metadata are mandatory. No resolver aliases or implicit extensions.
  for (const name of ["package.json", "bun.lock"]) {
    const file = path.join(project, name);
    if (!existsSync(file)) {
      fail(file, "required for reproducible task identity");
    }
    add(file);
  }
  if (project !== root && !existsSync(path.join(project, "tsconfig.json"))) {
    fail(
      project,
      "isolated Effectory projects require tsconfig.json; run effectory init"
    );
  }
  for (const name of ["tsconfig.json", "bunfig.toml"]) {
    const file = path.join(project, name);
    if (existsSync(file)) {
      add(file);
    }
  }
  const metadata: unknown = JSON.parse(
    readFileSync(path.join(project, "package.json"), "utf-8")
  );
  if (typeof metadata !== "object" || metadata === null) {
    fail(root, "package.json must be an object");
  }
  const packageData = metadata as Record<string, unknown>;
  if (supportedPackages.includes(String(packageData.name))) {
    fail(root, "package self-reference shadows a supported external package");
  }
  const addPatches = (patches: unknown): void => {
    if (patches === undefined) {
      return;
    }
    if (typeof patches !== "object" || patches === null) {
      fail(root, "patchedDependencies must be an object");
    }
    for (const patch of Object.values(patches as Record<string, unknown>)) {
      if (typeof patch !== "string") {
        fail(root, "patch paths must be strings");
      }
      add(path.resolve(project, patch as string));
    }
  };
  addPatches(packageData.patchedDependencies);
  const bunConfig = path.join(project, "bunfig.toml");
  if (existsSync(bunConfig)) {
    const inspectConfiguration = (value: unknown): void => {
      if (typeof value !== "object" || value === null) {
        return;
      }
      for (const [key, setting] of Object.entries(value)) {
        if (key === "preload" || key === "plugins") {
          fail(
            bunConfig,
            "Bun preload/plugins are unsupported source dependencies"
          );
        }
        inspectConfiguration(setting);
      }
    };
    inspectConfiguration(Bun.TOML.parse(readFileSync(bunConfig, "utf-8")));
  }
  const config = path.join(project, "tsconfig.json");
  if (
    existsSync(config) &&
    /["'](?:extends|paths|baseUrl)["']\s*:/u.test(readFileSync(config, "utf-8"))
  ) {
    fail(config, "extended/aliased compiler configuration is unsupported");
  }
  if (existsSync(path.join(project, "jsconfig.json"))) {
    fail(root, "jsconfig.json is unsupported; use tsconfig.json");
  }
  // oxlint-disable-next-line complexity -- Graph walk validates every allowed dependency boundary before following it.
  const visit = (
    file: string,
    authoringRoot?: string,
    registrationSource = false
  ): void => {
    const sourceRoot = authoringRoot ?? project;
    const sourceRelative = path.relative(sourceRoot, file);
    // Only the selected root registration may live outside the isolated project.
    // Its relative dependencies still pass through the normal project boundary.
    const rootRegistration =
      registrationSource && !authoringRoot && file === registration;
    if (
      !rootRegistration &&
      (sourceRelative === ".." ||
        sourceRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(sourceRelative))
    ) {
      fail(file, "source dependency escapes workspace Effectory project");
    }
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (visitedSources.has(relative)) {
      return;
    }
    visitedSources.add(relative);
    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) {
      fail(file, "only executable .ts source imports are supported");
    }
    if (authoringRoot && installedAuthoringRoots.has(authoringRoot)) {
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) {
        fail(file, "authoring package source must be a regular file");
      }
      installedPackages.set(
        `${installedAuthoringRoots.get(authoringRoot)}/${sourceRelative.split(path.sep).join("/")}`,
        readFileSync(file)
      );
      installedSources.add(file);
    } else {
      add(file);
    }
    // Nested resolver configuration changes Bun's interpretation of imports.
    let directory = path.dirname(file);
    while (directory !== (rootRegistration ? root : sourceRoot)) {
      for (const name of [
        "package.json",
        "tsconfig.json",
        "jsconfig.json",
        "bunfig.toml",
      ]) {
        if (existsSync(path.join(directory, name))) {
          fail(file, `nested ${name} is unsupported`);
        }
      }
      directory = path.dirname(directory);
    }
    const staticSpecifiers = sourceImports(file, readFileSync(file, "utf-8"));
    for (const specifier of staticSpecifiers) {
      if (
        specifier.split("/").some((part) => part === "..") &&
        !specifier.startsWith("../") &&
        !specifier.startsWith("./")
      ) {
        fail(file, `unsupported package traversal: ${specifier}`);
      }
      const authoringPackage = authoringPackages.find(
        (pkg) => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)
      );
      if (authoringPackage) {
        const { name, modules, label } = authoringPackage;
        const module =
          specifier === name ? "index" : specifier.slice(name.length + 1);
        if (!modules.has(module)) {
          fail(file, `unsupported ${label} authoring module: ${specifier}`);
        }
        let source: string;
        try {
          source = resolveDependency(specifier, file);
        } catch {
          return fail(file, `${label} is not installed locally: ${specifier}`);
        }
        // Distributed authoring package exports match the development layout.
        const packageRoot = path.dirname(path.dirname(source));
        const manifest = path.join(packageRoot, "package.json");
        const sdkMetadata = readFileSync(manifest);
        const sdkPackage = JSON.parse(sdkMetadata.toString());
        if (
          sdkPackage.name !== name ||
          typeof sdkPackage.version !== "string" ||
          sdkPackage.exports?.["./*"] !== "./src/*.ts" ||
          sdkPackage.exports?.["."] !== "./src/index.ts" ||
          source !== path.join(packageRoot, "src", `${module}.ts`)
        ) {
          fail(manifest, `unsupported ${label} package exports or version`);
        }
        // Track authoring source bytes as well as metadata: local dogfood tarballs can
        // change without a version bump. Effect remains identified by the lockfile.
        installedPackages.set(name, sdkMetadata);
        const sdkRelative = path.relative(root, packageRoot);
        if (
          !sdkRelative.startsWith(`..${path.sep}`) &&
          sdkRelative !== ".." &&
          !path.isAbsolute(sdkRelative) &&
          !sdkRelative.split(path.sep).includes("node_modules")
        ) {
          add(manifest);
        } else {
          installedAuthoringRoots.set(packageRoot, name);
          installedSources.add(manifest);
        }
        visit(source, packageRoot);
      } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
        if (!specifier.endsWith(".ts") || /[?#]/u.test(specifier)) {
          fail(
            file,
            `local import must use an explicit .ts path: ${specifier}`
          );
        }
        visit(path.resolve(path.dirname(file), specifier), authoringRoot);
      } else if (
        specifier !== "bun:sqlite" &&
        !(specifier.startsWith("node:") && isBuiltin(specifier)) &&
        !supportedPackages.some(
          (name) => specifier === name || specifier.startsWith(`${name}/`)
        )
      ) {
        fail(
          file,
          `unsupported package/import ${specifier}; allowed packages: ${supportedPackages.join(", ")} and node: builtins`
        );
      } else if (
        supportedPackages.some(
          (name) => specifier === name || specifier.startsWith(`${name}/`)
        )
      ) {
        try {
          // resolveSync only inspects installed files; do not let import trigger package fetching.
          resolveDependency(specifier, file);
        } catch {
          fail(file, `package is not installed locally: ${specifier}`);
        }
      }
    }
  };
  try {
    visit(path.resolve(root, entrypoint), undefined, true);
    visitWorkspaceEntrypoint(root, (file) => visit(file, undefined, true));
  } catch (error) {
    if (error instanceof TaskCatalogError) {
      throw error;
    }
    throw new TaskCatalogError(
      `Cannot fingerprint ${entrypoint}: ${String(error)}`
    );
  }
  const names = [...files.keys()].toSorted();
  const hash = createHash("sha256");
  hash.update(`effectory-task-fingerprint-v2\0bun:${Bun.version}\0`);
  for (const [name, installedMetadata] of [...installedPackages].toSorted(
    ([a], [b]) => a.localeCompare(b)
  )) {
    hash.update(`${name}:${installedMetadata.length}:`);
    hash.update(installedMetadata);
  }
  for (const name of names) {
    const contents = files.get(name);
    if (!contents) {
      throw new TaskCatalogError(`Missing fingerprint contents: ${name}`);
    }
    hash.update(`${Buffer.byteLength(name)}:${name}${contents.length}:`);
    hash.update(contents);
  }
  return {
    digest: hash.digest("hex"),
    files: names,
    installedSources: [...installedSources].toSorted(),
  };
};
