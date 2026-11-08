import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ExtensionLock,
  LockedPackage,
} from "@effectory/runtime/extension-protocol";
import { OutputPage } from "@effectory/runtime/history-protocol";
import { Content, QueryPage } from "@effectory/runtime/lake-protocol";
import { Run } from "@effectory/runtime/protocol";
import { Effect, Layer, Schema } from "effect";

import { repositorySnapshot, snapshotMarker } from "../src/backup.ts";
import { verifyArchive } from "../src/extension-archive.ts";
import {
  lockFilename,
  trustLock,
  writeBindings,
} from "../src/extension-bindings.ts";
import { restoreCache } from "../src/extension-cache.ts";
import { ExtensionSource } from "../src/extension-source.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { approval, cli, effectory, start } from "./fixtures/cli.ts";
import {
  publishedExtension,
  workspace,
} from "./fixtures/published-extension.ts";

test("offline snapshot restores a waiting run, blobs, pinned bundles and trusted extensions at a new path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-backup-"));
  const repository = path.join(directory, "original");
  const snapshot = path.join(directory, "snapshot");
  const restored = path.join(directory, "restored");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    await mkdir(path.join(repository, ".effectory"), { recursive: true });
    const { archive } = await publishedExtension(
      path.join(directory, "publisher")
    );
    const verified = verifyArchive(archive);
    const source = {
      assetName: "effectory.tgz",
      ref: "v1",
      repository: "fixture/tools",
    };
    const locked: typeof LockedPackage.Type = {
      archiveDigest: verified.archiveDigest,
      dependencies: {},
      manifest: verified.manifest,
      manifestDigest: verified.manifestDigest,
      source: {
        ...source,
        assetId: 1,
        commit: "a".repeat(40),
        publisherDigest: null,
        releaseId: 1,
        size: archive.length,
      },
    };
    const lock: typeof ExtensionLock.Type = {
      format: 1,
      packages: { "fixture/tools": locked },
      roots: { "fixture/tools": { bindingName: "Tools", source } },
    };
    await Effect.runPromise(
      restoreCache(repository, lock).pipe(
        Effect.provide(
          Layer.merge(
            ownershipLayer(
              path.join(repository, ".effectory/state.sqlite.owner")
            ),
            Layer.succeed(ExtensionSource, {
              download: () => Effect.succeed(archive),
              resolve: () =>
                Effect.die("Locked restore must not resolve a tag"),
            })
          )
        )
      )
    );
    writeBindings(repository, lock);
    trustLock(repository, lock);
    await writeFile(lockFilename(repository), JSON.stringify(lock));
    const sourceText = await readFile(
      path.join(workspace, "examples/greeting/effectory.ts"),
      "utf-8"
    );
    await writeFile(
      path.join(repository, "effectory.ts"),
      sourceText
        .replace(
          /import \{\s*Application,/u,
          'import { Tools } from "./effectory.extensions.ts";\nimport { Extension, Application,'
        )
        .replace(
          "import { Effect, Schema }",
          "import { Effect, Layer, Schema }"
        )
        .replace(
          "    const approval =",
          '    const saved = yield* graph.task("snapshot", publish, greeting);\n    const approval ='
        )
        .replace("after: [greeting]", "after: [saved]")
        .replace(
          '    return yield* graph.task("publish",',
          '    yield* graph.task("inspect", Tools.tasks.Inspect, { repository: "a/b" }, { after: [approval] });\n    return yield* graph.task("publish",'
        )
        .replace(
          "  tasks: [greet, publish],",
          "  extensions: [Extension.use(Tools)],\n  tasks: [greet, publish],"
        )
        .replace(
          "  workflows: [welcome],\n});",
          '  workflows: [welcome],\n}).provide(Layer.succeed(Tools.exports.Client, { prefix: "restored" }));'
        )
    );
    const first = await start(repository);
    children.push(first);
    const run = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "workflow",
        "run",
        "example/welcome",
        "--input",
        '{"name":"Ada"}',
        "--background",
      ])
    );
    const wait = await approval(repository, run.runId);
    await expect(
      Effect.runPromise(repositorySnapshot(repository, snapshot, false))
    ).rejects.toThrow("exclusive repository ownership");
    await cli(repository, ["daemon", "stop", "--grace-period-ms", "0"]);
    await cli(repository, ["backup", snapshot]);
    expect(
      await Bun.file(path.join(snapshot, ".effectory/daemon.json")).exists()
    ).toBe(false);
    expect(
      await Bun.file(path.join(snapshot, "effectory.snapshot.json")).exists()
    ).toBe(true);
    await cli(restored, ["restore", snapshot]);
    // Destroy the original to prove recovery has no dependency on its paths.
    await rm(repository, { force: true, recursive: true });
    await writeFile(path.join(restored, snapshotMarker), "Interrupted copy");
    const incomplete = Bun.spawn(
      [...effectory, "daemon", "serve", "--repository", restored],
      { stderr: "pipe", stdout: "pipe" }
    );
    children.push(incomplete);
    expect(await incomplete.exited).not.toBe(0);
    expect(await new Response(incomplete.stderr).text()).toContain(
      "Snapshot copy is incomplete"
    );
    await rm(path.join(restored, snapshotMarker));
    children.push(await start(restored));
    const restoredRun = Schema.decodeUnknownSync(Run)(
      await cli(restored, ["run", "get", run.runId])
    );
    expect(restoredRun.revision).toBe(run.revision);
    const restoredWait = await approval(restored, run.runId);
    expect(restoredWait.waitId).toBe(wait.waitId);
    const page = Schema.decodeUnknownSync(QueryPage)(
      await cli(restored, [
        "lake",
        "query",
        "--file",
        path.join(workspace, "examples/greeting/query.json"),
      ])
    );
    const [record] = page.rows;
    if (!record) {
      throw new Error("Restored artifact is missing");
    }
    expect(record.version).toBe(1);
    expect(
      Schema.decodeUnknownSync(Content)(
        await cli(restored, [
          "lake",
          "get",
          record.artifactId,
          "--version",
          "1",
        ])
      ).value
    ).toEqual({ greeting: "Hello Ada" });
    await cli(restored, [
      "run",
      "approve",
      wait.waitId,
      "--request-key",
      "restored-approval",
    ]);
    expect(
      Schema.decodeUnknownSync(Run)(
        await cli(restored, ["run", "watch", run.runId])
      ).status
    ).toBe("Succeeded");
    const outputs = Schema.decodeUnknownSync(OutputPage)(
      await cli(restored, ["run", "outputs", run.runId])
    );
    expect(
      outputs.items.find((item) => item.taskId === "fixture/tools/inspect")
        ?.result
    ).toBe("restored/a/b");
    await cli(restored, ["daemon", "stop", "--grace-period-ms", "0"]);
    await expect(
      Effect.runPromise(repositorySnapshot(snapshot, restored, true))
    ).rejects.toThrow("already exists");
    await writeFile(path.join(snapshot, "effectory.ts"), "changed");
    await expect(
      Effect.runPromise(
        repositorySnapshot(
          snapshot,
          path.join(directory, "corrupt-restore"),
          true
        )
      )
    ).rejects.toThrow("manifest");
    expect(
      await Bun.file(
        path.join(directory, "corrupt-restore/effectory.ts")
      ).exists()
    ).toBe(false);
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
      })
    );
    await rm(directory, { force: true, recursive: true });
  }
  // This scenario starts many cold CLI processes; runtime deadlines remain unchanged.
}, 120_000);
