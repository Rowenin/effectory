import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  OperationPage,
  ExtensionInventory,
  ExtensionOperation,
  ExtensionUpdatePage,
} from "@effectory/runtime/extension-protocol";
import { DefinitionPage } from "@effectory/runtime/history-protocol";
import { Run } from "@effectory/runtime/protocol";
import { ServerHello } from "@effectory/runtime/rpc";
import { Schema } from "effect";

import { approval, cli, operation, start } from "./fixtures/cli.ts";
import { publishedExtension } from "./fixtures/published-extension.ts";

const empty =
  'import { Application } from "@effectory/core"; export default Application.make({});';
const accepted = Schema.decodeUnknownSync(ExtensionOperation);
const inventory = Schema.decodeUnknownSync(ExtensionInventory);
const run = Schema.decodeUnknownSync(Run);

test("CLI extension operations activate selected updates, preserve waiting revisions, and refuse required removals", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-extension-daemon-")
  );
  const repository = path.join(directory, "consumer");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const firstPackage = await publishedExtension(path.join(directory, "v1"));
    const secondPackage = await publishedExtension(path.join(directory, "v2"), {
      prefix: "next/",
      version: "2.0.0",
    });
    await mkdir(repository);
    await writeFile(path.join(repository, "effectory.ts"), empty);
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    // Exercise the real gh subprocess adapter with fixture release responses. No network or credentials.
    await writeFile(
      path.join(bin, "gh"),
      `#!${process.execPath}\nconst endpoint = process.argv[5];
const packages = ${JSON.stringify([
        {
          filename: path.join(directory, "v1/bundle.tgz"),
          id: 1,
          ref: "v1",
          size: firstPackage.archive.length,
        },
        {
          filename: path.join(directory, "v2/bundle.tgz"),
          id: 2,
          ref: "v2",
          size: secondPackage.archive.length,
        },
      ])};
if (endpoint.includes("/commits/")) { process.stdout.write(JSON.stringify({ sha: "a".repeat(40) })); }
else if (endpoint.includes("/releases/assets/")) { const pkg = packages.find(item => endpoint.endsWith("/" + item.id)); process.stdout.write(await Bun.file(pkg.filename).bytes()); }
else { const pkg = packages.find(item => endpoint.endsWith("/" + item.ref) || (endpoint.endsWith("/latest") && item.ref === "v2")); process.stdout.write(JSON.stringify({ id: pkg.id, draft: false, tag_name: pkg.ref, assets: [{ id: pkg.id, name: "effectory.tgz", size: pkg.size }] })); }
`,
      { mode: 0o700 }
    );
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    const first = await start(repository, environment);
    children.push(first);
    const initial = Schema.decodeUnknownSync(ServerHello)(
      await cli(repository, ["daemon", "status"])
    );
    const add = accepted(
      await cli(repository, [
        "extension",
        "add",
        "github:fixture/tools@v1",
        "--as",
        "Tools",
        "--trust",
      ])
    );
    const added = await operation(repository, add.operationId);
    expect(added.status, JSON.stringify(added.error)).toBe("Succeeded");
    const installed = inventory(await cli(repository, ["extension", "list"]));
    expect(installed.applicationRevision).toBe(initial.revision);
    expect(installed.extensions[0]?.selected).toBe(false);
    expect(installed.extensions[0]?.bindingName).toBe("Tools");
    const updates = Schema.decodeUnknownSync(ExtensionUpdatePage)(
      await cli(repository, ["extension", "outdated"])
    );
    expect(updates.items[0]?.latest?.ref).toBe("v2");
    expect(updates.items[0]?.changed).toBe(true);
    expect(
      inventory(await cli(repository, ["extension", "list"])).extensions[0]
        ?.version
    ).toBe("1.0.0");
    const consumerSource = await readFile(
      path.join(import.meta.dir, "fixtures/published-extension/consumer.txt"),
      "utf-8"
    );
    const consumer = consumerSource.replace(
      "  const result = yield* graph.task",
      '  yield* graph.approval("review", { prompt: "Continue?", timeout: "1 minute" });\n  const result = yield* graph.task'
    );
    await writeFile(path.join(repository, "effectory.ts"), consumer);
    first.kill("SIGKILL");
    await first.exited;
    children.push(await start(repository, environment));
    const previous = run(
      await cli(repository, [
        "workflow",
        "run",
        "local/flow",
        "--input",
        '{"repository":"a/b"}',
        "--background",
      ])
    );
    const oldWait = await approval(repository, previous.runId);
    const discovery = Schema.decodeUnknownSync(DefinitionPage)(
      await cli(repository, ["task", "list", "--limit", "1"])
    );
    const update = accepted(
      await cli(repository, [
        "extension",
        "update",
        "fixture/tools",
        "--to",
        "v2",
        "--trust",
      ])
    );
    const updated = await operation(repository, update.operationId);
    expect(updated.status, JSON.stringify(updated.error)).toBe("Succeeded");
    const changed = inventory(await cli(repository, ["extension", "list"]));
    expect(changed.applicationRevision).not.toBe(previous.revision);
    expect(changed.extensions[0]?.version).toBe("2.0.0");
    expect(changed.extensions[0]?.selected).toBe(true);
    expect(discovery.cursor).not.toBeNull();
    const nextPage = Schema.decodeUnknownSync(DefinitionPage)(
      await cli(repository, [
        "task",
        "list",
        "--limit",
        "1",
        "--cursor",
        discovery.cursor ?? "",
      ])
    );
    expect(nextPage.revision).toBe(previous.revision);
    expect(nextPage.items[0]?.id).toBe("local/format");

    await cli(repository, ["run", "approve", oldWait.waitId]);
    const oldResult = run(
      await cli(repository, ["run", "watch", previous.runId])
    );
    expect(oldResult.result).toBe("formatted:loaded/a/b");
    const next = run(
      await cli(repository, [
        "workflow",
        "run",
        "local/flow",
        "--input",
        '{"repository":"a/b"}',
        "--background",
      ])
    );
    const nextWait = await approval(repository, next.runId);
    await cli(repository, ["run", "approve", nextWait.waitId]);
    expect(
      run(await cli(repository, ["run", "watch", next.runId])).result
    ).toBe("formatted:next/loaded/a/b");
    const refusal = accepted(
      await cli(repository, ["extension", "remove", "fixture/tools"])
    );
    const refused = await operation(repository, refusal.operationId);
    expect(refused.status).toBe("Failed");
    expect(
      inventory(await cli(repository, ["extension", "list"])).installedRevision
    ).toBe(changed.installedRevision);
    await writeFile(path.join(repository, "effectory.ts"), empty);
    const remove = accepted(
      await cli(repository, ["extension", "remove", "fixture/tools"])
    );
    const removed = await operation(repository, remove.operationId);
    expect(removed.status).toBe("Succeeded");
    expect(
      inventory(await cli(repository, ["extension", "list"])).extensions
    ).toEqual([]);
    const running = children.at(-1);
    running?.kill("SIGKILL");
    await running?.exited;
    children.push(await start(repository, environment));
    expect(
      run(await cli(repository, ["run", "get", previous.runId])).result
    ).toBe("formatted:loaded/a/b");
    expect(
      Schema.decodeUnknownSync(OperationPage)(
        await cli(repository, ["operation", "list"])
      ).items
    ).toHaveLength(4);
    const firstHistory = Schema.decodeUnknownSync(OperationPage)(
      await cli(repository, ["operation", "list", "--limit", "2"])
    );
    expect(firstHistory.cursor).not.toBeNull();
    const nextHistory = Schema.decodeUnknownSync(OperationPage)(
      await cli(repository, [
        "operation",
        "list",
        "--limit",
        "2",
        "--cursor",
        firstHistory.cursor ?? "",
      ])
    );
    expect(nextHistory.snapshot).toBe(firstHistory.snapshot);
    expect(nextHistory.cursor).toBeNull();
    expect(
      new Set(
        [...firstHistory.items, ...nextHistory.items].map(
          (item) => item.operationId
        )
      ).size
    ).toBe(4);
    const failed = Schema.decodeUnknownSync(OperationPage)(
      await cli(repository, [
        "operation",
        "list",
        "--kind",
        "Remove",
        "--status",
        "Failed",
      ])
    );
    expect(failed.items.map((item) => item.operationId)).toEqual([
      refused.operationId,
    ]);
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
}, 180_000);
