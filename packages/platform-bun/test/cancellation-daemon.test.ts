/* oxlint-disable no-await-in-loop */
// Run state polling has a fixed attempt bound and depends on preceding reads.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RunPage, RunWatchFrame } from "@effectory/runtime/history-protocol";
import { CancellationReceipt, Run, Wait } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { Credentials, Endpoint } from "../src/daemon.ts";
import { approval, cli, effectory, start } from "./fixtures/cli.ts";
import { workspace } from "./fixtures/published-extension.ts";

test("CLI cancellation survives daemon death and retry without reopening the durable wait", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-cancel-cli-")
  );
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    await writeFile(
      path.join(repository, "effectory.ts"),
      await readFile(
        path.join(workspace, "examples/greeting/effectory.ts"),
        "utf-8"
      )
    );
    const first = await start(repository);
    children.push(first);
    const endpoint = Schema.decodeUnknownSync(Endpoint)(
      JSON.parse(
        await readFile(path.join(repository, ".effectory/daemon.json"), "utf-8")
      )
    );
    const credentials = Schema.decodeUnknownSync(Credentials)(
      JSON.parse(
        await readFile(
          path.join(repository, ".effectory/credentials.json"),
          "utf-8"
        )
      )
    );
    const excessive = await fetch(endpoint.url, {
      body: `${"[".repeat(100)}null${"]".repeat(100)}`,
      headers: {
        authorization: `Bearer ${credentials.token}`,
        "x-effectory-protocol": "1",
        "x-effectory-repository": credentials.repositoryId,
      },
      method: "POST",
    });
    expect(excessive.status).toBe(413);
    const invalidQuery = await fetch(endpoint.url, {
      body: JSON.stringify([
        {
          _tag: "Request",
          headers: [],
          id: "invalid",
          payload: {
            query: {
              artifact: { schemaId: "example/greeting", schemaVersion: 1 },
              limit: 1,
              unsupported: true,
              version: 1,
              versions: "all",
            },
          },
          tag: "LakeQuery",
        },
      ]),
      headers: {
        authorization: `Bearer ${credentials.token}`,
        "x-effectory-protocol": "1",
        "x-effectory-repository": credentials.repositoryId,
      },
      method: "POST",
    });
    expect(invalidQuery.status).toBe(400);

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
    const args = [
      "run",
      "cancel",
      run.runId,
      "--request-key",
      "operator-stop",
      "--reason",
      "No longer needed",
    ];
    const receipt = Schema.decodeUnknownSync(CancellationReceipt)(
      await cli(repository, args)
    );
    expect(receipt.status).toBe("Cancelling");
    first.kill("SIGKILL");
    await first.exited;
    children.push(await start(repository));
    expect(
      Schema.decodeUnknownSync(CancellationReceipt)(await cli(repository, args))
    ).toEqual(receipt);
    expect(
      Schema.decodeUnknownSync(Wait)(
        await cli(repository, ["run", "wait", wait.waitId])
      ).status
    ).toBe("Cancelled");
    let finished = false;
    for (let count = 0; count < 100; count += 1) {
      const snapshot = Schema.decodeUnknownSync(Run)(
        await cli(repository, ["run", "get", run.runId])
      );
      if (snapshot.status === "Cancelled") {
        finished = true;
        break;
      }
      await Bun.sleep(50);
    }
    expect(finished).toBe(true);
    const history = Schema.decodeUnknownSync(RunPage)(
      await cli(repository, [
        "run",
        "list",
        "--status",
        "Cancelled",
        "--limit",
        "1",
      ])
    );
    expect(history.items[0]?.runId).toBe(run.runId);
    const watch = Bun.spawn(
      [
        ...effectory,
        "run",
        "watch",
        run.runId,
        "--repository",
        repository,
        "--jsonl",
        "--after-sequence",
        "1",
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    children.push(watch);
    const [stdout, stderr, code] = await Promise.all([
      new Response(watch.stdout).text(),
      new Response(watch.stderr).text(),
      watch.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(1);
    const frames = stdout
      .trim()
      .split("\n")
      .map((line) => Schema.decodeUnknownSync(RunWatchFrame)(JSON.parse(line)));
    const events = frames
      .filter((frame) => frame._tag === "Event")
      .map((frame) => frame.event);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from(
        { length: (history.items[0]?.lastSequence ?? 0) - 1 },
        (_, index) => index + 2
      )
    );
    expect(events.at(-1)?.payload).toEqual({ status: "Cancelled" });
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
      })
    );
    await rm(repository, { force: true, recursive: true });
  }
  // This scenario starts many cold CLI processes; runtime deadlines remain unchanged.
}, 90_000);
