import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { startControlServer } from "@effectory/runtime/control";
import { fingerprintTask } from "@effectory/runtime/fingerprint";
import { RuntimeStore } from "@effectory/runtime/store";
import {
  listTaskDirectories,
  loadTaskCatalog,
  loadWorkspaceConfig,
} from "@effectory/runtime/tasks";
import { defineTask } from "@effectory/sdk/manifest";
import { Effect, Schema } from "effect";
import * as Workflow from "effect/workflow/Workflow";

let workspace: string;
const write = (file: string, source: string) => {
  const absolute = path.join(workspace, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, source);
  return absolute;
};
const manifest = (tag = "Fixture") => `
import { Effect, Schema } from "effect";
import * as Workflow from "effect/workflow/Workflow";
import { label } from "../../../shared.ts";
const workflow = Workflow.make(${JSON.stringify(tag)}, {
  payload: { request: Schema.String }, success: Schema.String,
  idempotencyKey: (input) => input.request,
});
export default { description: label, workflow,
  implementation: workflow.toLayer((input) => Effect.succeed(input.request)) };
`;
const task = (name = "health-check", tag?: string) =>
  write(`.effectory/automations/${name}/index.ts`, manifest(tag));

beforeEach(() => {
  // Keep fixtures under this checkout so installed Effect resolves without installs.
  workspace = mkdtempSync(path.join(import.meta.dir, "runtime-task-fixtures-"));
  write("package.json", '{"type":"module"}');
  write("bun.lock", "fixture lock v1");
  write("shared.ts", 'export const label = "Check health";');
});
afterEach(() => rmSync(workspace, { force: true, recursive: true }));

test("defineTask preserves concrete Workflow and native Layer types", () => {
  const workflow = Workflow.make("Typed", {
    idempotencyKey: (input) => input.request,
    payload: { request: Schema.String },
  });
  const implementation = workflow.toLayer(() => Effect.void);
  const defined = defineTask({
    description: "Typed",
    implementation,
    workflow,
  });
  const exactWorkflow: typeof workflow = defined.workflow;
  const exactLayer: typeof implementation = defined.implementation;
  expect(exactWorkflow).toBe(workflow);
  expect(exactLayer).toBe(implementation);
});

test("plain listing never executes task modules", () => {
  task();
  write(
    ".effectory/automations/shared/index.ts",
    'throw new Error("shared code is not an automation");'
  );
  write(
    ".effectory/automations/broken/index.ts",
    'throw new Error("must not execute");'
  );
  expect(listTaskDirectories(workspace).map((entry) => entry.name)).toEqual([
    "broken",
    "health-check",
  ]);
});

test("registers a thin native manifest and derives its input schema", async () => {
  task();
  const catalog = await loadTaskCatalog(workspace);
  expect(catalog).toHaveLength(1);
  const [registered] = catalog;
  if (!registered) {
    throw new Error("Expected registered task");
  }
  expect(registered.name).toBe("health-check");
  expect(registered.description).toBe("Check health");
  expect(registered.workflow._tag).toBe("Fixture");
  expect(JSON.stringify(registered.inputSchema)).toContain('"request"');
  expect(registered.workflow.payloadSchema.fields.request).toBe(Schema.String);
  expect(registered.fingerprint.files).toContain("shared.ts");
});

test("rejects duplicate workflow identities", async () => {
  task("first");
  task("second");
  await expect(loadTaskCatalog(workspace)).rejects.toThrow(
    "Duplicate workflow tag Fixture in tasks first and second"
  );
});

test("rejects mismatched task identity and invalid directory names", async () => {
  const entry = task();
  writeFileSync(
    entry,
    manifest().replace(
      "description: label",
      'name: "other", description: label'
    )
  );
  await expect(loadTaskCatalog(workspace)).rejects.toThrow(
    "manifest name must match directory"
  );
  task("Bad_Name");
  expect(() => listTaskDirectories(workspace)).toThrow(
    "Invalid task directory name"
  );
});

test.each([
  ["export default {};", "description"],
  ['export default { description: "x", workflow: {} };', "native Workflow"],
  [
    manifest().replace(
      "implementation: workflow.toLayer((input) => Effect.succeed(input.request))",
      "implementation: {}"
    ),
    "native Layer",
  ],
  [
    manifest().replace(
      "export default",
      "Object.assign(workflow, { payloadSchema: {} }); export default"
    ),
    "payloadSchema must be an Effect Schema",
  ],
  [
    manifest().replace(
      "request: Schema.String",
      'request: Schema.suspend(() => { throw new Error("broken recursive schema"); })'
    ),
    "payload schema cannot be described as JSON",
  ],
])(
  "invalid manifests explain the failing boundary: %s",
  async (source, message) => {
    write(".effectory/automations/invalid/index.ts", source);
    await expect(loadTaskCatalog(workspace)).rejects.toThrow(message);
  }
);

test.each([
  'import("./other.ts");',
  'const file = "./other.ts"; import(file);',
  'require("./other.ts");',
  'import x from "uninstalled-package";',
  'export { x } from "./other.js";',
  'import x from "https://example.com/x.ts";',
  // oxlint-disable-next-line no-template-curly-in-string -- Source code must preserve the dynamic import inside an interpolation.
  "const value = `hello ${import(file)}`;",
  'const expression = /`/; const file = "./other.ts"; import(file); /`/;',
])(
  "rejects unsupported loading/source before execution: %s",
  async (source) => {
    write(
      ".effectory/automations/invalid/index.ts",
      `${source}\nthrow new Error("module executed");`
    );
    await expect(loadTaskCatalog(workspace)).rejects.toThrow(
      /unsupported|static imports|explicit .ts/u
    );
  }
);

test("validates all candidate import graphs before executing any modules", async () => {
  write(
    ".effectory/automations/aaa/index.ts",
    'throw new Error("should never execute");'
  );
  write(".effectory/automations/zzz/index.ts", 'import "unknown";');
  await expect(loadTaskCatalog(workspace)).rejects.toThrow(
    "unsupported package/import unknown"
  );
});

test("fingerprints transitive imports, reexports, cycles and type-only imports deterministically", () => {
  const entry = task();
  write(
    "shared.ts",
    'export { label } from "./operation.ts"; import type { Options } from "./types.ts";'
  );
  write(
    "operation.ts",
    'import "./shared.ts"; export const label = "Check health";'
  );
  write("types.ts", "export interface Options { request: string }");
  const first = fingerprintTask(workspace, entry);
  expect(first.files).toEqual([
    ".effectory/automations/health-check/index.ts",
    "bun.lock",
    "operation.ts",
    "package.json",
    "shared.ts",
    "types.ts",
  ]);
  expect(fingerprintTask(workspace, entry)).toEqual(first);
  write("unrelated.ts", "export const ignored = 1;");
  expect(fingerprintTask(workspace, entry)).toEqual(first);
  write("operation.ts", 'export const label = "Changed";');
  const changed = fingerprintTask(workspace, entry);
  expect(changed.digest).not.toBe(first.digest);
  write("bun.lock", "fixture lock v2");
  expect(fingerprintTask(workspace, entry).digest).not.toBe(changed.digest);
});

test("same source tree at a different absolute path has the same fingerprint", () => {
  const entry = task();
  const other = mkdtempSync(
    path.join(import.meta.dir, "runtime-task-fixtures-")
  );
  try {
    for (const file of fingerprintTask(workspace, entry).files) {
      const destination = path.join(other, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(path.join(workspace, file)));
    }
    expect(
      fingerprintTask(other, ".effectory/automations/health-check/index.ts")
    ).toEqual(fingerprintTask(workspace, entry));
  } finally {
    rmSync(other, { force: true, recursive: true });
  }
});

test("rejects escaping dependencies, symlinks and nested resolver configuration", () => {
  const entry = task();
  write("shared.ts", 'import "../outside.ts";');
  expect(() => fingerprintTask(workspace, entry)).toThrow("escapes workspace");
  rmSync(path.join(workspace, "shared.ts"));
  symlinkSync(
    path.join(workspace, "package.json"),
    path.join(workspace, "shared.ts")
  );
  expect(() => fingerprintTask(workspace, entry)).toThrow("symlink");
  rmSync(path.join(workspace, "shared.ts"));
  write("shared.ts", 'export const label = "Check health";');
  write(".effectory/automations/tsconfig.json", "{}");
  expect(() => fingerprintTask(workspace, entry)).toThrow(
    "nested tsconfig.json"
  );
});

test("rejects re-registration after edits instead of pairing cached code with a new digest", async () => {
  task();
  await loadTaskCatalog(workspace);
  write("shared.ts", 'export const label = "Changed";');
  await expect(loadTaskCatalog(workspace)).rejects.toThrow(
    "restart the runner"
  );
});

test("tracks static dependencies with nested template interpolations", () => {
  const entry = task();
  write(
    "shared.ts",
    // oxlint-disable-next-line no-template-curly-in-string -- Source code for the complete parser fixture.
    "const n = 1; export const label = `health ${n + `${({v: 2}).v}`}`;"
  );
  expect(fingerprintTask(workspace, entry).files).toContain("shared.ts");
});

test("supports ordinary arithmetic and regex literals without hiding dynamic imports", () => {
  const entry = task();
  write(
    "shared.ts",
    "let x = 20; x /= 2; const y = x / 5; export const label = String(y) + /`/.source;"
  );
  expect(fingerprintTask(workspace, entry).files).toContain("shared.ts");
  write(
    "shared.ts",
    'if (true) /`/.test("x"); const p = "./other.ts"; import(p); /`/.test("x");'
  );
  expect(() => fingerprintTask(workspace, entry)).toThrow("static imports");
});

test("fingerprints the existing HTTP-check operation with its native latency arithmetic", () => {
  const root = path.resolve(import.meta.dir, "../../..");
  expect(
    fingerprintTask(
      root,
      ".effectory/automations/shared/activities/http-check.ts"
    ).files
  ).toContain(".effectory/automations/shared/activities/http-check.ts");
});

test("fingerprint includes declared patch bytes and compiler configuration", () => {
  const entry = task();
  write(
    "package.json",
    JSON.stringify({
      patchedDependencies: { effect: "patches/effect.patch" },
      type: "module",
    })
  );
  write("patches/effect.patch", "patch v1");
  write("tsconfig.json", "{}");
  const first = fingerprintTask(workspace, entry);
  expect(first.files).toContain("patches/effect.patch");
  write("patches/effect.patch", "patch v2");
  expect(fingerprintTask(workspace, entry).digest).not.toBe(first.digest);
  write("tsconfig.json", '{"compilerOptions":{"target":"ES2024"}}');
  expect(fingerprintTask(workspace, entry).digest).not.toBe(first.digest);
  write(
    "tsconfig.json",
    '{"compilerOptions":{"paths":{"effect":["./alternate.ts"]}}}'
  );
  expect(() => fingerprintTask(workspace, entry)).toThrow(
    "aliased compiler configuration"
  );
});

test("a source listed as a patch is still checked for unsupported imports", () => {
  const entry = task();
  write(
    "package.json",
    JSON.stringify({
      patchedDependencies: {
        effect: ".effectory/automations/health-check/index.ts",
      },
    })
  );
  writeFileSync(entry, 'const p = "./hidden.ts"; import(p);');
  expect(() => fingerprintTask(workspace, entry)).toThrow("static imports");
});

test("rejects untracked code loaded by Bun preloads", () => {
  const entry = task();
  write("bunfig.toml", 'preload = ["./untracked.ts"]');
  expect(() => fingerprintTask(workspace, entry)).toThrow("preload/plugins");
});

test("SDK package imports fingerprint workspace sources and package metadata", () => {
  const entry = write(
    ".effectory/automations/sdk/index.ts",
    'export { label } from "@effectory/sdk/services";'
  );
  write(
    "packages/sdk/package.json",
    JSON.stringify({
      exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
      name: "@effectory/sdk",
      type: "module",
      version: "0.1.0",
    })
  );
  write("packages/sdk/src/services.ts", 'export const label = "first";');
  mkdirSync(path.join(workspace, "node_modules/@effectory"), {
    recursive: true,
  });
  symlinkSync(
    path.join(workspace, "packages/sdk"),
    path.join(workspace, "node_modules/@effectory/sdk"),
    "dir"
  );
  const first = fingerprintTask(workspace, entry);
  expect(first.files).toContain("packages/sdk/package.json");
  expect(first.files).toContain("packages/sdk/src/services.ts");
  write("packages/sdk/src/services.ts", 'export const label = "second";');
  expect(fingerprintTask(workspace, entry).digest).not.toBe(first.digest);
  write(
    "packages/sdk/package.json",
    JSON.stringify({
      exports: { "./*": "./other/*.ts" },
      name: "@effectory/sdk",
      type: "module",
    })
  );
  expect(() => fingerprintTask(workspace, entry)).toThrow(
    "unsupported SDK package exports"
  );
});

test("activities package imports fingerprint transitive sources and validate exports", () => {
  const entry = write(
    ".effectory/automations/process/index.ts",
    'export { Process } from "@effectory/activities";'
  );
  const packageManifest = {
    exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
    name: "@effectory/activities",
    type: "module",
    version: "0.1.2",
  };
  write("packages/activities/package.json", JSON.stringify(packageManifest));
  write(
    "packages/activities/src/index.ts",
    'export * as Process from "./process.ts";'
  );
  write("packages/activities/src/process.ts", 'export const run = "first";');
  mkdirSync(path.join(workspace, "node_modules/@effectory"), {
    recursive: true,
  });
  symlinkSync(
    path.join(workspace, "packages/activities"),
    path.join(workspace, "node_modules/@effectory/activities"),
    "dir"
  );
  const first = fingerprintTask(workspace, entry);
  expect(first.files).toContain("packages/activities/package.json");
  expect(first.files).toContain("packages/activities/src/process.ts");
  write("packages/activities/src/process.ts", 'export const run = "second";');
  const changedSource = fingerprintTask(workspace, entry);
  expect(changedSource.digest).not.toBe(first.digest);
  write(
    "packages/activities/package.json",
    JSON.stringify({ ...packageManifest, description: "changed" })
  );
  const changed = fingerprintTask(workspace, entry);
  expect(changed.digest).not.toBe(changedSource.digest);
  write(
    "packages/activities/package.json",
    JSON.stringify({ ...packageManifest, exports: { ".": "./other.ts" } })
  );
  expect(() => fingerprintTask(workspace, entry)).toThrow(
    "unsupported activities package exports"
  );
});

test("T3 package imports fingerprint their sources", () => {
  const entry = write(
    ".effectory/automations/t3/index.ts",
    'export { Thread } from "@effectory/t3";'
  );
  write(
    "packages/t3/package.json",
    JSON.stringify({
      exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
      name: "@effectory/t3",
      type: "module",
      version: "0.1.2",
    })
  );
  write(
    "packages/t3/src/index.ts",
    'export * as Thread from "./thread/index.ts";'
  );
  write(
    "packages/t3/src/thread/index.ts",
    'export { start } from "./start.ts";'
  );
  write("packages/t3/src/thread/start.ts", 'export const start = "first";');
  mkdirSync(path.join(workspace, "node_modules/@effectory"), {
    recursive: true,
  });
  symlinkSync(
    path.join(workspace, "packages/t3"),
    path.join(workspace, "node_modules/@effectory/t3"),
    "dir"
  );
  const first = fingerprintTask(workspace, entry);
  expect(first.files).toContain("packages/t3/src/thread/start.ts");
  write("packages/t3/src/thread/start.ts", 'export const start = "second";');
  expect(fingerprintTask(workspace, entry).digest).not.toBe(first.digest);
});

test("rejects a symlinked .effectory directory before discovery", () => {
  symlinkSync(workspace, path.join(workspace, ".effectory"), "dir");
  expect(() => listTaskDirectories(workspace)).toThrow(
    ".effectory must be a real directory"
  );
});

test("isolated Effectory metadata ignores host toolchains and requires its own lock and config", () => {
  const entry = write(
    ".effectory/automations/isolated/index.ts",
    "export default {};"
  );
  write(".effectory/package.json", '{"type":"module"}');
  write(".effectory/tsconfig.json", "{}");
  expect(() => fingerprintTask(workspace, entry)).toThrow(
    ".effectory/bun.lock"
  );
  write(".effectory/bun.lock", "isolated lock v1");
  const first = fingerprintTask(workspace, entry);
  expect(first.files).toEqual([
    ".effectory/automations/isolated/index.ts",
    ".effectory/bun.lock",
    ".effectory/package.json",
    ".effectory/tsconfig.json",
  ]);
  write(
    "tsconfig.json",
    '{"extends":"missing","compilerOptions":{"paths":{}}}'
  );
  write("jsconfig.json", "{}");
  write("package.json", '{"packageManager":"pnpm@10.0.0"}');
  write("bun.lock", "unrelated host lock");
  expect(fingerprintTask(workspace, entry)).toEqual(first);
  rmSync(path.join(workspace, "package.json"));
  rmSync(path.join(workspace, "bun.lock"));
  expect(fingerprintTask(workspace, entry)).toEqual(first);
  write(".effectory/bun.lock", "isolated lock v2");
  expect(fingerprintTask(workspace, entry).digest).not.toBe(first.digest);
  writeFileSync(entry, 'import "../../../shared.ts";');
  expect(() => fingerprintTask(workspace, entry)).toThrow(
    "escapes workspace Effectory project"
  );
  writeFileSync(entry, "export default {};");
  write(".effectory/tsconfig.json", '{"extends":"../tsconfig.json"}');
  expect(() => fingerprintTask(workspace, entry)).toThrow("extended/aliased");
});

test.each(["effectory.run.ts", "effectory.config.ts"])(
  "isolated %s fingerprints only the root registration and isolated source graph",
  (registration) => {
    rmSync(workspace, { force: true, recursive: true });
    workspace = realpathSync(
      mkdtempSync(path.join(tmpdir(), "effectory-root-fingerprint-"))
    );
    write("package.json", '{"name":"external-host"}');
    write("tsconfig.json", '{"extends":"missing-host-config"}');
    write(".effectory/package.json", '{"type":"module"}');
    write(".effectory/tsconfig.json", "{}");
    write(".effectory/bun.lock", "isolated lock v1");
    write(
      ".effectory/node_modules/@effectory/sdk/package.json",
      JSON.stringify({
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
        name: "@effectory/sdk",
        type: "module",
        version: "0.1.2",
      })
    );
    const sdk = write(
      ".effectory/node_modules/@effectory/sdk/src/index.ts",
      'export const label = "isolated SDK";'
    );
    const automation = write(
      ".effectory/automations/hello/index.ts",
      'export default "hello";'
    );
    const entry = write(
      registration,
      'import { label } from "@effectory/sdk"; import hello from "./.effectory/automations/hello/index.ts"; export default { label, hello };'
    );
    const first = fingerprintTask(workspace, entry);
    expect(first.files).toContain(registration);
    expect(first.files).toContain(".effectory/automations/hello/index.ts");
    expect(first.files).not.toContain("package.json");
    expect(first.files).not.toContain("tsconfig.json");
    expect(first.installedSources).toContain(sdk);
    writeFileSync(sdk, 'export const label = "changed SDK";');
    expect(fingerprintTask(workspace, entry).digest).not.toBe(first.digest);
    writeFileSync(automation, 'export default "changed workflow";');
    const changed = fingerprintTask(workspace, entry);
    writeFileSync(entry, `${readFileSync(entry, "utf-8")}\n// revision`);
    expect(fingerprintTask(workspace, entry).digest).not.toBe(changed.digest);

    write("host-source.ts", "export default {};");
    writeFileSync(entry, 'import "./host-source.ts";');
    expect(() => fingerprintTask(workspace, entry)).toThrow(
      "escapes workspace Effectory project"
    );
    writeFileSync(entry, 'import "./.effectory/automations/hello/index.ts";');
    writeFileSync(automation, 'import "../../../host-source.ts";');
    expect(() => fingerprintTask(workspace, entry)).toThrow(
      "escapes workspace Effectory project"
    );
    writeFileSync(automation, `import "../../../${registration}";`);
    expect(() => fingerprintTask(workspace, entry)).toThrow(
      "escapes workspace Effectory project"
    );
    writeFileSync(automation, "export default {};");
    write(".effectory/automations/hello/tsconfig.json", "{}");
    expect(() => fingerprintTask(workspace, entry)).toThrow("nested tsconfig");
    rmSync(path.join(workspace, ".effectory/automations/hello/tsconfig.json"));
    rmSync(entry);
    symlinkSync(automation, entry);
    expect(() => fingerprintTask(workspace, entry)).toThrow("symlink");
  }
);

test("isolated root registration refuses SDK packages inherited from the host", () => {
  write(".effectory/package.json", '{"type":"module"}');
  write(".effectory/tsconfig.json", "{}");
  write(".effectory/bun.lock", "isolated lock v1");
  const entry = write(
    "effectory.run.ts",
    'import { Effectory } from "@effectory/sdk"; export default Effectory.make({ workflows: [] });'
  );
  expect(() => fingerprintTask(workspace, entry)).toThrow(
    "SDK is not installed locally"
  );
});

test("installed SDK source changes invalidate revisions and cached registration", async () => {
  const entry = task();
  writeFileSync(
    entry,
    manifest().replace("../../../shared.ts", "@effectory/sdk/services")
  );
  write(
    "node_modules/@effectory/sdk/package.json",
    JSON.stringify({
      exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
      name: "@effectory/sdk",
      type: "module",
      version: "0.1.0",
    })
  );
  write(
    "node_modules/@effectory/sdk/src/services.ts",
    'export const label = "Installed SDK";'
  );
  const first = fingerprintTask(workspace, entry);
  expect(first.installedSources).toContain(
    path.join(workspace, "node_modules/@effectory/sdk/src/services.ts")
  );
  const catalog = await loadTaskCatalog(workspace);
  expect(catalog[0]?.description).toBe("Installed SDK");
  write(
    "node_modules/@effectory/sdk/src/services.ts",
    'export const label = "Changed SDK";'
  );
  expect(fingerprintTask(workspace, entry).digest).not.toBe(first.digest);
  await expect(loadTaskCatalog(workspace)).rejects.toThrow(
    "restart the runner"
  );
});

test("isolated Effectory projects refuse dependencies inherited from the host", () => {
  const entry = write(
    ".effectory/automations/isolated/index.ts",
    'import "effect";'
  );
  write(".effectory/package.json", '{"type":"module"}');
  write(".effectory/tsconfig.json", "{}");
  write(".effectory/bun.lock", "isolated lock v1");
  expect(() => fingerprintTask(workspace, entry)).toThrow(
    "package is not installed locally: effect"
  );
});

test("runtime configuration and its transitive services participate in task revisions", async () => {
  const entrypoint = task();
  const original = fingerprintTask(workspace, entrypoint).digest;
  write(
    "runtime-services.ts",
    'import { Layer } from "effect"; export const services = Layer.empty;'
  );
  write(
    "effectory.config.ts",
    'import { services } from "./runtime-services.ts"; export default { services };'
  );
  const configured = fingerprintTask(workspace, entrypoint);
  expect(configured.digest).not.toBe(original);
  expect(configured.files).toContain("effectory.config.ts");
  expect(configured.files).toContain("runtime-services.ts");
  expect(await loadWorkspaceConfig(workspace)).toBeDefined();
  await loadTaskCatalog(workspace);
  write(
    "runtime-services.ts",
    'import { Layer } from "effect"; export const services = Layer.mergeAll(Layer.empty, Layer.empty);'
  );
  expect(fingerprintTask(workspace, entrypoint).digest).not.toBe(
    configured.digest
  );
  await expect(loadWorkspaceConfig(workspace)).rejects.toThrow(
    "restart the runner"
  );
  await expect(loadTaskCatalog(workspace)).rejects.toThrow(
    "restart the runner"
  );
});

test("configuration is optional and invalid exports fail even without automations", async () => {
  expect(await loadWorkspaceConfig(workspace)).toBeUndefined();
  write("effectory.config.ts", "export default { services: {} };");
  await expect(loadWorkspaceConfig(workspace)).rejects.toThrow(
    "Effectory.make"
  );
});

test("configuration source checks run before executing module top levels", async () => {
  write(
    "effectory.config.ts",
    'throw new Error("executed config"); const services = await import("effect"); export default { services };'
  );
  await expect(loadWorkspaceConfig(workspace)).rejects.toThrow(
    "dynamic import"
  );
});

test("control server loads workspace services for discovered automations", async () => {
  write(
    "runtime-services.ts",
    `
    import { Context } from "effect";
    export class Greeting extends Context.Service()("test/DiscoveredGreeting") {}
  `
  );
  write(
    "effectory.config.ts",
    `
    import { Layer } from "effect";
    import { Greeting } from "./runtime-services.ts";
    export default { services: Layer.succeed(Greeting, { text: "from configuration" }) };
  `
  );
  write(
    ".effectory/automations/configured/index.ts",
    `
    import { Effect, Schema } from "effect";
    import * as Workflow from "effect/workflow/Workflow";
    import { Greeting } from "../../../runtime-services.ts";
    const workflow = Workflow.make("DiscoveredConfigured", {
      payload: { key: Schema.String }, success: Schema.String,
      idempotencyKey: (input) => input.key,
    });
    export default {
      description: "Configured service", workflow,
      implementation: workflow.toLayer(() => Effect.map(Greeting, (greeting) => greeting.text)),
    };
  `
  );
  const server = await startControlServer(workspace);
  try {
    const run = await server.engine.submit({
      input: { key: "one" },
      requestKey: "one",
      task: "configured",
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Observe each persisted outcome before polling again.
      const current = await server.engine.inspectRun(run.id);
      if (current.status === "succeeded") {
        expect(current.result).toBe("from configuration");
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- Allow the workflow runner to execute.
      await Bun.sleep(25);
    }
    throw new Error("Configured automation did not complete");
  } finally {
    await server.close();
  }
});

const rootDefinition = (workflows = "[first]") => `
  import { Layer } from "effect";
  import first from "./flows/any-filename.ts";
  export default { services: Layer.empty, workflows: ${workflows} };
`;
const rootWorkflow = () =>
  write(
    "flows/any-filename.ts",
    `
  import { Effect, Schema } from "effect";
  import * as Workflow from "effect/workflow/Workflow";
  const workflow = Workflow.make("ExplicitWorkflow", {
    payload: { key: Schema.String }, success: Schema.String,
    idempotencyKey: (input) => input.key,
  });
  export default { name: "explicit", description: "Explicit registration", workflow,
    implementation: workflow.toLayer((input) => Effect.succeed(input.key)) };
`
  );

test("root entry point registers only listed workflows, independent of directory layout", async () => {
  rootWorkflow();
  write("effectory.run.ts", rootDefinition());
  write(
    ".effectory/automations/broken/index.ts",
    'throw new Error("unlisted module executed");'
  );
  const catalog = await loadTaskCatalog(workspace);
  expect(catalog.map((entry) => entry.name)).toEqual(["explicit"]);
  expect(catalog[0]?.fingerprint.files).toContain("flows/any-filename.ts");
  expect(catalog[0]?.fingerprint.files).not.toContain(
    ".effectory/automations/broken/index.ts"
  );
  const server = await startControlServer(workspace);
  try {
    expect(await server.engine.listRuns()).toEqual([]);
  } finally {
    await server.close();
  }
});

test.each([
  ["[first, first]", "Duplicate task name"],
  ['[first, { ...first, name: "second" }]', "Duplicate workflow tag"],
  ["[{ ...first, name: undefined }]", "lowercase kebab-case name"],
  ["{}", "workflows must be an array"],
] as const)(
  "root registration rejects invalid catalog: %s",
  async (workflows, error) => {
    rootWorkflow();
    write("effectory.run.ts", rootDefinition(workflows));
    await expect(loadTaskCatalog(workspace)).rejects.toThrow(error);
  }
);

test("an empty explicit catalog disables directory discovery", async () => {
  write(
    "effectory.run.ts",
    'import { Layer } from "effect"; export default { services: Layer.empty, workflows: [] };'
  );
  task();
  expect(await loadTaskCatalog(workspace)).toEqual([]);
});

test("ambiguous root entry points are refused before imports", async () => {
  write("effectory.run.ts", 'throw new Error("executed root");');
  write("effectory.config.ts", 'throw new Error("executed config");');
  await expect(loadTaskCatalog(workspace)).rejects.toThrow("not both");
});

test.each([
  ["factory.run.ts", "effectory.run.ts"],
  ["factory.config.ts", "effectory.config.ts"],
])(
  "a pre-rename %s is refused with a rename hint before imports",
  async (legacy, current) => {
    write(legacy, 'throw new Error("executed legacy root");');
    await expect(loadTaskCatalog(workspace)).rejects.toThrow(
      `Rename ${legacy} to ${current}`
    );
  }
);

test("changed root entry point is refused before module execution for unfinished runs", async () => {
  rootWorkflow();
  const entrypoint = write("effectory.run.ts", rootDefinition());
  const fingerprint = fingerprintTask(workspace, entrypoint);
  const local = new RuntimeStore(workspace);
  try {
    local.db
      .query("INSERT INTO effectory_runs(id,request_key,data) VALUES (?,?,?)")
      .run(
        "unfinished",
        "unfinished",
        JSON.stringify({
          id: "unfinished",
          revision: fingerprint.digest,
          status: "suspended",
          task: "explicit",
        })
      );
  } finally {
    local.close();
  }
  write("effectory.run.ts", 'throw new Error("executed changed entry point");');
  await expect(startControlServer(workspace)).rejects.toThrow(
    "Unfinished run unfinished"
  );
});
