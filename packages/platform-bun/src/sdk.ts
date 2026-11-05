import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect } from "effect";

import { hostVersions } from "./host-runtime.ts";

/**
 * A project authors against the npm SDK for types, while the host runs it with
 * its own built-in copies. These helpers keep the two versions identical and
 * record which Effectory version last set the project up.
 */
export type SdkPackage = keyof typeof hostVersions;
const sdkPackages = Object.keys(hostVersions) as SdkPackage[];

const invalid = (message: string) =>
  new OperationError({ code: "InvalidInput", message });

/** Node-style lookup: the nearest `node_modules/<name>` from the project upward. */
function installedVersion(repository: string, name: string) {
  let directory = path.resolve(repository);
  for (;;) {
    const manifest = path.join(directory, "node_modules", name, "package.json");
    if (existsSync(manifest)) {
      const parsed: unknown = JSON.parse(readFileSync(manifest, "utf-8"));
      const version =
        typeof parsed === "object" && parsed !== null
          ? Reflect.get(parsed, "version")
          : undefined;
      return typeof version === "string" ? version : null;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

export type VersionStatus = "Match" | "Mismatch" | "Missing";

export interface SdkPackageStatus {
  readonly name: SdkPackage;
  readonly host: string;
  readonly installed: string | null;
  readonly status: VersionStatus;
}

/** The Effectory version a project was last initialized or upgraded with. */
export interface ProjectMarkerStatus {
  readonly host: string;
  readonly recorded: string | null;
  readonly status: VersionStatus;
}

function compare(installed: string | null, host: string): VersionStatus {
  if (installed === null) {
    return "Missing";
  }
  return installed === host ? "Match" : "Mismatch";
}

interface PackageJson {
  [key: string]: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(filename: string): PackageJson {
  const parsed: unknown = JSON.parse(readFileSync(filename, "utf-8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid("package.json must contain an object");
  }
  return parsed as PackageJson;
}

/** `package.json` → `"effectory": { "version": "…" }`, like Swamp's `.swamp.yaml`. */
function recordedVersion(manifest: PackageJson) {
  const marker = manifest.effectory;
  const version =
    typeof marker === "object" && marker !== null
      ? Reflect.get(marker, "version")
      : undefined;
  return typeof version === "string" ? version : null;
}

/**
 * Compare the project with this host: the recorded Effectory version and the
 * nearest installed SDK packages. Read-only; it never contacts the daemon.
 */
export function projectStatus(repository: string, effectoryVersion: string) {
  return Effect.try({
    catch: (cause) =>
      cause instanceof OperationError
        ? cause
        : invalid("package.json or installed SDK manifests could not be read"),
    try: () => {
      const filename = path.join(path.resolve(repository), "package.json");
      const recorded = existsSync(filename)
        ? recordedVersion(readPackageJson(filename))
        : null;
      const project: ProjectMarkerStatus = {
        host: effectoryVersion,
        recorded,
        status: compare(recorded, effectoryVersion),
      };
      const packages = sdkPackages.map((name): SdkPackageStatus => {
        const installed = installedVersion(repository, name);
        const host = hostVersions[name];
        return { host, installed, name, status: compare(installed, host) };
      });
      return {
        ok:
          project.status === "Match" &&
          packages.every((pkg) => pkg.status === "Match"),
        packages,
        project,
      };
    },
  });
}

/** One line for stderr when the project and this host disagree. */
export function projectWarning(status: {
  readonly packages: readonly SdkPackageStatus[];
  readonly project: ProjectMarkerStatus;
}) {
  const problems: string[] = [];
  if (status.project.status === "Missing") {
    problems.push("the project has no recorded Effectory version");
  } else if (status.project.status === "Mismatch") {
    problems.push(
      `the project was set up with Effectory ${String(status.project.recorded)}, this is ${status.project.host}`
    );
  }
  for (const pkg of status.packages) {
    if (pkg.installed === null) {
      problems.push(`${pkg.name} is not installed (host ${pkg.host})`);
    } else if (pkg.status === "Mismatch") {
      problems.push(
        `${pkg.name} ${pkg.installed} differs from host ${pkg.host}`
      );
    }
  }
  if (problems.length === 0) {
    return null;
  }
  // A current marker means the pins are already right; only installing is left.
  const advice =
    status.project.status === "Match"
      ? "Install dependencies with your package manager."
      : "Run `effectory upgrade`, then reinstall dependencies.";
  return `Warning: ${problems.join("; ")}. ${advice}`;
}

/**
 * Bring a project to this host's version, as `swamp repo upgrade` does: record
 * the Effectory version and pin the SDK packages to exactly what runs.
 */
export function upgradeProject(repository: string, effectoryVersion: string) {
  return Effect.try({
    catch: (cause) =>
      cause instanceof OperationError
        ? cause
        : invalid("package.json could not be read or written"),
    try: () => {
      const filename = path.join(path.resolve(repository), "package.json");
      const created = !existsSync(filename);
      const manifest: PackageJson = created
        ? {
            name: path.basename(path.resolve(repository)),
            private: true,
            type: "module",
          }
        : readPackageJson(filename);
      const previousVersion = recordedVersion(manifest);
      const changes: { name: string; from: string | null; to: string }[] = [];
      for (const name of sdkPackages) {
        const field =
          manifest.dependencies?.[name] === undefined
            ? "devDependencies"
            : "dependencies";
        const table = { ...manifest[field] };
        const from = table[name] ?? null;
        const to = hostVersions[name];
        if (from !== to) {
          table[name] = to;
          manifest[field] = Object.fromEntries(
            Object.entries(table).toSorted(([left], [right]) =>
              left.localeCompare(right)
            )
          );
          changes.push({ from, name, to });
        }
      }
      const markerChanged = previousVersion !== effectoryVersion;
      if (markerChanged) {
        const marker =
          typeof manifest.effectory === "object" && manifest.effectory !== null
            ? manifest.effectory
            : {};
        manifest.effectory = { ...marker, version: effectoryVersion };
      }
      if (created || markerChanged || changes.length > 0) {
        writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      return {
        changes,
        created,
        next:
          changes.length > 0
            ? "Install dependencies with your package manager (bun install, npm install or pnpm install)."
            : null,
        packageJson: filename,
        previousVersion,
        version: effectoryVersion,
      };
    },
  });
}

const applicationTemplate = `import { Application, Task, Workflow } from "@effectory/core";
import { Effect, Schema } from "effect";

const Input = Schema.Struct({ name: Schema.String });

const greet = Task.make(
  {
    error: Schema.Never,
    id: "hello/greet",
    input: Input,
    replay: "idempotent",
    success: Schema.String,
    version: 1,
  },
  ({ name }) => Effect.succeed(\`Hello \${name}\`)
);

const hello = Workflow.make(
  {
    error: Schema.Never,
    id: "hello/run",
    input: Input,
    success: Schema.String,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const input = yield* graph.input(Input);
    return yield* graph.task("greet", greet, input);
  })
);

export default Application.make({
  tasks: [greet],
  workflows: [hello],
});
`;

const tsconfigTemplate = `${JSON.stringify(
  {
    compilerOptions: {
      exactOptionalPropertyTypes: true,
      lib: ["ES2024"],
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: "ES2024",
      verbatimModuleSyntax: true,
    },
    include: ["**/*.ts"],
  },
  null,
  2
)}\n`;

/** Scaffold a project; existing files are left untouched. */
export function initProject(repository: string, effectoryVersion: string) {
  return Effect.gen(function* () {
    const root = path.resolve(repository);
    const files = yield* Effect.try({
      catch: () => invalid("Project files could not be written"),
      try: () => {
        mkdirSync(root, { recursive: true });
        const written: string[] = [];
        const kept: string[] = [];
        const create = (name: string, contents: string) => {
          const filename = path.join(root, name);
          if (existsSync(filename)) {
            kept.push(name);
          } else {
            writeFileSync(filename, contents);
            written.push(name);
          }
        };
        create("effectory.ts", applicationTemplate);
        create("tsconfig.json", tsconfigTemplate);
        const ignore = path.join(root, ".gitignore");
        const current = existsSync(ignore) ? readFileSync(ignore, "utf-8") : "";
        const lines = current.split(/\r?\n/u);
        const missing = [".effectory/", "node_modules/"].filter(
          (entry) => !lines.includes(entry)
        );
        if (missing.length > 0) {
          const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
          writeFileSync(ignore, `${current}${prefix}${missing.join("\n")}\n`);
          written.push(".gitignore");
        }
        return { kept, written };
      },
    });
    const upgrade = yield* upgradeProject(root, effectoryVersion);
    return { ...files, upgrade };
  });
}
