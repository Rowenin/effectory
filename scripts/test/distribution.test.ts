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
