/* oxlint-disable no-await-in-loop */
// Process state and streamed-output checks have bounded polling deadlines.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RunWatchFrame } from "@effectory/runtime/history-protocol";
import { Run } from "@effectory/runtime/protocol";
import { ServerStatus } from "@effectory/runtime/rpc";
import { Schema } from "effect";

import { approval, cli, effectory, start } from "./fixtures/cli.ts";

const source = `
import { Application, Task, Workflow } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";
const burst = Task.make({ id: "burst", version: 1, input: Schema.Null, success: Schema.String, error: Schema.Never, replay: "idempotent" }, () => Effect.gen(function* () {
 for (let i = 0; i < 45; i += 1) yield* Effect.logInfo("burst-line-" + i);
 yield* Effect.logInfo("DISTINCTIVE-FINAL-LOG");
 return "burst-result";
}));
const slow = Task.make({ id: "slow", version: 1, input: Schema.Null, success: Schema.String, error: Schema.Never, replay: "idempotent" }, () => Effect.gen(function* () {
 yield* Effect.sleep("500 millis");
 yield* Effect.logInfo("AFTER-STDERR-CLOSE");
 yield* Effect.sleep("100 millis");
 return "slow-result";
}));
const review = Workflow.make({ id: "review", version: 1, input: Schema.Null, success: Schema.String, error: Schema.Never }, Effect.gen(function* () {
 const graph = yield* Workflow.Builder;
 const logged = yield* graph.task("logs", burst, null);
 const approved = yield* graph.approval("approval", { after: [logged], prompt: "Continue?", timeout: "1 hour" });
 return yield* graph.task("finish", slow, null, { after: [approved] });
}));
export default Application.make({ tasks: [burst, slow], workflows: [review] });
`;

const collect = async (
  stream: ReadableStream<Uint8Array>,
  append: (text: string) => void
) => {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    append(decoder.decode(chunk, { stream: true }));
  }
  append(decoder.decode());
};

function launch(repository: string, args: readonly string[]) {
  const child = Bun.spawn([...effectory, ...args, "--repository", repository], {
    stderr: "pipe",
    stdout: "pipe",
  });
  let stdout = "";
  let stderr = "";
  const output = collect(child.stdout, (text) => {
    stdout += text;
  });
  const errors = collect(child.stderr, (text) => {
    stderr += text;
  });
  return {
    child,
    done: async () => {
      const [code] = await Promise.all([child.exited, output, errors]);
      return { code, stderr, stdout };
    },
    get stderr() {
      return stderr;
    },
    get stdout() {
      return stdout;
    },
  };
}
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${label}`);
    }
    await Bun.sleep(25);
  }
}
const runFrom = (text: string) =>
  Schema.decodeUnknownSync(Run)(JSON.parse(text));
const sequences = (stderr: string) =>
  Array.from(stderr.matchAll(/^#(?<sequence>\d+) /gmu), (match) =>
    Number(match.groups?.sequence)
  );

test("human console drains a fast log tail, replays completed runs, honors cursors and preserves machine modes", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-live-console-")
  );
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const execute = async (args: readonly string[]) => {
    const process = launch(repository, args);
    children.push(process.child);
    return await process.done();
  };
  try {
    await writeFile(path.join(repository, "effectory.ts"), source);
    children.push(await start(repository));
    const foreground = await execute([
      "task",
      "run",
      "burst",
      "--input",
      "null",
    ]);
    expect(foreground.code).toBe(0);
    const run = runFrom(foreground.stdout);
    expect(run.status).toBe("Succeeded");
    expect(run.result).toBe("burst-result");
    expect(foreground.stderr).toContain("DISTINCTIVE-FINAL-LOG");
    expect(foreground.stderr).toMatch(/RunStatus.*Succeeded/u);
    expect(foreground.stdout).toBe(`${JSON.stringify(run, null, 2)}\n`);
    const replay = await execute(["run", "watch", run.runId]);
    expect(replay.code).toBe(0);
    expect(replay.stdout).toBe(foreground.stdout);
    expect(replay.stderr).toContain("DISTINCTIVE-FINAL-LOG");
    const history = sequences(replay.stderr);
    expect(history.length).toBeGreaterThan(40);
    expect(history).toEqual(
      Array.from({ length: history.length }, (_, index) => index + 1)
    );
    const cursor = history[20] ?? 0;
    const resumed = await execute([
      "run",
      "watch",
      run.runId,
      "--after-sequence",
      String(cursor),
    ]);
    expect(resumed.code).toBe(0);
    expect(sequences(resumed.stderr)).toEqual(
      history.filter((sequence) => sequence > cursor)
    );
    const machine = await execute([
      "run",
      "watch",
      run.runId,
      "--json",
      "--after-sequence",
      String(cursor),
    ]);
    expect(machine.code).toBe(0);
    expect(machine.stderr).toBe("");
    expect(machine.stdout).toBe(`${JSON.stringify(run)}\n`);
    for (const flags of [["--jsonl"], ["--jsonl", "--json"]]) {
      const jsonl = await execute(["run", "watch", run.runId, ...flags]);
      expect(jsonl.code).toBe(0);
      expect(jsonl.stderr).toBe("");
      const frames = jsonl.stdout
        .trim()
        .split("\n")
        .map((line) =>
          Schema.decodeUnknownSync(RunWatchFrame)(JSON.parse(line))
        );
      expect(
        frames
          .filter((frame) => frame._tag === "Event")
          .map((frame) => frame.event.sequence)
      ).toEqual(history);
    }
    for (const flags of [[], ["--json"]]) {
      const invalid = await execute([
        "run",
        "watch",
        run.runId,
        "--after-sequence",
        "999999",
        ...flags,
      ]);
      expect(invalid.code).toBe(2);
      expect(invalid.stderr).toContain("recorded event range");
      expect(invalid.stdout).toBe("");
    }
    const background = await execute([
      "task",
      "run",
      "slow",
      "--input",
      "null",
      "--background",
    ]);
    expect(background.code).toBe(0);
    expect(background.stderr).toBe("");
    expect(
      Schema.decodeUnknownSync(ServerStatus)(
        await cli(repository, ["daemon", "status"])
      ).observers
    ).toBe(0);
    const quiet = await execute([
      "task",
      "run",
      "burst",
      "--input",
      "null",
      "--json",
    ]);
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toBe("");
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
}, 60_000);

test("human progress arrives before approval and a broken stderr leaves the run result available", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-live-console-wait-")
  );
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    await writeFile(path.join(repository, "effectory.ts"), source);
    children.push(await start(repository));
    const foreground = launch(repository, [
      "workflow",
      "run",
      "review",
      "--input",
      "null",
    ]);
    children.push(foreground.child);
    const waiting = await foreground.done();
    expect(waiting.code).toBe(4);
    expect(waiting.stderr).toContain("DISTINCTIVE-FINAL-LOG");
    expect(waiting.stderr.indexOf("WaitOpened")).toBeGreaterThan(0);
    expect(waiting.stderr.indexOf("Outside action")).toBeGreaterThan(
      waiting.stderr.indexOf("WaitOpened")
    );
    const run = runFrom(waiting.stdout);
    const wait = await approval(repository, run.runId);
    const watching = launch(repository, ["run", "watch", run.runId]);
    children.push(watching.child);
    await until(
      () => watching.stderr.includes("WaitOpened"),
      "live wait progress"
    );
    expect(watching.stdout).toBe("");
    expect(watching.child.exitCode).toBeNull();
    await cli(repository, ["run", "approve", wait.waitId]);
    const completed = await watching.done();
    expect(completed.code).toBe(0);
    expect(runFrom(completed.stdout).status).toBe("Succeeded");
    expect(completed.stderr).toContain("AFTER-STDERR-CLOSE");

    const broken = Bun.spawn(
      [
        ...effectory,
        "task",
        "run",
        "slow",
        "--input",
        "null",
        "--repository",
        repository,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    children.push(broken);
    const output = new Response(broken.stdout).text();
    const reader = broken.stderr.getReader();
    const initial = await reader.read();
    expect(initial.done).toBe(false);
    await reader.cancel();
    reader.releaseLock();
    expect(await broken.exited).toBe(0);
    expect(runFrom(await output).result).toBe("slow-result");
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
}, 45_000);
