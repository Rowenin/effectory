/* oxlint-disable no-await-in-loop */
// Process readiness and streamed-output polling have bounded deadlines.
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
const finish = Task.make({ id: "finish", version: 1, error: Schema.Never, input: Schema.Null, success: Schema.String, replay: "idempotent" }, () => Effect.succeed("done"));
let attempts = 0;
const RetryLater = Schema.TaggedStruct("RetryLater", {});
const retry = Task.make({ id: "retry", version: 1, input: Schema.Null, success: Schema.String, error: RetryLater, replay: "idempotent" }, () => Effect.suspend(() => ++attempts === 1 ? Effect.fail({ _tag: "RetryLater" }) : Effect.succeed("retried")));
const timer = Workflow.make({ id: "timer", version: 1, error: Schema.Never, input: Schema.Null, success: Schema.String }, Effect.gen(function* () {
 const graph = yield* Workflow.Builder;
 const slept = yield* graph.sleep("delay", "1500 millis");
 return yield* graph.task("finish", finish, null, { after: [slept] });
}));
const backoff = Workflow.make({ id: "backoff", version: 1, input: Schema.Null, success: Schema.String, error: RetryLater }, Effect.gen(function* () {
 const graph = yield* Workflow.Builder;
 return yield* graph.task("retry", retry, null, { retry: { attempts: 2, delay: "1500 millis", when: ["RetryLater"] } });
}));
const review = Workflow.make({ id: "review", version: 1, error: Schema.Never, input: Schema.Null, success: Schema.String }, Effect.gen(function* () {
 const graph = yield* Workflow.Builder;
 const slept = yield* graph.sleep("delay", "300 millis");
 const finished = yield* graph.task("finish", finish, null, { after: [slept] });
 const approved = yield* graph.approval("approval", { after: [finished], prompt: "Continue?", timeout: "1 hour" });
 return yield* graph.task("final", finish, null, { after: [approved] });
}));
const input = Workflow.make({ id: "input", version: 1, error: Schema.Never, input: Schema.Null, success: Schema.String }, Effect.gen(function* () {
 const graph = yield* Workflow.Builder;
 return yield* graph.requestInput("answer", { prompt: "Answer", schema: Schema.String, timeout: "1 hour" });
}));
const signal = Workflow.make({ id: "signal", version: 1, error: Schema.Never, input: Schema.Null, success: Schema.String }, Effect.gen(function* () {
 const graph = yield* Workflow.Builder;
 return yield* graph.waitForSignal("answer", { schema: Schema.String, timeout: "1 hour" });
}));
const longTimer = Workflow.make({ id: "long-timer", version: 1, error: Schema.Never, input: Schema.Null, success: Schema.String }, Effect.gen(function* () {
 const graph = yield* Workflow.Builder;
 const slept = yield* graph.sleep("delay", "1 hour");
 return yield* graph.task("finish", finish, null, { after: [slept] });
}));
export default Application.make({ tasks: [finish, retry], workflows: [timer, backoff, review, input, signal, longTimer] });
`;

function launch(repository: string, args: readonly string[]) {
  const child = Bun.spawn([...effectory, ...args, "--repository", repository], {
    stderr: "pipe",
    stdout: "pipe",
  });
  let stdout = "";
  const output = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      stdout += decoder.decode(chunk, { stream: true });
    }
    stdout += decoder.decode();
  })();
  const errors = new Response(child.stderr).text();
  return {
    child,
    done: async () => {
      const [code, stderr] = await Promise.all([child.exited, errors, output]);
      return { code, stderr, stdout };
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
function frames(text: string) {
  return text
    .split("\n")
    .slice(0, -1)
    .filter(Boolean)
    .map((line) => Schema.decodeUnknownSync(RunWatchFrame)(JSON.parse(line)));
}

test("live CLI streams before approval, resumes across restart, and distinguishes stop from SIGINT", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-live-watch-")
  );
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    await writeFile(path.join(repository, "effectory.ts"), source);
    children.push(await start(repository));
    const run = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "workflow",
        "run",
        "review",
        "--input",
        "null",
        "--background",
      ])
    );
    const wait = await approval(repository, run.runId);
    const watch = launch(repository, ["run", "watch", run.runId, "--jsonl"]);
    children.push(watch.child);
    await until(
      () => frames(watch.stdout).some((frame) => frame._tag === "Event"),
      "events before approval"
    );
    expect(watch.child.exitCode).toBeNull();
    expect(frames(watch.stdout)[0]?._tag).toBe("Snapshot");
    expect(
      Schema.decodeUnknownSync(Run)(
        await cli(repository, ["run", "get", run.runId])
      ).status
    ).toBe("Waiting");
    watch.child.kill("SIGINT");
    const interrupted = await watch.done();
    expect(interrupted.code).toBe(130);
    expect(interrupted.stderr).not.toContain("run watch");
    let active = 1;
    for (let count = 0; count < 20 && active > 0; count += 1) {
      active = Schema.decodeUnknownSync(ServerStatus)(
        await cli(repository, ["daemon", "status"])
      ).observers;
      if (active > 0) {
        await Bun.sleep(25);
      }
    }
    expect(active).toBe(0);
    const events = frames(interrupted.stdout).filter(
      (frame) => frame._tag === "Event"
    );
    const last = events.at(-1)?.event.sequence ?? 0;
    expect(last).toBeGreaterThan(0);

    const watching = launch(repository, [
      "run",
      "watch",
      run.runId,
      "--jsonl",
      "--after-sequence",
      String(last),
    ]);
    children.push(watching.child);
    await until(() => frames(watching.stdout).length > 0, "resumed snapshot");
    await cli(repository, ["daemon", "stop", "--grace-period-ms", "0"]);
    const stopped = await watching.done();
    expect(stopped.code).toBe(3);
    expect(stopped.stderr).toContain(run.runId);
    expect(stopped.stderr).toContain("--after-sequence");
    children.push(await start(repository));
    const resumed = launch(repository, [
      "run",
      "watch",
      run.runId,
      "--jsonl",
      "--after-sequence",
      String(last),
    ]);
    children.push(resumed.child);
    await until(() => frames(resumed.stdout).length > 0, "restart snapshot");
    await cli(repository, ["run", "approve", wait.waitId]);
    const completed = await resumed.done();
    expect(completed.code).toBe(0);
    const replayed = frames(completed.stdout);
    const sequences = replayed
      .filter((frame) => frame._tag === "Event")
      .map((frame) => frame.event.sequence);
    expect(sequences.length).toBeGreaterThan(0);
    expect(sequences).toEqual(
      Array.from({ length: sequences.length }, (_, index) => last + index + 1)
    );
    expect(
      replayed.some(
        (frame) => frame._tag === "Snapshot" && frame.run.status === "Succeeded"
      )
    ).toBe(true);
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

test("foreground waits through timers and retry backoff, then returns at an approval after a timer", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-foreground-watch-")
  );
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    await writeFile(path.join(repository, "effectory.ts"), source);
    children.push(await start(repository));
    for (const workflow of ["timer", "backoff"]) {
      const foreground = launch(repository, [
        "workflow",
        "run",
        workflow,
        "--input",
        "null",
        "--json",
      ]);
      children.push(foreground.child);
      const result = await foreground.done();
      expect(result.code).toBe(0);
      expect(
        Schema.decodeUnknownSync(Run)(JSON.parse(result.stdout)).status
      ).toBe("Succeeded");
    }
    for (const workflow of ["review", "input", "signal"]) {
      const foreground = launch(repository, [
        "workflow",
        "run",
        workflow,
        "--input",
        "null",
        "--json",
      ]);
      children.push(foreground.child);
      const result = await foreground.done();
      expect(result.code).toBe(4);
      const run = Schema.decodeUnknownSync(Run)(JSON.parse(result.stdout));
      expect(run.status).toBe("Waiting");
      expect(result.stderr).toContain(run.runId);
      const wait = await approval(repository, run.runId);
      expect(wait.status).toBe("Open");
    }
    const foreground = launch(repository, [
      "workflow",
      "run",
      "long-timer",
      "--input",
      "null",
      "--json",
    ]);
    children.push(foreground.child);
    let observers = 0;
    for (let count = 0; count < 30 && observers === 0; count += 1) {
      ({ observers } = Schema.decodeUnknownSync(ServerStatus)(
        await cli(repository, ["daemon", "status"])
      ));
      if (observers === 0) {
        await Bun.sleep(50);
      }
    }
    expect(observers).toBe(1);
    await cli(repository, ["daemon", "stop", "--grace-period-ms", "0"]);
    const stopped = await foreground.done();
    expect(stopped.code).toBe(3);
    expect(stopped.stderr).toContain("run get");
    expect(stopped.stderr).toContain("accepted");
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
