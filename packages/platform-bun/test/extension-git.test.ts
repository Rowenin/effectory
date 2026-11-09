/* oxlint-disable no-await-in-loop -- Fixture workspace copying and Git commits are ordered. */
import { expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  symlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ExtensionOperation,
  ExtensionUpdatePage,
} from "@effectory/runtime/extension-protocol";
import type {
  ExtensionLock,
  LockedPackage,
} from "@effectory/runtime/extension-protocol";
import { Effect, Layer, Schema } from "effect";

import { digest, verifyArchive } from "../src/extension-archive.ts";
import { readLock } from "../src/extension-bindings.ts";
import { restoreCache, validateLock } from "../src/extension-cache.ts";
import { download, resolve } from "../src/extension-git.ts";
import {
  SourceCommand,
  sourceCommand,
} from "../src/extension-source-command.ts";
import { ExtensionSource, parseSource } from "../src/extension-source.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { cli, start, operation, effectory } from "./fixtures/cli.ts";
import { typescript } from "./fixtures/published-extension.ts";

const root = path.resolve(import.meta.dir, "../../..");
async function git(directory: string, ...args: string[]) {
  const child = Bun.spawn(
    ["git", "-c", "core.hooksPath=/dev/null", "-C", directory, ...args],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(errors);
  }
  return output.trim();
}
async function repository(directory: string) {
  const original = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Unknown)
  )(JSON.parse(await readFile(path.join(root, "package.json"), "utf-8")));
  const pkg = {
    ...original,
    packageManager: `bun@${Bun.version}`,
    scripts: {
      prepare: "bun -e 'throw new Error(\"Lifecycle scripts must not run\")'",
    },
  };
  await writeFile(path.join(directory, "package.json"), JSON.stringify(pkg));
  await cp(path.join(root, "bun.lock"), path.join(directory, "bun.lock"));
  for (const category of ["packages", "extensions"]) {
    for (const name of await readdir(path.join(root, category))) {
      const target = path.join(directory, category, name);
      await mkdir(target, { recursive: true });
      await cp(
        path.join(root, category, name, "package.json"),
        path.join(target, "package.json")
      );
    }
  }
  for (const name of [
    "packages/core/src",
    "extensions/agent-runner/src",
    "extensions/agent-runner/effectory.extension.source.json",
  ]) {
    await cp(path.join(root, name), path.join(directory, name), {
      recursive: true,
    });
  }
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Effectory Test");
  await git(directory, "config", "user.email", "test@example.invalid");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "feat: add source fixture");
  await git(directory, "tag", "-a", "v1", "-m", "fixture");
}

test("Git sources build reproducibly, pin annotated tags and restore the old commit after a tag moves", async () => {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "effectory-git-test-"))
  );
  const upstream = path.join(directory, "upstream");
  await mkdir(upstream);
  const calls: string[][] = [];
  try {
    await repository(upstream);
    const native = await Effect.runPromise(sourceCommand);
    const command = Layer.succeed(
      SourceCommand,
      SourceCommand.of({
        run: (executable, args, options) => {
          calls.push([executable, ...args]);
          const rewritten = args.map((arg) =>
            arg === "https://github.com/fixture/source.git" ? upstream : arg
          );
          if (executable === "bun" && args[0] === "install") {
            rewritten.push("--offline");
          }
          return native.run(
            executable === "bun" ? process.execPath : executable,
            rewritten,
            options
          );
        },
      })
    );
    const source = parseSource(
      "github:fixture/source@v1",
      undefined,
      "extensions/agent-runner"
    );
    if (!("kind" in source)) {
      throw new Error("Expected Git source");
    }
    const resolved = await Effect.runPromise(
      resolve(source).pipe(Effect.provide(command))
    );
    expect(resolved.commit).toBe(await git(upstream, "rev-parse", "HEAD"));
    expect(resolved.commit).not.toBe(await git(upstream, "rev-parse", "v1"));
    const archive = await Effect.runPromise(
      download(resolved).pipe(Effect.provide(command))
    );
    const verified = verifyArchive(archive);
    expect(verified.manifest.id).toBe("offtree/agent-runner");
    expect(verified.manifest.sourceBuild?.lockfileDigest).toBe(
      digest(await readFile(path.join(upstream, "bun.lock")))
    );
    expect(verified.manifest.sourceBuild?.toolchain).toEqual(
      resolved.toolchain
    );
    expect(verified.files.has("contracts.d.mts")).toBe(true);
    expect(
      verified.manifest.dependencyInventory.some(
        (item) => item.name === "@distilled.cloud/opencode"
      )
    ).toBe(true);
    expect(
      verified.manifest.dependencyInventory.some(
        (item) => item.name === "effect"
      )
    ).toBe(false);
    const locked: typeof LockedPackage.Type = {
      archiveDigest: verified.archiveDigest,
      dependencies: {},
      manifest: verified.manifest,
      manifestDigest: verified.manifestDigest,
      source: resolved,
    };
    const lock: typeof ExtensionLock.Type = {
      format: 1,
      packages: { [locked.manifest.id]: locked },
      roots: { [locked.manifest.id]: { bindingName: "Agents", source } },
    };
    expect(validateLock(lock)).toEqual(lock);
    expect(() =>
      validateLock({
        ...lock,
        packages: {
          [locked.manifest.id]: {
            ...locked,
            source: {
              ...resolved,
              toolchain: { ...resolved.toolchain, bun: "0.0.0" },
            },
          },
        },
      })
    ).toThrow("provenance");
    const { sourceBuild } = verified.manifest;
    if (sourceBuild === undefined) {
      throw new Error("Expected source provenance");
    }
    const incompatible = { ...resolved.toolchain, effect: "0.0.0" };
    expect(() =>
      validateLock({
        ...lock,
        packages: {
          [locked.manifest.id]: {
            ...locked,
            manifest: {
              ...verified.manifest,
              sourceBuild: { ...sourceBuild, toolchain: incompatible },
            },
            source: { ...resolved, toolchain: incompatible },
          },
        },
      })
    ).toThrow("host peers");
    await writeFile(
      path.join(upstream, "extensions/agent-runner/src/marker.ts"),
      'export const moved = "new commit";\n'
    );
    await git(upstream, "add", ".");
    await git(upstream, "commit", "-m", "fix: move fixture tag");
    await git(upstream, "tag", "-fa", "v1", "-m", "moved");
    const refreshed = await Effect.runPromise(
      resolve(source).pipe(Effect.provide(command))
    );
    expect(refreshed.commit).not.toBe(resolved.commit);
    const consumer = path.join(directory, "consumer");
    await mkdir(consumer);
    const transport = Layer.succeed(ExtensionSource, {
      download: (pinned) =>
        "kind" in pinned ? download(pinned) : Effect.die("Expected Git source"),
      resolve: () => Effect.die("Restore must never resolve a tag"),
    });
    const runtime = Layer.mergeAll(
      command,
      transport,
      ownershipLayer(path.join(consumer, "owner"))
    );
    const denied = await Effect.runPromise(
      restoreCache(consumer, lock).pipe(Effect.result, Effect.provide(runtime))
    );
    expect(denied._tag).toBe("Failure");
    if (denied._tag === "Failure") {
      expect(denied.failure.code).toBe("Unauthorized");
    }
    const before = calls.length;
    await Effect.runPromise(
      restoreCache(consumer, lock, { trust: true }).pipe(
        Effect.provide(runtime)
      )
    );
    const restoring = calls.slice(before);
    expect(restoring.some((args) => args.includes("ls-remote"))).toBe(false);
    expect(restoring.find((args) => args.includes("fetch"))?.at(-1)).toBe(
      resolved.commit
    );
    const after = calls.length;
    await Effect.runPromise(
      restoreCache(consumer, lock).pipe(Effect.provide(runtime))
    );
    expect(calls.length).toBe(after);
    await git(upstream, "tag", "main");
    const ambiguous = await Effect.runPromise(
      resolve({ ...source, ref: "main" }).pipe(
        Effect.result,
        Effect.provide(command)
      )
    );
    expect(ambiguous._tag).toBe("Failure");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 180_000);

test("source selectors default to Git and reject unsafe paths or ambiguous archive options", () => {
  expect(parseSource("github:fixture/source@v1")).toEqual({
    kind: "git",
    path: ".",
    ref: "v1",
    repository: "fixture/source",
  });
  expect(() =>
    parseSource("github:fixture/source@v1", undefined, "../escape")
  ).toThrow();
  expect(() =>
    parseSource("github:fixture/source@v1", "extension.tgz", "extensions/tool")
  ).toThrow();
  expect(() => parseSource("github:fixture/source@main~1")).toThrow();
});

test("CLI installs a repository path, updates explicitly and restores a locked source on a second computer", async () => {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "effectory-git-cli-"))
  );
  const upstream = path.join(directory, "upstream");
  const consumer = path.join(directory, "consumer");
  const second = path.join(directory, "second");
  const bin = path.join(directory, "bin");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    await Promise.all(
      [upstream, consumer, second, bin].map(async (name) => await mkdir(name))
    );
    await repository(upstream);
    const gitBinary = Bun.which("git");
    if (gitBinary === null) {
      throw new Error("Git is required for this test");
    }
    await writeFile(
      path.join(bin, "git"),
      `#!${process.execPath}\nconst args = process.argv.slice(2).map(arg => arg === "https://github.com/fixture/source.git" ? ${JSON.stringify(upstream)} : arg);\nconst child = Bun.spawn([${JSON.stringify(gitBinary)}, ...args], {stdin: "ignore",stdout:"inherit",stderr:"inherit"});\nprocess.exit(await child.exited);\n`,
      { mode: 0o700 }
    );
    await writeFile(
      path.join(bin, "bun"),
      `#!${process.execPath}\nconst args = process.argv.slice(2); if (args[0] === "install") args.push("--offline");\nconst child = Bun.spawn([${JSON.stringify(process.execPath)}, ...args], {stdin:"ignore",stdout:"inherit",stderr:"inherit"});\nprocess.exit(await child.exited);\n`,
      { mode: 0o700 }
    );
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    await writeFile(
      path.join(consumer, "effectory.ts"),
      'import { Application } from "@offtree/effectory-sdk"; export default Application.make({});\n'
    );
    children.push(await start(consumer, environment));
    const accepted = Schema.decodeUnknownSync(ExtensionOperation)(
      await cli(consumer, [
        "extension",
        "add",
        "github:fixture/source@v1",
        "--path",
        "extensions/agent-runner",
        "--as",
        "Agents",
        "--trust",
      ])
    );
    const added = await operation(consumer, accepted.operationId);
    expect(added.status, JSON.stringify(added.error)).toBe("Succeeded");
    const lock = readLock(consumer);
    const pinned = lock.packages["offtree/agent-runner"]?.source.commit;
    expect(pinned).toBe(await git(upstream, "rev-parse", "HEAD"));
    await symlink(
      path.join(root, "node_modules"),
      path.join(consumer, "node_modules"),
      "dir"
    );
    await writeFile(
      path.join(consumer, "smoke.mts"),
      `import { BunServices } from "@effect/platform-bun";
import { Task, Application } from "@offtree/effectory-sdk";
import { Effect, Layer, Schema } from "effect";
import { Agents } from "./effectory.extensions.ts";
const Review = Agents.exports.makeTask({ id: "fixture/review", version: 1, output: Schema.Struct({ ok: Schema.Boolean }) });
const value: typeof Review.successSchema.Type.output = { ok: true };
// @ts-expect-error Output types survive source declaration emission.
const invalid: typeof Review.successSchema.Type.output = { ok: "yes" };
// @ts-expect-error The installed runner remains required.
const missing: Application.Application<never> = Application.make({ tasks: [Review] });
const result = await Effect.runPromise(Task.test(Review, {input:{platform:"fixture",policy:"read",prompt:"review",workingDirectory:${JSON.stringify(consumer)}}}).pipe(Effect.provide(Agents.exports.layer({ policies: {read:{}}, adapters:{fixture:{configuration:"fixture",supportsResume:false,supportsStructuredOutput:true,run:()=>Effect.succeed({output:JSON.stringify({output:value}),transcript:[],version:"fixture"})}} }).pipe(Layer.provide(BunServices.layer)))));
if (!result.value.output.ok) throw new Error("JSON output was lost");
void [invalid,missing];\n`
    );
    await typescript(consumer, ["smoke.mts"]);
    const smoke = Bun.spawn(
      [process.execPath, path.join(consumer, "smoke.mts")],
      { stderr: "pipe", stdout: "pipe" }
    );
    const [diagnostics, code] = await Promise.all([
      new Response(smoke.stderr).text(),
      smoke.exited,
    ]);
    expect(code, diagnostics).toBe(0);
    await cp(
      path.join(consumer, "effectory.extensions.lock.json"),
      path.join(second, "effectory.extensions.lock.json")
    );
    await writeFile(path.join(upstream, "marker.txt"), "tag moved");
    await git(upstream, "add", ".");
    await git(upstream, "commit", "-m", "fix: move source selector");
    await git(upstream, "tag", "-fa", "v1", "-m", "moved");
    const outdated = Schema.decodeUnknownSync(ExtensionUpdatePage)(
      await cli(consumer, ["extension", "outdated"])
    );
    expect(outdated.items[0]?.changed).toBe(true);
    expect(
      readLock(consumer).packages["offtree/agent-runner"]?.source.commit
    ).toBe(pinned);
    const update = Schema.decodeUnknownSync(ExtensionOperation)(
      await cli(consumer, [
        "extension",
        "update",
        "offtree/agent-runner",
        "--to",
        "v1",
        "--trust",
      ])
    );
    const updated = await operation(consumer, update.operationId);
    expect(updated.status, JSON.stringify(updated.error)).toBe("Succeeded");
    expect(
      readLock(consumer).packages["offtree/agent-runner"]?.source.commit
    ).toBe(await git(upstream, "rev-parse", "HEAD"));
    const restore = Bun.spawn(
      [
        ...effectory,
        "extension",
        "restore",
        "--trust",
        "--repository",
        second,
        "--json",
      ],
      { env: environment, stderr: "pipe", stdout: "pipe" }
    );
    const [restored, errors, restoredCode] = await Promise.all([
      new Response(restore.stdout).text(),
      new Response(restore.stderr).text(),
      restore.exited,
    ]);
    expect(restoredCode, `${errors}\n${restored}`).toBe(0);
    expect(readLock(second)).toEqual(lock);
    expect(
      await readFile(path.join(second, "effectory.extensions.ts"), "utf-8")
    ).toContain("export const Agents");
    await writeFile(
      path.join(bin, "git"),
      `#!${process.execPath}\nthrow new Error("Cached restore must not invoke Git");\n`,
      { mode: 0o700 }
    );
    const offline = Bun.spawn(
      [...effectory, "extension", "restore", "--repository", second, "--json"],
      { env: environment, stderr: "pipe", stdout: "pipe" }
    );
    const [offlineErrors, offlineCode] = await Promise.all([
      new Response(offline.stderr).text(),
      offline.exited,
    ]);
    expect(offlineCode, offlineErrors).toBe(0);
  } finally {
    for (const child of children) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 180_000);

test("source processes bound output, redact diagnostics and exit before cancellation completes", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-source-process-")
  );
  const script = path.join(import.meta.dir, "fixtures/gh-process.ts");
  const filename = path.join(directory, "pid");
  try {
    const command = await Effect.runPromise(sourceCommand);
    const oversized = await Effect.runPromise(
      command
        .run(process.execPath, [script, "large"], { maximumBytes: 100 })
        .pipe(Effect.result)
    );
    expect(oversized._tag).toBe("Failure");
    if (oversized._tag === "Failure") {
      expect(oversized.failure.code).toBe("LimitExceeded");
    }
    const failed = await Effect.runPromise(
      command.run(process.execPath, [script, "error"]).pipe(Effect.result)
    );
    expect(failed._tag).toBe("Failure");
    if (failed._tag === "Failure") {
      expect(failed.failure.message).not.toContain("secret-from-stderr");
    }
    await Effect.runPromise(
      command.run(process.execPath, [script, "hang", filename]).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.succeed(new Uint8Array()),
        })
      )
    );
    const pid = Number(await readFile(filename, "utf-8"));
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
