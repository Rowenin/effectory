import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

const Built = Schema.Struct({
  abi: Schema.String,
  built: Schema.Array(Schema.Struct({ file: Schema.String })),
});
const Version = Schema.Record(Schema.String, Schema.Unknown);
const AgentStatus = Schema.Struct({ healthy: Schema.Boolean });
const RunResult = Schema.Struct({
  result: Schema.Unknown,
  status: Schema.String,
});

const workspace = path.resolve(import.meta.dir, "../../..");

function run(command: readonly string[], cwd: string) {
  const result = Bun.spawnSync([...command], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} exited ${result.exitCode}: ${result.stderr.toString()}`
    );
  }
  return { stderr: result.stderr.toString(), stdout: result.stdout.toString() };
}

test("a compiled binary runs a project that has no node_modules", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-binary-"));
  const project = path.join(directory, "project");
  let binary = "";
  try {
    const built = Schema.decodeUnknownSync(Built)(
      JSON.parse(
        run(
          [
            process.execPath,
            "scripts/build-binary.ts",
            "--outdir",
            path.join(directory, "bin"),
          ],
          workspace
        ).stdout
      )
    );
    binary = built.built[0]?.file ?? "";
    const cli = (...args: string[]) =>
      run([binary, ...args, "--repository", project, "--json"], directory);

    const version = Schema.decodeUnknownSync(Version)(
      JSON.parse(cli("version").stdout)
    );
    expect(version.compiled).toBe(true);
    // The binary carries the ABI of the sources it was built from, so a
    // repository can move between source runs and the binary.
    expect(version.abi).toBe(built.abi);

    // Positional path, as in `swamp repo init ./my-project`.
    run([binary, "init", project, "--json"], directory);
    cli("agent", "setup", "--harness", "codex", "--harness", "claude-code");
    const agent = Schema.decodeUnknownSync(AgentStatus)(
      JSON.parse(cli("agent", "status").stdout)
    );
    expect(agent.healthy).toBe(true);
    expect(
      readFileSync(
        path.join(project, ".agents/skills/effectory-build/SKILL.md"),
        "utf-8"
      )
    ).toBe(
      readFileSync(
        path.join(workspace, "packages/cli/assets/effectory-build/SKILL.md"),
        "utf-8"
      )
    );
    const started = cli("daemon", "start");
    expect(started.stderr).toContain("@offtree/effectory-sdk is not installed");
    const result = Schema.decodeUnknownSync(RunResult)(
      JSON.parse(
        cli("workflow", "run", "hello/run", "--input", '{"name":"Ada"}').stdout
      )
    );
    expect(result).toMatchObject({ result: "Hello Ada", status: "Succeeded" });
    expect(existsSync(path.join(project, "node_modules"))).toBe(false);
    expect(existsSync(path.join(project, ".effectory", "node_modules"))).toBe(
      false
    );
  } finally {
    if (binary !== "" && existsSync(path.join(project, ".effectory"))) {
      Bun.spawnSync([
        binary,
        "daemon",
        "stop",
        "--repository",
        project,
        "--json",
      ]);
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 180_000);
