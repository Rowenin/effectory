import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { hostVersions } from "../../platform-bun/src/host-runtime.ts";
import { initProject } from "../../platform-bun/src/sdk.ts";
import { agentMutation, agentStatus } from "../src/agent-files.ts";
import { manifestPath, planSetup } from "../src/agent-plan.ts";

async function fixture(body: (root: string) => Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), "effectory-agent-test-"));
  try {
    await Effect.runPromise(initProject(root, "0.1.0"));
    await body(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
const setup = (root: string, dry = false) =>
  Effect.runPromise(
    agentMutation(root, "0.1.0", "setup", ["codex", "claude-code"], dry)
  );

test("real setup is offline, dry-run is nonmutating, clones update and removals preserve user content", () =>
  fixture(async (root) => {
    writeFileSync(path.join(root, "AGENTS.md"), "personal\r\n");
    const before = readdirSync(root).toSorted();
    await setup(root, true);
    expect(readdirSync(root).toSorted()).toEqual(before);
    expect(existsSync(path.join(root, ".effectory/agent-setup"))).toBe(false);
    await setup(root);
    const status = await Effect.runPromise(agentStatus(root, "0.1.0"));
    expect(status.healthy).toBe(true);
    const repeated = await setup(root);
    expect(repeated.actions.every((item) => item.action === "unchanged")).toBe(
      true
    );
    writeFileSync(
      path.join(root, ".agents/skills/effectory-build/personal.md"),
      "user"
    );
    const clone = `${root}-clone`;
    try {
      cpSync(root, clone, { recursive: true });
      const cloned = await setup(clone);
      expect(cloned.actions.every((item) => item.action === "unchanged")).toBe(
        true
      );
      await Effect.runPromise(
        agentMutation(clone, "0.1.0", "remove", ["codex"], false)
      );
      expect(readFileSync(path.join(clone, "AGENTS.md"), "utf-8")).toBe(
        "personal\r\n"
      );
      expect(
        readFileSync(
          path.join(clone, ".agents/skills/effectory-build/personal.md"),
          "utf-8"
        )
      ).toBe("user");
    } finally {
      rmSync(clone, { force: true, recursive: true });
    }
  }));

test("edits, symlinks and hardlinks refuse mutation and preserve original content", () =>
  fixture(async (root) => {
    await setup(root);
    const skill = path.join(root, ".agents/skills/effectory-build/SKILL.md");
    writeFileSync(skill, "edited");
    await expect(setup(root)).rejects.toThrow("Modified");
    expect(readFileSync(skill, "utf-8")).toBe("edited");
    rmSync(skill);
    const outside = path.join(root, "unmanaged.txt");
    writeFileSync(outside, "untouched");
    symlinkSync(outside, skill);
    await expect(setup(root)).rejects.toThrow("Linked");
    rmSync(skill);
    linkSync(outside, skill);
    await expect(setup(root)).rejects.toThrow("Linked");
    expect(readFileSync(outside, "utf-8")).toBe("untouched");
  }));

test("recorded operation recovers after a partial write and refuses conflicting intervening edits", () =>
  fixture(async (root) => {
    const plan = planSetup({
      hostVersion: "0.1.0",
      mode: "setup",
      sdkVersions: hostVersions,
      selected: ["codex"],
      snapshot: {},
    });
    const directory = path.join(root, ".effectory/agent-setup");
    mkdirSync(directory, { recursive: true });
    const journal = {
      actions: plan.actions.map(({ path: name, before, after }) => ({
        after,
        before,
        path: name,
      })),
      format: 1,
      transaction: crypto.randomUUID(),
    };
    writeFileSync(
      path.join(directory, "journal.json"),
      JSON.stringify(journal)
    );
    const [first] = plan.actions;
    if (!first?.after) {
      throw new Error("Missing first action");
    }
    mkdirSync(path.dirname(path.join(root, first.path)), { recursive: true });
    writeFileSync(path.join(root, first.path), "new user edit");
    await expect(setup(root)).rejects.toThrow("recovery conflicts");
    expect(existsSync(path.join(root, manifestPath))).toBe(false);
    writeFileSync(path.join(root, first.path), first.after);
    writeFileSync(
      path.join(root, `${first.path}.effectory-${journal.transaction}.tmp`),
      Buffer.from([0xff])
    );
    await setup(root);
    expect(existsSync(path.join(directory, "journal.json"))).toBe(false);
    const status = await Effect.runPromise(agentStatus(root, "0.1.0"));
    expect(status.healthy).toBe(true);
  }));

test("only selected harness paths matter, overrides migrate, and status isolates modified files", () =>
  fixture(async (root) => {
    symlinkSync("/does-not-exist", path.join(root, ".claude"));
    const codex = () =>
      Effect.runPromise(
        agentMutation(root, "0.1.0", "setup", ["codex"], false)
      );
    writeFileSync(path.join(root, "AGENTS.md"), "\uFEFFpersonal\r\n");
    await codex();
    writeFileSync(path.join(root, "AGENTS.override.md"), "override\r\n");
    const shadowed = await Effect.runPromise(agentStatus(root, "0.1.0"));
    expect(shadowed.paths).toContainEqual({
      path: "AGENTS.md",
      state: "shadowed",
    });
    await codex();
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf-8")).toBe(
      "\uFEFFpersonal\r\n"
    );
    const skill = ".agents/skills/effectory-build/SKILL.md";
    writeFileSync(path.join(root, skill), "edited");
    const modified = await Effect.runPromise(agentStatus(root, "0.1.0"));
    expect(modified.paths).toContainEqual({ path: skill, state: "modified" });
    expect(modified.paths).toContainEqual({
      path: "AGENTS.override.md",
      state: "current",
    });
    rmSync(path.join(root, skill));
    await codex();
    const repaired = await Effect.runPromise(agentStatus(root, "0.1.0"));
    expect(repaired.healthy).toBe(true);
  }));

test("invalid manifests, encodings, pins and linked roots fail without replacing content", () =>
  fixture(async (root) => {
    const link = `${root}-link`;
    symlinkSync(root, link);
    try {
      await expect(setup(link)).rejects.toThrow("symlinked repository");
    } finally {
      rmSync(link);
    }
    writeFileSync(path.join(root, "AGENTS.md"), Buffer.from([0xff]));
    await expect(setup(root)).rejects.toThrow(/UTF/u);
    expect(readFileSync(path.join(root, "AGENTS.md"))).toEqual(
      Buffer.from([0xff])
    );
    rmSync(path.join(root, "AGENTS.md"));
    writeFileSync(path.join(root, manifestPath), "{}");
    const corrupt = await Effect.runPromise(agentStatus(root, "0.1.0"));
    expect(corrupt.healthy).toBe(false);
    expect(corrupt.paths).toContainEqual({
      path: manifestPath,
      state: "conflicting",
    });
    await expect(setup(root)).rejects.toThrow("Invalid agent manifest");
    rmSync(path.join(root, manifestPath));
    const filename = path.join(root, "package.json");
    const saved = readFileSync(filename, "utf-8");
    writeFileSync(filename, saved.replace('"4.0.5"', '"4.0.4"'));
    await expect(setup(root)).rejects.toThrow("pins differ");
    writeFileSync(filename, "{}");
    await expect(setup(root)).rejects.toThrow("Initialize");
  }));

test("a live project lock refuses a second writer and unlocks after release", () =>
  fixture(async (root) => {
    const directory = path.join(root, ".effectory/agent-setup");
    mkdirSync(directory, { recursive: true });
    const lock = new Database(path.join(directory, "lock.sqlite"));
    try {
      lock.exec("BEGIN EXCLUSIVE");
      await expect(setup(root)).rejects.toThrow("owns the project");
      expect(existsSync(path.join(root, manifestPath))).toBe(false);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
    await setup(root);
    const status = await Effect.runPromise(agentStatus(root, "0.1.0"));
    expect(status.healthy).toBe(true);
  }));
