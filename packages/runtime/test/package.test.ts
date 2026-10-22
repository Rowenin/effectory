import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { requestControl, startRuntime } from "@effectory/runtime";
import { workspacePaths } from "@effectory/runtime/paths";
import { Effect } from "effect";

test("runtime starts without a CLI, arbitrates ownership, and releases its socket on close", async () => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), "effectory-runtime-package-")
  );
  let runtime = await startRuntime(workspace);
  try {
    expect(existsSync(path.join(workspace, ".effectory/workspace.json"))).toBe(
      true
    );
    expect(existsSync(runtime.socket)).toBe(true);
    expect(existsSync(workspacePaths(workspace).database)).toBe(true);
    expect(existsSync(workspacePaths(workspace).legacyDatabase)).toBe(false);
    expect(existsSync(path.join(workspace, "automation"))).toBe(false);
    expect(existsSync(path.join(workspace, ".automation"))).toBe(false);
    expect(await runtime.engine.listRuns()).toEqual([]);
    expect(
      await Effect.runPromise(
        requestControl(workspace, { method: "task.list" })
      )
    ).toEqual([]);
    await expect(startRuntime(workspace)).rejects.toThrow(/owner|owned/iu);
    expect(await runtime.engine.listRuns()).toEqual([]);
    await runtime.close();
    expect(existsSync(runtime.socket)).toBe(false);
    await expect(
      Effect.runPromise(requestControl(workspace, { method: "run.list" }))
    ).rejects.toThrow("Cannot reach");
    runtime = await startRuntime(workspace);
    expect(
      await Effect.runPromise(requestControl(workspace, { method: "run.list" }))
    ).toEqual([]);
  } finally {
    await runtime.close();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("CLI initialization preserves existing markers and refuses incompatible versions before starting an engine", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "effectory-init-"));
  const cli = path.resolve(import.meta.dir, "../../cli/src/main.ts");
  const initialize = () =>
    Bun.spawnSync([process.execPath, cli, "init", "--workspace", workspace], {
      env: { ...process.env, EFFECTORY_URL: "http://127.0.0.1:1" },
      timeout: 10_000,
    });
  const marker = path.join(workspace, ".effectory/workspace.json");
  try {
    expect(initialize().exitCode).toBe(0);
    const projectPackage = path.join(workspace, ".effectory/package.json");
    const projectConfig = path.join(workspace, ".effectory/tsconfig.json");
    expect(existsSync(projectPackage)).toBe(true);
    expect(existsSync(projectConfig)).toBe(true);
    const customized = '{"private":true,"description":"preserve dependencies"}';
    writeFileSync(projectPackage, customized);
    expect(initialize().exitCode).toBe(0);
    expect(readFileSync(projectPackage, "utf-8")).toBe(customized);
    const existing = '{"version":1,"note":"preserve"}';
    writeFileSync(marker, existing);
    expect(initialize().exitCode).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe(existing);
    const incompatible = '{"version":2,"note":"preserve"}';
    writeFileSync(marker, incompatible);
    expect(initialize().exitCode).not.toBe(0);
    await expect(startRuntime(workspace)).rejects.toThrow();
    expect(readFileSync(marker, "utf-8")).toBe(incompatible);
    expect(existsSync(workspacePaths(workspace).database)).toBe(false);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});
