import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { until } from "../../packages/cli/test/fixtures/helpers.ts";
import { packageVersion } from "../pack.ts";

const root = path.resolve(import.meta.dir, "../..");
const version = packageVersion();

test.each(["local", "release"])(
  "%s tarballs run and recover with dependencies isolated from the host repo",
  async (mode) => {
    const directory = mkdtempSync(path.join(tmpdir(), "effectory-dist-"));
    const workspace = path.join(directory, "repo");
    const project = path.join(workspace, ".effectory");
    let server: ReturnType<typeof Bun.spawn> | undefined;
    const execute = async (
      args: string[],
      cwd = project,
      executable = process.execPath
    ) => {
      const child = Bun.spawn([executable, ...args], {
        cwd,
        env: { ...process.env, NO_COLOR: "1" },
        stderr: "pipe",
        stdout: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) {
        throw new Error(`${args.join(" ")}: ${code}\n${stdout}\n${stderr}`);
      }
      return stdout;
    };
    try {
      mkdirSync(workspace);
      // A non-Bun host with compiler aliases must not affect Effectory's project.
      const hostPackage = '{"name":"host","packageManager":"pnpm@10.0.0"}';
      writeFileSync(path.join(workspace, "package.json"), hostPackage);
      writeFileSync(
        path.join(workspace, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n"
      );
      writeFileSync(
        path.join(workspace, "tsconfig.json"),
        '{"extends":"missing-host-config","compilerOptions":{"paths":{"effect":["./missing.ts"]}}}'
      );
      mkdirSync(path.join(workspace, ".github/workflows"), { recursive: true });
      writeFileSync(
        path.join(workspace, ".github/workflows/ci.yml"),
        "name: Host CI\n"
      );
      const hostFiles = [
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json",
        ".github/workflows/ci.yml",
      ];
      const hostContents = hostFiles.map((file) =>
        readFileSync(path.join(workspace, file), "utf-8")
      );
      if (mode === "local") {
        await execute(
          [
            path.join(root, "packages/cli/src/main.ts"),
            "init",
            "--workspace",
            workspace,
          ],
          workspace
        );
        await execute([path.join(root, "scripts/dogfood.ts"), workspace], root);
      } else {
        await execute(
          [path.join(root, "scripts/release.ts"), `v${version}`],
          root
        );
        const unpack = Bun.spawnSync([
          "tar",
          "-xzf",
          path.join(root, `dist/effectory-v${version}.tar.gz`),
          "-C",
          directory,
        ]);
        expect(unpack.exitCode).toBe(0);
        const bundle = path.join(directory, `effectory-v${version}`);
        const sdk = path.join(bundle, `effectory-sdk-${version}.tgz`);
        const original = readFileSync(sdk);
        writeFileSync(sdk, Buffer.concat([original, Buffer.from("corrupt")]));
        await expect(
          execute(["install.ts", workspace], bundle)
        ).rejects.toThrow("Checksum mismatch");
        expect(existsSync(project)).toBe(false);
        writeFileSync(sdk, original);
        await execute(["install.ts", workspace], bundle);
      }
      expect(existsSync(path.join(project, "tsconfig.json"))).toBe(true);
      expect(readFileSync(path.join(workspace, "package.json"), "utf-8")).toBe(
        hostPackage
      );
      expect(existsSync(path.join(workspace, "bun.lock"))).toBe(false);
      expect(existsSync(path.join(workspace, "node_modules"))).toBe(false);
      expect(existsSync(path.join(project, "bun.lock"))).toBe(true);
      // A conflicting host Effect and compiler alias must never supply runtime code.
      const hostEffect = path.join(workspace, "node_modules/effect");
      mkdirSync(hostEffect, { recursive: true });
      writeFileSync(
        path.join(hostEffect, "package.json"),
        '{"name":"effect","version":"0.0.0-host","type":"module","exports":"./index.ts"}'
      );
      writeFileSync(
        path.join(hostEffect, "index.ts"),
        'throw new Error("host Effect must not execute"); export const Layer = "host";'
      );
      writeFileSync(
        path.join(workspace, "missing.ts"),
        'throw new Error("host compiler alias must not execute"); export const Layer = "host alias";'
      );
      const cli = path.join(project, "node_modules/.bin/effectory");
      const command = async (...args: string[]) =>
        JSON.parse(await execute(args, workspace, cli));
      const automation = path.join(project, "automations/dogfood");
      mkdirSync(automation, { recursive: true });
      writeFileSync(
        path.join(automation, "index.ts"),
        `
import { Automation, Task } from "@effectory/sdk";
import { Process } from "@effectory/activities";
import { Effect, Schema } from "effect";
const command = Task.make({ name: "command", input: Process.Input, success: Process.Result, error: Process.Failure, run: Process.exec });
export default Automation.define({
  name: "dogfood", description: "External installed automation",
  input: Schema.Struct({ requestId: Schema.String }), success: Schema.String, error: Process.Failure,
  idempotencyKey: (input) => input.requestId,
  execute: () => Effect.gen(function* () {
    const result = yield* command({ command: process.execPath, args: ["--eval", "console.log('external')"] }, { key: "external-process" });
    yield* Automation.publish("report", { schema: Schema.String, value: result.stdout.trim() });
    yield* Automation.approve({ key: "review", title: "Review external run", review: { value: "external" } });
    return result.stdout.trim();
  }).pipe(Effect.provide(Process.layer)),
});
`
      );
      const hello = path.join(project, "automations/hello");
      mkdirSync(hello, { recursive: true });
      writeFileSync(
        path.join(hello, "index.ts"),
        `
import { Task, Workflow } from "@effectory/sdk";
import { Effect, Schema } from "effect";
const greet = Task.make({ name: "greet", input: Schema.Struct({ requestId: Schema.String }), success: Schema.String, error: Schema.Never,
  run: ({ requestId }) => Effect.succeed("hello " + requestId) });
export default Workflow.make("hello", {
  description: "Root registration smoke test", input: Schema.Struct({ requestId: Schema.String }), key: ($) => $.input.requestId,
}).pipe(Workflow.step("greeting", greet, ($) => ({ requestId: $.input.requestId })), Workflow.returns(Schema.String, ($) => $.steps.greeting));
`
      );
      writeFileSync(
        path.join(workspace, "effectory.run.ts"),
        `
import { Effectory } from "@effectory/sdk";
import hello from "./.effectory/automations/hello/index.ts";
export default Effectory.make({ workflows: [hello] });
`
      );
      // Exercise local sessions from the host root before starting a persistent runner.
      const listed = await command("workflow", "list", "--json");
      expect(listed.map((item: { name: string }) => item.name)).toEqual([
        "hello",
      ]);
      const described = await command(
        "workflow",
        "describe",
        "hello",
        "--json"
      );
      expect(described.name).toBe("hello");
      writeFileSync(path.join(hello, "inputs.json"), '{"requestId":"smoke-1"}');
      const smoke = await command(
        "workflow",
        "run",
        "hello",
        "--input",
        ".effectory/automations/hello/inputs.json",
        "--request-key",
        "smoke-1"
      );
      expect(smoke.status).toBe("succeeded");
      expect(smoke.result).toBe("hello smoke-1");
      const runs = await command("run", "list");
      expect(runs.some((item: { id: string }) => item.id === smoke.id)).toBe(
        true
      );
      // Ordinary host imports retain their own resolver in the same process.
      const hostImport = path.join(workspace, "host-import.ts");
      writeFileSync(
        hostImport,
        'import { Layer } from "effect"; export default Layer;'
      );
      const runtimeTasks = path.join(
        project,
        "node_modules/@effectory/runtime/src/tasks.ts"
      );
      await execute([
        "--eval",
        `
const { loadWorkspaceConfig } = await import(${JSON.stringify(runtimeTasks)});
const config = await loadWorkspaceConfig(${JSON.stringify(workspace)});
if (config !== await loadWorkspaceConfig(${JSON.stringify(workspace)})) throw new Error("Registration identity changed");
try {
  await import(${JSON.stringify(hostImport)});
  throw new Error("Host alias was bypassed");
} catch (error) {
  if (!String(error).includes("host compiler alias must not execute")) throw error;
}
`,
      ]);
      // Also exercise explicit services and a root Effect import, against the
      // conflicting host Effect and alias, during persistent-runner recovery.
      writeFileSync(
        path.join(workspace, "effectory.run.ts"),
        `
import { Effectory } from "@effectory/sdk";
import { Layer } from "effect";
import dogfood from "./.effectory/automations/dogfood/index.ts";
import hello from "./.effectory/automations/hello/index.ts";
export default Effectory.make({ services: Layer.empty, workflows: [dogfood, hello] });
`
      );
      const start = async () => {
        const child = Bun.spawn([cli, "serve"], {
          cwd: workspace,
          stderr: "pipe",
          stdout: "pipe",
        });
        server = child;
        const reader = child.stdout.getReader();
        const ready = await reader.read();
        expect(new TextDecoder().decode(ready.value)).toContain('"ready"');
        reader.releaseLock();
      };
      const stop = async () => {
        if (!server) {
          throw new Error("Runner is not started");
        }
        server.kill("SIGTERM");
        expect([0, 130]).toContain(await server.exited);
        server = undefined;
      };
      await start();
      const tasks = await command("workflow", "list", "--json");
      expect(tasks[0].name).toBe("dogfood");
      const input = path.join(project, "input.json");
      writeFileSync(input, '{"requestId":"external-1"}');
      const run = await command(
        "workflow",
        "run",
        "dogfood",
        "--input",
        input,
        "--request-key",
        "external-1"
      );
      const gates = await until(
        "external approval",
        () => command("approval", "list"),
        (items) => items.length === 1
      );
      expect(await command("artifact", "list", "--run", run.id)).toHaveLength(
        1
      );
      await stop();
      await start();
      const gate = await command("approval", "inspect", gates[0].id);
      await command(
        "approval",
        "approve",
        gate.id,
        "--digest",
        gate.digest,
        "--revision",
        gate.revision
      );
      const paused = await command("run", "inspect", run.id);
      expect(paused.status).toBe("suspended");
      await command("run", "resume", run.id);
      const completed = await until(
        "external completion",
        () => command("run", "inspect", run.id),
        (item) => item.status === "succeeded"
      );
      expect(completed.result).toBe("external");
      const replay = await command(
        "workflow",
        "run",
        "dogfood",
        "--input",
        input,
        "--request-key",
        "external-1"
      );
      expect(replay.id).toBe(run.id);
      await stop();
      expect(
        hostFiles.map((file) =>
          readFileSync(path.join(workspace, file), "utf-8")
        )
      ).toEqual(hostContents);
      expect(existsSync(path.join(workspace, "bun.lock"))).toBe(false);
      expect(existsSync(path.join(workspace, "node_modules/@effectory"))).toBe(
        false
      );
    } finally {
      server?.kill("SIGKILL");
      if (server) {
        await server.exited;
      }
      rmSync(directory, { force: true, recursive: true });
    }
  },
  120_000
);
