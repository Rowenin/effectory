/* oxlint-disable no-await-in-loop */
// These loops poll dependent process readiness with a bounded deadline.
import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WaitPage } from "@effectory/runtime/history-protocol";
import { QueryPage, Content } from "@effectory/runtime/lake-protocol";
import { Run, Wait, WaitReceipt } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { Endpoint } from "../src/daemon.ts";
import { effectory } from "./fixtures/cli.ts";

const workspace = path.resolve(import.meta.dir, "../../..");
async function cli(repository: string, args: string[]) {
  const child = Bun.spawn(
    [...effectory, ...args, "--repository", repository, "--json"],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `CLI ${args.join(" ")} exited ${code}: ${stderr}\n${stdout}`
    );
  }
  return JSON.parse(stdout) as unknown;
}
async function start(repository: string) {
  const child = Bun.spawn(
    [...effectory, "daemon", "serve", "--repository", repository],
    { stderr: "pipe", stdout: "pipe" }
  );
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(await new Response(child.stderr).text());
    }
    try {
      await cli(repository, ["daemon", "status"]);
      return child;
    } catch {
      await Bun.sleep(100);
    }
  }
  child.kill();
  throw new Error("Daemon did not start");
}
async function waitForApproval(repository: string, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waits = Schema.decodeUnknownSync(WaitPage)(
      await cli(repository, ["run", "waits", runId])
    );
    const [wait] = waits.items;
    if (wait) {
      return Schema.decodeUnknownSync(Wait)(
        await cli(repository, ["run", "wait", wait.waitId])
      );
    }
    await Bun.sleep(50);
  }
  throw new Error("Approval did not open");
}

test("CLI/RPC daemon retains a waiting revision and queries its artifact after restart", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "effectory-daemon-"));
  const source = await readFile(
    path.join(workspace, "examples/greeting/effectory.ts"),
    "utf-8"
  );
  await writeFile(path.join(repository, "effectory.ts"), source);
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const first = await start(repository);
    processes.push(first);
    const endpoint = Schema.decodeUnknownSync(Endpoint)(
      JSON.parse(
        await readFile(path.join(repository, ".effectory/daemon.json"), "utf-8")
      )
    );
    const unauthorized = await fetch(endpoint.url, {
      body: "[]",
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);
    const description = await cli(repository, [
      "workflow",
      "describe",
      "example/welcome",
    ]);
    expect(description).toHaveProperty("input");
    const args = [
      "workflow",
      "run",
      "example/welcome",
      "--input",
      '{"name":"Ada"}',
      "--request-key",
      "ada",
      "--background",
    ];
    const run = Schema.decodeUnknownSync(Run)(await cli(repository, args));
    const wait = await waitForApproval(repository, run.runId);
    first.kill("SIGKILL");
    await first.exited;
    await writeFile(
      path.join(repository, "effectory.ts"),
      source.replace("Hello", "Goodbye")
    );
    const second = await start(repository);
    processes.push(second);
    const duplicate = Schema.decodeUnknownSync(Run)(
      await cli(repository, args)
    );
    expect(duplicate.runId).toBe(run.runId);
    expect(duplicate.revision).toBe(run.revision);
    const recoveredWait = await waitForApproval(repository, run.runId);
    expect(recoveredWait.waitId).toBe(wait.waitId);
    const receipt = Schema.decodeUnknownSync(WaitReceipt)(
      await cli(repository, [
        "run",
        "approve",
        wait.waitId,
        "--request-key",
        "approval",
      ])
    );
    expect(receipt.outcome).toBe("Approved");
    expect(
      Schema.decodeUnknownSync(WaitReceipt)(
        await cli(repository, [
          "run",
          "approve",
          wait.waitId,
          "--request-key",
          "approval",
        ])
      )
    ).toEqual(receipt);
    const completed = Schema.decodeUnknownSync(Run)(
      await cli(repository, ["run", "watch", run.runId])
    );
    expect(completed.status).toBe("Succeeded");
    const queryFile = path.join(workspace, "examples/greeting/query.json");
    const page = Schema.decodeUnknownSync(QueryPage)(
      await cli(repository, ["lake", "query", "--file", queryFile])
    );
    expect(page.rows).toHaveLength(1);
    const [record] = page.rows;
    if (!record) {
      throw new Error("No greeting artifact");
    }
    expect(record.runId).toBe(run.runId);
    expect(record.revision).toBe(run.revision);
    const content = Schema.decodeUnknownSync(Content)(
      await cli(repository, [
        "lake",
        "get",
        record.artifactId,
        "--version",
        "1",
      ])
    );
    expect(content.value).toEqual({ greeting: "Hello Ada" });
    const compoundFile = path.join(repository, "compound-query.json");
    await writeFile(
      compoundFile,
      JSON.stringify({
        artifact: { schemaId: "example/greeting", schemaVersion: 1 },
        limit: 10,
        orderBy: [{ direction: "asc", field: { json: ["greeting"] } }],
        select: [{ field: { json: ["greeting"] }, name: "greeting" }],
        version: 1,
        versions: "latest",
        where: {
          _tag: "And",
          terms: [
            { _tag: "Eq", field: { tag: "source" }, value: "example" },
            {
              _tag: "Not",
              term: {
                _tag: "Eq",
                field: { json: ["greeting"] },
                value: "absent",
              },
            },
          ],
        },
      })
    );
    const projected = Schema.decodeUnknownSync(QueryPage)(
      await cli(repository, ["lake", "query", "--file", compoundFile])
    );
    expect(projected.rows[0]?.projection).toEqual({ greeting: "Hello Ada" });
    await cli(repository, ["daemon", "stop", "--grace-period-ms", "0"]);
    expect(await second.exited).toBe(0);
  } finally {
    for (const child of processes) {
      child.kill();
    }
    await Promise.all(processes.map((child) => child.exited));
    await rm(repository, { force: true, recursive: true });
  }
}, 60_000);

// Two daemon boots, two workflow runs and separate CLI inspections need headroom
// when the full suite also compiles binaries and exercises process recovery.
test("waiting runs retain separately bundled extension contracts, services, providers and approval patches", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-extension-revision-")
  );
  await cp(path.join(workspace, "examples/extensions"), repository, {
    recursive: true,
  });
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const first = await start(repository);
    processes.push(first);
    const args = [
      "workflow",
      "run",
      "example/release",
      "--input",
      '{"repository":"swamp-club/swamp"}',
      "--request-key",
      "release",
      "--background",
    ];
    const run = Schema.decodeUnknownSync(Run)(await cli(repository, args));
    const wait = await waitForApproval(repository, run.runId);
    expect(wait.context).toBe("release/swamp-club/swamp");
    expect(JSON.parse(wait.nodeId)).toEqual([
      "publish",
      "$patch",
      "release-review",
      "review",
    ]);
    const plan = await cli(repository, [
      "workflow",
      "plan",
      "example/release",
      "--input",
      '{"repository":"swamp-club/swamp"}',
    ]);
    expect(plan).toHaveProperty(
      "nodes.1.providerId",
      "example/release-tools/publish"
    );
    expect(plan).toHaveProperty("nodes.1.patches.0.id", "release-review");
    first.kill("SIGKILL");
    await first.exited;
    const extensionPath = path.join(repository, "extension.ts");
    const old = await readFile(extensionPath, "utf-8");
    await writeFile(
      extensionPath,
      old
        .replace("published:", "updated:")
        .replace("Publish this release?", "Updated approval")
    );
    const second = await start(repository);
    processes.push(second);
    const duplicate = Schema.decodeUnknownSync(Run)(
      await cli(repository, args)
    );
    expect(duplicate.runId).toBe(run.runId);
    expect(duplicate.revision).toBe(run.revision);
    const recovered = await waitForApproval(repository, run.runId);
    expect(recovered.waitId).toBe(wait.waitId);
    expect(recovered.prompt).toBe("Publish this release?");
    await cli(repository, [
      "run",
      "approve",
      wait.waitId,
      "--request-key",
      "old-approval",
    ]);
    const finished = Schema.decodeUnknownSync(Run)(
      await cli(repository, ["run", "watch", run.runId])
    );
    expect(finished.status).toBe("Succeeded");
    expect(finished.result).toBe("published:release/swamp-club/swamp");
    const current = Schema.decodeUnknownSync(Run)(
      await cli(
        repository,
        args.map((arg) => (arg === "release" ? "new-release" : arg))
      )
    );
    expect(current.revision).not.toBe(run.revision);
    const currentWait = await waitForApproval(repository, current.runId);
    expect(currentWait.prompt).toBe("Updated approval");
    await cli(repository, [
      "run",
      "approve",
      currentWait.waitId,
      "--request-key",
      "new-approval",
    ]);
    const latest = Schema.decodeUnknownSync(Run)(
      await cli(repository, ["run", "watch", current.runId])
    );
    expect(latest.result).toBe("updated:release/swamp-club/swamp");
    await cli(repository, ["daemon", "stop", "--grace-period-ms", "0"]);
    expect(await second.exited).toBe(0);
  } finally {
    for (const child of processes) {
      child.kill();
    }
    await Promise.all(processes.map((child) => child.exited));
    await rm(repository, { force: true, recursive: true });
  }
}, 120_000);
