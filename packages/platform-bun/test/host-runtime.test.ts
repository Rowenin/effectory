import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Task } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

import { hostModuleLoaders } from "../src/host-modules.generated.ts";
import {
  compiled,
  hostAbi,
  installHostModules,
  selfCommand,
  sourceAbi,
} from "../src/host-runtime.ts";

const workspace = path.resolve(import.meta.dir, "../../..");

test("the generated host module table matches the installed effect and SDK", () => {
  const result = Bun.spawnSync(
    [process.execPath, "scripts/generate-host-modules.ts", "--check"],
    { cwd: workspace, stderr: "pipe" }
  );
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  for (const specifier of [
    "effect",
    "effect/Effect",
    "effect/Schema",
    "effect/cli",
    "effect/cli/Command",
    "@offtree/effectory-sdk",
    "@offtree/effectory-sdk/Task",
  ]) {
    expect(Object.hasOwn(hostModuleLoaders, specifier)).toBe(true);
  }
  expect(
    Object.keys(hostModuleLoaders).some(
      (name) => name.startsWith("effect/") && name.includes("/internal/")
    )
  ).toBe(false);
});

test("modules loaded from outside any node_modules share the host's instances", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-host-"));
  try {
    const filename = path.join(directory, "application.mjs");
    await writeFile(
      filename,
      [
        'import { Effect, Schema } from "effect";',
        'import * as Direct from "effect/Effect";',
        'import { Task } from "@offtree/effectory-sdk";',
        "export { Direct, Effect, Schema, Task };",
      ].join("\n")
    );
    installHostModules();
    installHostModules();
    const loaded = (await import(pathToFileURL(filename).href)) as {
      Direct: { succeed: unknown };
      Effect: { succeed: unknown };
      Schema: { String: unknown };
      Task: { make: unknown };
    };
    expect(loaded.Effect.succeed).toBe(Effect.succeed);
    expect(loaded.Direct.succeed).toBe(Effect.succeed);
    expect(loaded.Schema.String).toBe(Schema.String);
    expect(loaded.Task.make).toBe(Task.make);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("source runs hash their sources and re-enter through the script", () => {
  expect(compiled).toBe(false);
  expect(hostAbi()).toBe(sourceAbi());
  expect(hostAbi()).toMatch(/^[a-f0-9]{64}$/u);
  expect(selfCommand("/cli.ts", ["daemon", "serve"])).toEqual([
    process.execPath,
    "/cli.ts",
    "daemon",
    "serve",
  ]);
});
