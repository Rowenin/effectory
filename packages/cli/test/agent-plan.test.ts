import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import assets from "../src/agent-assets.generated.json" with { type: "json" };
import type { Harness, SetupPlan } from "../src/agent-plan.ts";
import {
  decodeManifest,
  instructionBlock,
  manifestPath,
  planSetup,
} from "../src/agent-plan.ts";

type Snapshot = Record<string, string | null>;
const plan = (
  snapshot: Snapshot,
  selected: Harness[] = ["codex"],
  mode: "setup" | "remove" = "setup"
) =>
  planSetup({
    hostVersion: "0.1.0",
    mode,
    sdkVersions: { sdk: "0.1.0" },
    selected,
    snapshot,
  });
const apply = (snapshot: Snapshot, result: SetupPlan): Snapshot => ({
  ...snapshot,
  ...Object.fromEntries(result.actions.map((item) => [item.path, item.after])),
});

test("setup is repeatable, additive and removes only owned content", () => {
  const original = { "AGENTS.md": "User guidance\r\nKeep these bytes." };
  const codex = apply(original, plan(original));
  expect(codex["AGENTS.md"]).toBe(original["AGENTS.md"] + instructionBlock);
  expect(
    plan(codex, []).actions.every((item) => item.action === "unchanged")
  ).toBe(true);
  const both = apply(codex, plan(codex, ["claude-code"]));
  expect(decodeManifest(both[manifestPath] ?? null)?.harnesses).toEqual([
    "claude-code",
    "codex",
  ]);
  const removed = apply(both, plan(both, ["codex"], "remove"));
  expect(removed["AGENTS.md"]).toBe(original["AGENTS.md"]);
  expect(removed[".claude/rules/effectory.md"]).toBe(
    both[".claude/rules/effectory.md"]
  );
});

test("override activation moves an unchanged block and preserves both user files", () => {
  const installed = apply(
    { "AGENTS.md": "root\n" },
    plan({ "AGENTS.md": "root\n" })
  );
  installed["AGENTS.override.md"] = "override\r\n";
  const moved = apply(installed, plan(installed, []));
  expect(moved["AGENTS.md"]).toBe("root\n");
  expect(moved["AGENTS.override.md"]).toBe(`override\r\n${instructionBlock}`);
});

test("edits and malformed markers conflict before any plan can be applied", () => {
  const installed = apply({}, plan({}));
  expect(() =>
    plan({
      ...installed,
      "AGENTS.md": instructionBlock.replace("Effectory tasks", "My tasks"),
    })
  ).toThrow("Modified");
  expect(() =>
    plan({ "AGENTS.md": instructionBlock + instructionBlock })
  ).toThrow("duplicate");
  expect(() => plan({ "AGENTS.md": "<!-- effectory:begin -->broken" })).toThrow(
    "Broken"
  );
  expect(() =>
    plan(
      {
        ...installed,
        ".agents/skills/effectory-build/SKILL.md": "personal edits",
      },
      ["codex"],
      "remove"
    )
  ).toThrow("Modified");
});

test("missing assets repair, matching assets adopt, unrelated files never enter the plan", () => {
  const installed = apply({}, plan({}));
  const skill = ".agents/skills/effectory-build/SKILL.md";
  const repair = plan(
    {
      ...installed,
      ".agents/skills/effectory-build/personal.md": "keep",
      [skill]: null,
    },
    []
  );
  expect(repair.actions.find((item) => item.path === skill)?.action).toBe(
    "created"
  );
  expect(repair.actions.some((item) => item.path.endsWith("personal.md"))).toBe(
    false
  );
  expect(
    plan({ [skill]: assets["SKILL.md"] }).actions.find(
      (item) => item.path === skill
    )?.action
  ).toBe("unchanged");
  expect(() => plan({ [skill]: "not ours" })).toThrow("conflicting");
});

test("manifest data cannot introduce arbitrary destinations or foreign block ownership", () => {
  const installed = apply({}, plan({}));
  const manifest = JSON.parse(installed[manifestPath] ?? "{}");
  manifest.files["../../outside"] = { digest: "0".repeat(64), kind: "file" };
  expect(() =>
    plan({ ...installed, [manifestPath]: JSON.stringify(manifest) })
  ).toThrow("unsupported path");
  expect(() => plan({ [manifestPath]: "broken" })).toThrow(
    "Invalid agent manifest"
  );
  expect(() => plan({}, [])).toThrow("Select --harness");
  expect(() => plan({}, [], "remove")).toThrow("Select at least one");
});

test("oversized shared files are refused without truncation", () => {
  expect(() => plan({ "AGENTS.md": "x".repeat(1_048_577) })).toThrow("1 MiB");
});

test("embedded assets exactly match the distributable portable skill inventory", () => {
  const root = path.resolve(import.meta.dir, "../assets/effectory-build");
  const found: Record<string, string> = {};
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filename);
      } else {
        found[path.relative(root, filename).split(path.sep).join("/")] =
          readFileSync(filename, "utf-8");
      }
    }
  }
  visit(root);
  expect(found).toEqual(assets);
});

test("removing one harness preserves the other harness's recorded bundle and missing ownership", () => {
  const installed = apply({}, plan({}, ["codex", "claude-code"]));
  const manifest = decodeManifest(installed[manifestPath] ?? null);
  if (!manifest) {
    throw new Error("Missing manifest");
  }
  const old = { ...manifest, bundle: "a".repeat(64), hostVersion: "previous" };
  installed[manifestPath] = JSON.stringify(old);
  installed[".agents/skills/effectory-build/SKILL.md"] = null;
  installed["AGENTS.override.md"] = "new user override";
  const removed = plan(installed, ["claude-code"], "remove");
  expect(removed.manifest.bundle).toBe(old.bundle);
  expect(removed.manifest.hostVersion).toBe("previous");
  expect(
    removed.manifest.files[".agents/skills/effectory-build/SKILL.md"]
  ).toEqual(old.files[".agents/skills/effectory-build/SKILL.md"]);
  expect(
    removed.actions
      .filter(
        (item) =>
          item.path.startsWith("AGENTS") || item.path.startsWith(".agents/")
      )
      .every((item) => item.action === "unchanged")
  ).toBe(true);
});
