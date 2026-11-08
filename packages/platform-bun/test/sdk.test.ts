import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { hostVersions } from "../src/host-runtime.ts";
import {
  initProject,
  projectStatus,
  projectWarning,
  sdkSpecifier,
  upgradeProject,
} from "../src/sdk.ts";

test("projects install the SDK from the matching GitHub release", () => {
  const version = hostVersions["@offtree/effectory-sdk"];
  expect(sdkSpecifier("@offtree/effectory-sdk")).toBe(
    `https://github.com/Rowenin/effectory/releases/download/v${version}/offtree-effectory-sdk-${version}.tgz`
  );
  expect(sdkSpecifier("effect")).toBe(hostVersions.effect);
});

const version = "1.2.3";

async function withDirectory(body: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-sdk-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
async function install(directory: string, name: string, installed: string) {
  const target = path.join(directory, "node_modules", name);
  await mkdir(target, { recursive: true });
  await writeFile(
    path.join(target, "package.json"),
    JSON.stringify({ name, version: installed })
  );
}
const readJson = async (filename: string) =>
  JSON.parse(await readFile(filename, "utf-8")) as Record<string, unknown>;

test("status compares the recorded version and nearest installed SDK with the host", async () => {
  await withDirectory(async (directory) => {
    const project = path.join(directory, "apps", "automation");
    await mkdir(project, { recursive: true });
    const missing = await Effect.runPromise(projectStatus(project, version));
    expect(missing.ok).toBe(false);
    expect(missing.project).toEqual({
      host: version,
      recorded: null,
      status: "Missing",
    });
    expect(missing.packages.map((pkg) => pkg.status)).toEqual([
      "Missing",
      "Missing",
    ]);
    expect(projectWarning(missing)).toContain("no recorded Effectory version");

    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify({ effectory: { version: "1.0.0" } })
    );
    // Hoisted to a workspace root, as package managers do.
    await install(
      directory,
      "@offtree/effectory-sdk",
      hostVersions["@offtree/effectory-sdk"]
    );
    await install(directory, "effect", "4.0.0");
    const mismatch = await Effect.runPromise(projectStatus(project, version));
    expect(mismatch.project.status).toBe("Mismatch");
    expect(
      Object.fromEntries(mismatch.packages.map((pkg) => [pkg.name, pkg.status]))
    ).toEqual({ "@offtree/effectory-sdk": "Match", effect: "Mismatch" });
    const warning = projectWarning(mismatch);
    expect(warning).toContain("set up with Effectory 1.0.0, this is 1.2.3");
    expect(warning).toContain(
      `effect 4.0.0 differs from host ${hostVersions.effect}`
    );
    expect(warning).toContain("effectory upgrade");

    await install(project, "effect", hostVersions.effect);
    await Effect.runPromise(upgradeProject(project, version));
    const matched = await Effect.runPromise(projectStatus(project, version));
    expect(matched.ok).toBe(true);
    expect(projectWarning(matched)).toBeNull();
  });
});

test("upgrade records the version and pins exact SDK versions in place", async () => {
  await withDirectory(async (directory) => {
    const filename = path.join(directory, "package.json");
    await writeFile(
      filename,
      JSON.stringify({
        dependencies: { effect: "^4.0.0", zod: "4.0.0" },
        effectory: { note: "kept", version: "1.0.0" },
        name: "existing",
        scripts: { test: "bun test" },
      })
    );
    const first = await Effect.runPromise(upgradeProject(directory, version));
    expect(first).toMatchObject({
      created: false,
      previousVersion: "1.0.0",
      version,
    });
    expect(first.changes).toEqual([
      {
        from: null,
        name: "@offtree/effectory-sdk",
        to: sdkSpecifier("@offtree/effectory-sdk"),
      },
      { from: "^4.0.0", name: "effect", to: hostVersions.effect },
    ]);
    expect(await readJson(filename)).toEqual({
      dependencies: { effect: hostVersions.effect, zod: "4.0.0" },
      devDependencies: {
        "@offtree/effectory-sdk": sdkSpecifier("@offtree/effectory-sdk"),
      },
      effectory: { note: "kept", version },
      name: "existing",
      scripts: { test: "bun test" },
    });
    const second = await Effect.runPromise(upgradeProject(directory, version));
    expect(second.changes).toEqual([]);
    expect(second.next).toBeNull();
    expect(second.previousVersion).toBe(version);
  });
});

test("init scaffolds a project without replacing existing files", async () => {
  await withDirectory(async (directory) => {
    const project = path.join(directory, "new-project");
    const first = await Effect.runPromise(initProject(project, version));
    expect(first.written).toEqual([
      "effectory.ts",
      "tsconfig.json",
      ".gitignore",
    ]);
    expect(first.upgrade).toMatchObject({
      created: true,
      previousVersion: null,
    });
    const manifest = await readJson(path.join(project, "package.json"));
    expect(manifest.effectory).toEqual({ version });
    expect(
      await readFile(path.join(project, "effectory.ts"), "utf-8")
    ).toContain('from "@offtree/effectory-sdk"');
    expect(await readFile(path.join(project, ".gitignore"), "utf-8")).toBe(
      ".effectory/\nnode_modules/\n"
    );

    await writeFile(path.join(project, "effectory.ts"), "// mine\n");
    await writeFile(path.join(project, ".gitignore"), "dist");
    const second = await Effect.runPromise(initProject(project, version));
    expect(second.kept).toEqual(["effectory.ts", "tsconfig.json"]);
    expect(await readFile(path.join(project, "effectory.ts"), "utf-8")).toBe(
      "// mine\n"
    );
    expect(await readFile(path.join(project, ".gitignore"), "utf-8")).toBe(
      "dist\n.effectory/\nnode_modules/\n"
    );
  });
});
