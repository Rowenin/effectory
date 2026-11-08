/* oxlint-disable no-await-in-loop -- Process-level state polling depends on each observation and has a bounded deadline. */
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RunPage } from "@effectory/runtime/history-protocol";
import { Run } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { cli, start } from "./fixtures/cli.ts";

test("CLI tag submissions, descriptions and conjunctive filters survive daemon restart", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "effectory-tag-cli-"));
  const processes: Awaited<ReturnType<typeof start>>[] = [];
  try {
    await writeFile(
      path.join(repository, "effectory.ts"),
      await readFile(
        path.resolve(import.meta.dir, "../../../examples/tagged/effectory.ts")
      )
    );
    const first = await start(repository);
    processes.push(first);
    const description = await cli(repository, [
      "workflow",
      "describe",
      "reporting",
    ]);
    expect(description).toMatchObject({
      tagSchemas: { build: expect.any(Object) },
      tags: { team: "platform" },
    });
    const request = [
      "workflow",
      "run",
      "reporting",
      "--input",
      "null",
      "--tag",
      "build=042",
      "--tag",
      "deployment=deploy-42",
      "--request-key",
      "tag-example",
    ];
    let run = Schema.decodeUnknownSync(Run)(await cli(repository, request));
    expect(run.tags).toEqual({
      build: "042",
      deployment: "deploy-42",
      team: "platform",
    });
    for (let index = 0; index < 30 && run.status !== "Succeeded"; index += 1) {
      await Bun.sleep(50);
      run = Schema.decodeUnknownSync(Run)(
        await cli(repository, ["run", "get", run.runId])
      );
    }
    expect(run.status).toBe("Succeeded");
    expect(run.result).toBe("platform: build 42");
    first.kill("SIGKILL");
    await first.exited;
    processes.push(await start(repository));
    const repeated = Schema.decodeUnknownSync(Run)(
      await cli(repository, request)
    );
    expect(repeated.runId).toBe(run.runId);
    expect(repeated.tags).toEqual(run.tags);
    const page = Schema.decodeUnknownSync(RunPage)(
      await cli(repository, [
        "run",
        "list",
        "--tag",
        "deployment=deploy-42",
        "--tag",
        "build=042",
      ])
    );
    expect(page.items.map((item) => item.runId)).toEqual([run.runId]);
    const absent = Schema.decodeUnknownSync(RunPage)(
      await cli(repository, [
        "run",
        "list",
        "--tag",
        "deployment=deploy-42",
        "--tag",
        "build=42",
      ])
    );
    expect(absent.items).toEqual([]);
  } finally {
    for (const child of processes) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
    await rm(repository, { force: true, recursive: true });
  }
}, 120_000);
