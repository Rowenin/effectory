/* oxlint-disable no-bitwise, no-redeclare -- File open flags and Effect schema type/value pairs. */
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import { hostVersions } from "../../platform-bun/src/host-runtime.ts";
import { ownershipLayer } from "../../platform-bun/src/ownership.ts";
import type { SdkPackage } from "../../platform-bun/src/sdk.ts";
import { sdkSpecifier } from "../../platform-bun/src/sdk.ts";
import {
  allowedFiles,
  assetBundle,
  decodeManifest,
  digest,
  fail,
  manifestPath,
  ownedText,
  planSetup,
} from "./agent-plan.ts";
import type { FileAction, Harness } from "./agent-plan.ts";

const journalPath = ".effectory/agent-setup/journal.json";
const preparePath = ".effectory/agent-setup/journal.prepare";
const lockPath = ".effectory/agent-setup/lock.sqlite";
const Journal = Schema.Struct({
  actions: Schema.Array(
    Schema.Struct({
      after: Schema.NullOr(Schema.String),
      before: Schema.NullOr(Schema.String),
      path: Schema.String,
    })
  ).check(Schema.isMaxLength(257)),
  format: Schema.Literal(1),
  transaction: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u)),
});
type Journal = typeof Journal.Type;
const canWrite = (name: string) =>
  allowedFiles.has(name) || name === manifestPath;

/** Refuse links before opening a destination, including all project parents. */
export function safePath(root: string, name: string) {
  const segments = name.split("/");
  if (
    segments.some((part) => part === ".." || part === "." || !part) ||
    path.isAbsolute(name)
  ) {
    return fail("Conflict", `Unsafe agent path: ${name}`);
  }
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    const last = index === segments.length - 1;
    if (
      stat.isSymbolicLink() ||
      (!last && !stat.isDirectory()) ||
      (last && (!stat.isFile() || stat.nlink !== 1))
    ) {
      return fail(
        "Conflict",
        `Linked or unsupported agent destination: ${name}`
      );
    }
  }
  return current;
}
export function readText(
  root: string,
  name: string,
  maximum = 1_048_576
): string | null {
  const filename = safePath(root, name);
  let fd: number;
  try {
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      return fail("Conflict", `Unsafe agent file: ${name}`);
    }
    if (stat.size > maximum) {
      return fail(
        "LimitExceeded",
        `Agent file exceeds its byte limit: ${name}`
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        readFileSync(fd)
      );
    } catch {
      return fail("Conflict", `Agent file is not valid UTF-8: ${name}`);
    }
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(directory: string) {
  const fd = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function parents(root: string, name: string) {
  safePath(root, name);
  const directory = path.dirname(path.join(root, name));
  mkdirSync(directory, { mode: 0o700, recursive: true });
  safePath(root, name);
  // Persist every directory link back to the repository, not just the leaf.
  let current = directory;
  for (;;) {
    syncDirectory(current);
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }
}
function clearStage(root: string, name: string) {
  const filename = safePath(root, name);
  if (existsSync(filename)) {
    unlinkSync(filename);
    syncDirectory(path.dirname(filename));
  }
}
function replace(
  root: string,
  name: string,
  before: string | null,
  after: string | null,
  stage?: string
) {
  if (
    readText(root, name, name === journalPath ? 8_388_608 : 1_048_576) !==
    before
  ) {
    return fail("Conflict", `Agent file changed during update: ${name}`);
  }
  if (before === after) {
    return;
  }
  parents(root, name);
  const filename = safePath(root, name);
  if (after === null) {
    unlinkSync(filename);
    syncDirectory(path.dirname(filename));
    return;
  }
  const temporary = safePath(
    root,
    stage ?? `${name}.effectory-${crypto.randomUUID()}.tmp`
  );
  // A recorded transaction owns this private staging name, including partial
  // bytes left by process death. Destination bytes are always checked separately.
  if (stage) {
    clearStage(root, stage);
  }
  const fd = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    before === null ? 0o600 : lstatSync(filename).mode & 0o777
  );
  try {
    writeFileSync(fd, after);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (
      readText(root, name, name === journalPath ? 8_388_608 : 1_048_576) !==
      before
    ) {
      return fail("Conflict", `Agent file changed during update: ${name}`);
    }
    renameSync(temporary, filename);
    syncDirectory(path.dirname(filename));
  } finally {
    clearStage(root, path.relative(root, temporary));
  }
}
function snapshot(
  root: string,
  selected: readonly Harness[] = []
): Record<string, string | null> {
  const manifest = readText(root, manifestPath, 262_144);
  const installed = decodeManifest(manifest);
  const harnesses = new Set([...selected, ...(installed?.harnesses ?? [])]);
  const names = [...allowedFiles].filter((name) =>
    harnesses.has(name.startsWith(".claude/") ? "claude-code" : "codex")
  );
  return {
    ...Object.fromEntries(names.map((name) => [name, readText(root, name)])),
    [manifestPath]: manifest,
  };
}
function stageName(pending: Journal, name: string) {
  return `${name}.effectory-${pending.transaction}.tmp`;
}
function journal(root: string): Journal | null {
  const text = readText(root, journalPath, 8_388_608);
  if (text === null) {
    return null;
  }
  let decoded: Journal;
  try {
    decoded = Schema.decodeUnknownSync(Journal)(JSON.parse(text), {
      onExcessProperty: "error",
    });
  } catch {
    return fail(
      "Conflict",
      "Unsupported or corrupt agent setup journal; preserve it for recovery"
    );
  }
  const names = decoded.actions.map((item) => item.path);
  if (
    new Set(names).size !== names.length ||
    names.at(-1) !== manifestPath ||
    names.some((name) => !canWrite(name))
  ) {
    return fail(
      "Conflict",
      "Agent journal contains unsupported destinations or order"
    );
  }
  for (const item of decoded.actions) {
    for (const value of [item.before, item.after]) {
      if (value !== null && Buffer.byteLength(value) > 1_048_576) {
        return fail("LimitExceeded", "Agent journal file exceeds byte limit");
      }
    }
  }
  const manifest = decodeManifest(decoded.actions.at(-1)?.after ?? null);
  if (!manifest) {
    return fail("Conflict", "Agent journal is missing its final manifest");
  }
  for (const [name, owned] of Object.entries(manifest.files)) {
    const item = decoded.actions.find((entry) => entry.path === name);
    const content = ownedText(name, item?.after ?? null);
    if (!item || (content !== null && digest(content) !== owned.digest)) {
      return fail("Conflict", `Agent journal ownership mismatch: ${name}`);
    }
  }
  return decoded;
}
function recover(root: string) {
  const pending = journal(root);
  if (!pending) {
    return;
  }
  // Preflight every target before continuing any partially applied operation.
  for (const item of pending.actions) {
    const current = readText(root, item.path);
    if (current !== item.before && current !== item.after) {
      return fail(
        "Conflict",
        `Agent recovery conflicts with an edit: ${item.path}`
      );
    }
  }
  for (const item of pending.actions) {
    if (readText(root, item.path) !== item.after) {
      replace(
        root,
        item.path,
        item.before,
        item.after,
        stageName(pending, item.path)
      );
    }
  }
  for (const item of pending.actions) {
    const stage = stageName(pending, item.path);
    clearStage(root, stage);
  }
  replace(root, journalPath, readText(root, journalPath, 8_388_608), null);
}
function project(root: string, version: string) {
  const text = readText(root, "package.json");
  if (text === null) {
    return fail("InvalidInput", "Initialize the project before agent setup");
  }
  const decode = Schema.decodeUnknownSync(
    Schema.Struct({
      dependencies: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.String)
      ),
      devDependencies: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.String)
      ),
      effectory: Schema.Struct({ version: Schema.String }),
    })
  );
  let value;
  try {
    value = decode(JSON.parse(text));
  } catch {
    return fail(
      "InvalidInput",
      "Initialize the project before agent setup: package.json is invalid or has no Effectory version"
    );
  }
  const declared = { ...value.dependencies, ...value.devDependencies };
  if (
    value.effectory.version !== version ||
    (Object.keys(hostVersions) as SdkPackage[]).some(
      (key) => declared[key] !== sdkSpecifier(key)
    )
  ) {
    return fail(
      "Conflict",
      "Project and host pins differ; run effectory upgrade and install the pinned dependencies before setup"
    );
  }
}
function repositoryRoot(repository: string) {
  const root = path.resolve(repository);
  if (lstatSync(root).isSymbolicLink()) {
    return fail("Conflict", "Agent setup refuses a symlinked repository root");
  }
  return realpathSync(root);
}
function operation<A>(body: () => A) {
  return Effect.try({
    catch: (cause) =>
      cause instanceof OperationError
        ? cause
        : new OperationError({
            code: "Unavailable",
            message: "Agent setup could not read or update project files",
          }),
    try: body,
  });
}
function publicPlan(plan: {
  harnesses: readonly Harness[];
  actions: readonly FileAction[];
}) {
  return {
    actions: plan.actions.map(({ path: name, action: state }) => ({
      action: state,
      path: name,
    })),
    harnesses: plan.harnesses,
  };
}

export function agentMutation(
  repository: string,
  hostVersion: string,
  mode: "setup" | "remove",
  selected: readonly Harness[],
  dryRun: boolean
) {
  return Effect.gen(function* () {
    const root = yield* operation(() => repositoryRoot(repository));
    const prepare = () => {
      if (mode === "setup") {
        project(root, hostVersion);
      }
      return planSetup({
        hostVersion,
        mode,
        sdkVersions: hostVersions,
        selected,
        snapshot: snapshot(root, selected),
      });
    };
    if (dryRun) {
      return yield* operation(() => {
        if (journal(root) || existsSync(safePath(root, preparePath))) {
          return fail(
            "Conflict",
            "An agent operation is incomplete; rerun without --dry-run to recover it"
          );
        }
        return publicPlan(prepare());
      });
    }
    yield* operation(() => {
      parents(root, lockPath);
      safePath(root, lockPath);
    });
    return yield* operation(() => {
      recover(root);
      clearStage(root, preparePath);
      const plan = prepare();
      if (plan.actions.some((item) => item.action !== "unchanged")) {
        const text = `${JSON.stringify({ actions: plan.actions.map(({ path: name, before, after }) => ({ after, before, path: name })), format: 1, transaction: crypto.randomUUID() })}\n`;
        if (Buffer.byteLength(text) > 8_388_608) {
          return fail("LimitExceeded", "Agent journal exceeds 8 MiB");
        }
        replace(root, journalPath, null, text, preparePath);
        recover(root);
      }
      return publicPlan(plan);
    }).pipe(
      Effect.provide(ownershipLayer(path.join(root, lockPath))),
      Effect.mapError((cause) =>
        cause instanceof OperationError
          ? cause
          : new OperationError({
              code: "Conflict",
              message: "Another agent setup operation owns the project",
            })
      )
    );
  });
}
function statusManifest(root: string) {
  try {
    return {
      conflict: false,
      value: decodeManifest(readText(root, manifestPath, 262_144)),
    };
  } catch {
    return { conflict: true, value: null };
  }
}
function pendingStatus(root: string) {
  try {
    return journal(root) !== null || existsSync(safePath(root, preparePath));
  } catch {
    return true;
  }
}
function pathStatus(
  root: string,
  name: string,
  expected: string,
  bundle: string
) {
  try {
    const value = ownedText(name, readText(root, name));
    if (value === null) {
      return "missing";
    }
    if (digest(value) !== expected) {
      return "modified";
    }
    if (
      name === "AGENTS.md" &&
      (readText(root, "AGENTS.override.md") ?? "").length > 0
    ) {
      return "shadowed";
    }
    return bundle === assetBundle ? "current" : "outdated";
  } catch {
    return "conflicting";
  }
}
function desiredStatus(
  root: string,
  harnesses: readonly Harness[],
  files: Readonly<Record<string, unknown>>
) {
  const names = [...allowedFiles].filter((name) => {
    if (name.startsWith("AGENTS")) {
      return false;
    }
    const owner = name.startsWith(".claude/") ? "claude-code" : "codex";
    return harnesses.includes(owner) && !(name in files);
  });
  if (
    harnesses.includes("codex") &&
    !("AGENTS.md" in files) &&
    !("AGENTS.override.md" in files)
  ) {
    names.push("AGENTS.md");
  }
  return names.map((name) => {
    let state = "conflicting";
    try {
      if (readText(root, name) === null) {
        state = "missing";
      }
    } catch {
      /* Report the unsafe path, without following it. */
    }
    return { path: name, state };
  });
}

export function agentStatus(repository: string, hostVersion: string) {
  return operation(() => {
    const root = repositoryRoot(repository);
    const { value: manifest, conflict } = statusManifest(root);
    const pending = pendingStatus(root);
    const available = {
      availableBundle: assetBundle,
      availableHostVersion: hostVersion,
      availableSdkVersions: hostVersions,
    };
    if (!manifest) {
      return {
        ...available,
        harnesses: [],
        healthy: false,
        paths: [
          { path: manifestPath, state: conflict ? "conflicting" : "missing" },
        ],
        pending,
      };
    }
    const paths = Object.entries(manifest.files).map(([name, file]) => ({
      path: name,
      state: pathStatus(root, name, file.digest, manifest.bundle),
    }));
    // Missing ownership entries in an otherwise valid manifest are repairable.
    const planned = desiredStatus(root, manifest.harnesses, manifest.files);
    paths.push(...planned);
    return {
      ...available,
      harnesses: manifest.harnesses,
      healthy:
        !pending &&
        manifest.bundle === assetBundle &&
        manifest.hostVersion === hostVersion &&
        Object.entries(hostVersions).every(
          ([name, version]) => manifest.sdkVersions[name] === version
        ) &&
        paths.every((item) => item.state === "current"),
      installedBundle: manifest.bundle,
      installedHostVersion: manifest.hostVersion,
      installedSdkVersions: manifest.sdkVersions,
      paths,
      pending,
    };
  });
}
