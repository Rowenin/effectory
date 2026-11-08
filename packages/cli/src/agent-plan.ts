/* oxlint-disable no-redeclare -- Effect schemas share their value and type names. */
import { createHash } from "node:crypto";

import { OperationError } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import assets from "./agent-assets.generated.json" with { type: "json" };

export const Harness = Schema.Literals(["codex", "claude-code"]);
export type Harness = typeof Harness.Type;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const AgentManifest = Schema.Struct({
  bundle: Digest,
  files: Schema.Record(
    Schema.String,
    Schema.Struct({ digest: Digest, kind: Schema.Literals(["file", "block"]) })
  ),
  format: Schema.Literal(1),
  harnesses: Schema.Array(Harness),
  hostVersion: Schema.String,
  sdkVersions: Schema.Record(Schema.String, Schema.String),
});
export type AgentManifest = typeof AgentManifest.Type;
export const manifestPath = ".effectory-agent.json";
export const begin = "\n<!-- effectory:begin -->\n";
export const end = "<!-- effectory:end -->\n";
const guidance =
  "# Effectory\n\nUse the effectory-build skill when authoring or maintaining Effectory tasks and workflows. Read the project's existing instructions and installed SDK first. Preserve run identities, replay policy and user-authored content. Run the project's typecheck, lint and tests.\n";
export const instructionBlock = `${begin}${guidance}${end}`;
const prefixes: Record<Harness, string> = {
  "claude-code": ".claude/skills/effectory-build/",
  codex: ".agents/skills/effectory-build/",
};
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const assetBundle = digest(JSON.stringify({ assets, guidance }));
export const allowedFiles = new Set([
  "AGENTS.md",
  "AGENTS.override.md",
  ".claude/rules/effectory.md",
  ...Object.values(prefixes).flatMap((prefix) =>
    Object.keys(assets).map((name) => `${prefix}${name}`)
  ),
]);
export const fail = (
  code: "Conflict" | "InvalidInput" | "LimitExceeded",
  message: string
): never => {
  throw new OperationError({ code, message });
};
export function decodeManifest(text: string | null): AgentManifest | null {
  if (text === null) {
    return null;
  }
  if (Buffer.byteLength(text) > 262_144) {
    return fail("LimitExceeded", "Agent manifest exceeds 256 KiB");
  }
  let value: AgentManifest;
  try {
    value = Schema.decodeUnknownSync(AgentManifest)(JSON.parse(text), {
      onExcessProperty: "error",
    });
  } catch {
    return fail("Conflict", "Invalid agent manifest; restore it before setup");
  }
  if (new Set(value.harnesses).size !== value.harnesses.length) {
    return fail("Conflict", "Agent manifest contains duplicate harnesses");
  }
  for (const [name, file] of Object.entries(value.files)) {
    if (
      !allowedFiles.has(name) ||
      (file.kind === "block") !== name.startsWith("AGENTS")
    ) {
      return fail(
        "Conflict",
        `Agent manifest has an unsupported path or kind: ${name}`
      );
    }
    const owner =
      name.startsWith("AGENTS") || name.startsWith(".agents/")
        ? "codex"
        : "claude-code";
    if (!value.harnesses.includes(owner)) {
      return fail(
        "Conflict",
        `Agent manifest has an unregistered owner: ${name}`
      );
    }
  }
  return value;
}

/** A complete immutable preflight. Filesystem reads and writes live outside it. */
export interface FileAction {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly action: "created" | "updated" | "removed" | "unchanged";
}
export interface SetupPlan {
  readonly harnesses: readonly Harness[];
  readonly actions: readonly FileAction[];
  readonly manifest: AgentManifest;
}
function splitBlock(text: string, name: string) {
  const starts = text.split("<!-- effectory:begin -->").length - 1;
  const ends = text.split("<!-- effectory:end -->").length - 1;
  if (starts === 0 && ends === 0) {
    return null;
  }
  const start = text.indexOf(begin);
  const finish = text.indexOf(end, start + begin.length);
  if (starts !== 1 || ends !== 1 || start === -1 || finish < start) {
    return fail("Conflict", `Broken or duplicate Effectory markers in ${name}`);
  }
  return {
    finish: finish + end.length,
    start,
    text: text.slice(start, finish + end.length),
  };
}
export function ownedText(name: string, text: string | null) {
  if (text === null) {
    return null;
  }
  return name.startsWith("AGENTS")
    ? (splitBlock(text, name)?.text ?? null)
    : text;
}
type Desired = Record<string, { text: string; kind: "file" | "block" }>;
function desiredFiles(
  harnesses: readonly Harness[],
  snapshot: Readonly<Record<string, string | null>>
): Desired {
  const desired: Record<string, { text: string; kind: "file" | "block" }> = {};
  for (const harness of harnesses) {
    for (const [name, text] of Object.entries(assets)) {
      desired[`${prefixes[harness]}${name}`] = { kind: "file", text };
    }
    if (harness === "codex") {
      const override = snapshot["AGENTS.override.md"] ?? "";
      desired[override.length > 0 ? "AGENTS.override.md" : "AGENTS.md"] = {
        kind: "block",
        text: instructionBlock,
      };
    } else {
      desired[".claude/rules/effectory.md"] = { kind: "file", text: guidance };
    }
  }
  return desired;
}
function action(
  path: string,
  before: string | null,
  after: string | null
): FileAction {
  let kind: FileAction["action"] = "updated";
  if (before === after) {
    kind = "unchanged";
  } else if (before === null) {
    kind = "created";
  } else if (after === null) {
    kind = "removed";
  }
  return { action: kind, after, before, path };
}
function checkSize(name: string, text: string | null) {
  if (text !== null && Buffer.byteLength(text) > 1_048_576) {
    return fail("LimitExceeded", `Agent file exceeds 1 MiB: ${name}`);
  }
}
function filePlan(
  name: string,
  before: string | null,
  prior: AgentManifest["files"][string] | undefined,
  target: Desired[string] | undefined
): FileAction {
  checkSize(name, before);
  const blockKind = name.startsWith("AGENTS");
  const block = blockKind && before !== null ? splitBlock(before, name) : null;
  const owned = blockKind ? (block?.text ?? null) : before;
  const expected = prior?.digest ?? (target ? digest(target.text) : null);
  if (owned !== null && digest(owned) !== expected) {
    return fail(
      "Conflict",
      `Modified or conflicting agent content: ${name}. Move personal guidance outside managed content before retrying.`
    );
  }
  let after = target?.text ?? null;
  if (blockKind && before !== null) {
    const replacement = target?.text ?? "";
    after = block
      ? before.slice(0, block.start) + replacement + before.slice(block.finish)
      : before + replacement;
  }
  checkSize(name, after);
  return action(name, before, after);
}

function retainedOwnership(old: AgentManifest, harnesses: readonly Harness[]) {
  return Object.fromEntries(
    Object.entries(old.files).filter(([name]) =>
      harnesses.includes(name.startsWith(".claude/") ? "claude-code" : "codex")
    )
  );
}
function retainedFiles(
  old: AgentManifest,
  harnesses: readonly Harness[],
  snapshot: Readonly<Record<string, string | null>>
): Desired {
  const desired: Desired = {};
  for (const [name, prior] of Object.entries(
    retainedOwnership(old, harnesses)
  )) {
    const text = ownedText(name, snapshot[name] ?? null);
    if (text !== null) {
      desired[name] = { kind: prior.kind, text };
    }
  }
  return desired;
}
function planFiles(
  desired: Desired,
  previous: AgentManifest["files"],
  snapshot: Readonly<Record<string, string | null>>
) {
  const names = [
    ...new Set([...Object.keys(previous), ...Object.keys(desired)]),
  ].toSorted();
  if (names.length > 256) {
    return fail("LimitExceeded", "Too many managed agent files");
  }
  if (
    Object.values(desired).reduce(
      (sum, item) => sum + Buffer.byteLength(item.text),
      0
    ) > 2_097_152
  ) {
    return fail("LimitExceeded", "Agent assets exceed 2 MiB");
  }
  const actions: FileAction[] = [];
  const files: Record<string, { digest: string; kind: "file" | "block" }> = {};
  for (const name of names) {
    const target = desired[name];
    actions.push(
      filePlan(name, snapshot[name] ?? null, previous[name], target)
    );
    if (target) {
      files[name] = { digest: digest(target.text), kind: target.kind };
    }
  }
  return { actions, files };
}
export function planSetup(options: {
  readonly mode: "setup" | "remove";
  readonly selected: readonly Harness[];
  readonly snapshot: Readonly<Record<string, string | null>>;
  readonly hostVersion: string;
  readonly sdkVersions: Readonly<Record<string, string>>;
}): SetupPlan {
  const old = decodeManifest(options.snapshot[manifestPath] ?? null);
  const selected = [...new Set(options.selected)];
  if (options.mode === "remove" && selected.length === 0) {
    return fail("InvalidInput", "Select at least one --harness to remove");
  }
  const harnesses = (
    options.mode === "setup"
      ? [...new Set([...(old?.harnesses ?? []), ...selected])]
      : (old?.harnesses ?? []).filter((name) => !selected.includes(name))
  ).toSorted();
  if (options.mode === "setup" && harnesses.length === 0) {
    return fail(
      "InvalidInput",
      "Select --harness codex or --harness claude-code"
    );
  }
  const removing = options.mode === "remove" && old !== null;
  const desired = removing
    ? retainedFiles(old, harnesses, options.snapshot)
    : desiredFiles(harnesses, options.snapshot);
  const { actions, files } = planFiles(
    desired,
    old?.files ?? {},
    options.snapshot
  );
  const manifest: AgentManifest = {
    bundle: removing ? old.bundle : assetBundle,
    files,
    format: 1,
    harnesses,
    hostVersion: removing ? old.hostVersion : options.hostVersion,
    sdkVersions: { ...(removing ? old.sdkVersions : options.sdkVersions) },
  };
  if (removing) {
    Object.assign(files, retainedOwnership(old, harnesses));
  }
  const after = `${JSON.stringify(manifest, null, 2)}\n`;
  const before = options.snapshot[manifestPath] ?? null;
  actions.push(action(manifestPath, before, after));
  return { actions, harnesses, manifest };
}
