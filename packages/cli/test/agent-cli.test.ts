import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const main = path.resolve(import.meta.dir, "../src/main.ts");
test("agent CLI selects harnesses, returns status and conflict exit codes, and never starts a daemon", () => {
  const root = mkdtempSync(path.join(tmpdir(), "effectory-agent-cli-"));
  const cli = (...args: string[]) =>
    Bun.spawnSync([
      process.execPath,
      main,
      ...args,
      "--repository",
      root,
      "--json",
    ]);
  try {
    expect(cli("init", root).exitCode).toBe(0);
    expect(cli("agent", "status").exitCode).toBe(1);
    expect(
      cli(
        "agent",
        "setup",
        "--harness",
        "codex",
        "--harness",
        "claude-code",
        "--dry-run"
      ).exitCode
    ).toBe(0);
    expect(existsSync(path.join(root, ".effectory/agent-setup"))).toBe(false);
    expect(cli("agent", "setup").exitCode).toBe(2);
    const setup = cli(
      "agent",
      "setup",
      "--harness",
      "codex",
      "--harness",
      "claude-code"
    );
    expect(setup.exitCode).toBe(0);
    expect(JSON.parse(setup.stdout.toString()).harnesses).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(cli("agent", "status").exitCode).toBe(0);
    expect(cli("agent", "setup").exitCode).toBe(0);
    const skill = path.join(root, ".agents/skills/effectory-build/SKILL.md");
    writeFileSync(skill, "user edit");
    expect(cli("agent", "status").exitCode).toBe(1);
    const conflict = cli("agent", "remove", "--harness", "codex", "--dry-run");
    expect(conflict.exitCode).toBe(5);
    expect(conflict.stderr.toString()).toContain("SKILL.md");
    rmSync(skill);
    expect(cli("agent", "setup").exitCode).toBe(0);
    expect(cli("agent", "remove", "--harness", "codex").exitCode).toBe(0);
    expect(cli("agent", "remove", "--harness", "claude-code").exitCode).toBe(0);
    expect(existsSync(path.join(root, ".effectory/state.sqlite"))).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}, 60_000);
