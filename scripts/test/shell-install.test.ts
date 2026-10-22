import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { until } from "../../packages/cli/test/fixtures/helpers.ts";
import { packageVersion } from "../pack.ts";

const root = path.resolve(import.meta.dir, "../..");

test("shell installer exposes the CLI across repositories, reuses releases, and refuses corrupted downloads", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "effectory-shell-"));
  const assets = path.join(directory, "assets");
  const fakeBin = path.join(directory, "fake-bin");
  const installDirectory = path.join(directory, "data's $cache");
  const binDirectory = path.join(directory, "bin with spaces");
  const workspace = path.join(directory, "repo");
  const other = path.join(directory, "other");
  let server: ReturnType<typeof Bun.spawn> | undefined;
  const version = packageVersion();
  const archive = `effectory-v${version}.tar.gz`;
  const execute = async (args: string[], cwd = directory) => {
    const child = Bun.spawn(args, {
      cwd,
      env: {
        ...process.env,
        EFFECTORY_TEST_ASSETS: assets,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
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
    for (const name of [assets, fakeBin, workspace, other]) {
      mkdirSync(name);
    }
    await execute(
      [process.execPath, "scripts/release.ts", `v${version}`],
      root
    );
    for (const name of [archive, "SHA256SUMS", "install.sh"]) {
      copyFileSync(path.join(root, "dist", name), path.join(assets, name));
    }
    // Exercise the actual shell download path without credentials in CI. The
    // transport returns the same generated release files as gh release download.
    writeFileSync(
      path.join(fakeBin, "gh"),
      `#!/usr/bin/env bun
import { copyFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] !== "release" || args[1] !== "download") process.exit(1);
const destination = args[args.indexOf("--dir") + 1];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--pattern") {
    const name = args[++i];
    copyFileSync(path.join(process.env.EFFECTORY_TEST_ASSETS, name), path.join(destination, name));
  }
}
`,
      { mode: 0o755 }
    );
    const hostPackage = '{"name":"host","packageManager":"pnpm@10.0.0"}';
    writeFileSync(path.join(workspace, "package.json"), hostPackage);
    const args = [
      "sh",
      path.join(assets, "install.sh"),
      "--install-dir",
      installDirectory,
      "--bin-dir",
      binDirectory,
    ];
    await execute([...args, "--workspace", workspace]);
    const cli = path.join(binDirectory, "effectory");
    expect(await execute([cli, "--version"], other)).toContain(
      `effectory v${version}`
    );
    expect(readFileSync(path.join(workspace, "package.json"), "utf-8")).toBe(
      hostPackage
    );
    expect(
      JSON.parse(
        readFileSync(path.join(workspace, ".effectory/package.json"), "utf-8")
      ).dependencies["@effectory/sdk"]
    ).toContain(version);
    const automation = path.join(
      workspace,
      ".effectory/automations/global-cli"
    );
    mkdirSync(automation, { recursive: true });
    writeFileSync(
      path.join(automation, "index.ts"),
      `
import { Automation } from "@effectory/sdk";
import { Effect, Schema } from "effect";
export default Automation.define({
  name: "global-cli", description: "Exercise the global CLI with a workspace SDK",
  input: Schema.Struct({ requestId: Schema.String }), error: Schema.String,
  success: Schema.String, idempotencyKey: (input) => input.requestId,
  execute: () => Effect.gen(function* () {
    yield* Automation.publish("report", { schema: Schema.String, value: "global" });
    return "global";
  }),
});
`
    );
    const child = Bun.spawn([cli, "serve", "--workspace", workspace], {
      cwd: other,
      stderr: "pipe",
      stdout: "pipe",
    });
    server = child;
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain('"ready"');
    reader.releaseLock();
    const input = path.join(workspace, "input.json");
    writeFileSync(input, '{"requestId":"global-test"}');
    const run = JSON.parse(
      await execute(
        [cli, "workflow", "run", "global-cli", "--input", input],
        workspace
      )
    );
    const result = await until(
      "global CLI result",
      async () =>
        JSON.parse(await execute([cli, "run", "inspect", run.id], workspace)),
      (item) => item.status === "succeeded"
    );
    expect(result.result).toBe("global");
    expect(
      JSON.parse(
        await execute([cli, "artifact", "list", "--run", run.id], workspace)
      )
    ).toHaveLength(1);
    child.kill("SIGTERM");
    expect([0, 130]).toContain(await child.exited);
    server = undefined;
    await execute([cli, "init"], other);
    expect(
      JSON.parse(
        readFileSync(path.join(other, ".effectory/workspace.json"), "utf-8")
      ).project
    ).toBe(".effectory");
    await execute(args);
    expect(readdirSync(installDirectory)).toHaveLength(1);
    const originalWrapper = readFileSync(cli, "utf-8");
    const source = path.join(assets, archive);
    writeFileSync(
      source,
      Buffer.concat([readFileSync(source), Buffer.from("corrupt")])
    );
    await expect(execute(args)).rejects.toThrow(
      "Release archive checksum mismatch"
    );
    expect(readFileSync(cli, "utf-8")).toBe(originalWrapper);
    expect(await execute([cli, "--version"], workspace)).toContain(
      `effectory v${version}`
    );
  } finally {
    server?.kill("SIGKILL");
    if (server) {
      await server.exited;
    }
    rmSync(directory, { force: true, recursive: true });
  }
}, 120_000);
