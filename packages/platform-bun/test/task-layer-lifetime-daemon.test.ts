import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EventPage } from "@effectory/runtime/history-protocol";
import { Run } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { approval, cli, start } from "./fixtures/cli.ts";

const Record = Schema.Struct({
  at: Schema.Finite,
  id: Schema.String,
  phase: Schema.String,
});
const application = (marker: string) => `
import { appendFileSync } from "node:fs";
import { Application, Task, Workflow } from "@offtree/effectory-sdk";
import { Context, Effect, Layer, Schema } from "effect";
const Resource = Context.Service("test/TaskLayerLifetime");
const record = (phase, id) => appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ at: Date.now(), id, phase }) + "\\n");
const resources = Layer.effect(Resource, Effect.acquireRelease(
 Effect.sync(() => { const id = crypto.randomUUID(); record("acquire", id); return id; }),
 (id) => Effect.sync(() => record("release", id))
));
const RetryLater = Schema.TaggedStruct("RetryLater", {});
const retry = Task.make({ id: "retry", version: 1, input: Schema.Null, success: Schema.String, error: RetryLater, replay: "idempotent" }, (_, context) => Effect.gen(function* () {
 const id = yield* Resource;
 record("attempt-" + context.attempt, id);
 if (context.attempt === 1) return yield* Effect.fail({ _tag: "RetryLater" });
 return id;
})).provide(resources);
const finish = Task.make({ id: "finish", version: 1, input: Schema.Null, success: Schema.String, error: Schema.Never, replay: "idempotent" }, () => Effect.gen(function* () {
 const id = yield* Resource;
 record("finish", id);
 return id;
})).provide(resources);
const workflow = Workflow.make({ id: "lifetime", version: 1, input: Schema.Null, success: Schema.String, error: RetryLater }, Effect.gen(function* () {
 const graph = yield* Workflow.Builder;
 const retried = yield* graph.task("retry", retry, null, { retry: { attempts: 2, delay: "500 millis", when: ["RetryLater"] } });
 const approved = yield* graph.approval("approval", { after: [retried], prompt: "Continue?", timeout: "1 hour" });
 return yield* graph.task("finish", finish, null, { after: [approved] });
}));
export default Application.make({ tasks: [retry, finish], workflows: [workflow] });
`;

test("task Layers close before retry and approval, and completed attempts stay closed across daemon restart", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-task-lifetime-")
  );
  const marker = path.join(repository, "lifetime.jsonl");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const records = async () => {
    const text = await readFile(marker, "utf-8");
    return text
      .trim()
      .split("\n")
      .map((line) => Schema.decodeUnknownSync(Record)(JSON.parse(line)));
  };
  try {
    await writeFile(path.join(repository, "effectory.ts"), application(marker));
    const first = await start(repository);
    children.push(first);
    const run = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "workflow",
        "run",
        "lifetime",
        "--input",
        "null",
        "--background",
      ])
    );
    const wait = await approval(repository, run.runId);
    const before = await records();
    expect(before.map((entry) => entry.phase)).toEqual([
      "acquire",
      "attempt-1",
      "release",
      "acquire",
      "attempt-2",
      "release",
    ]);
    expect(before[0]?.id).not.toBe(before[3]?.id);
    expect(
      before.slice(0, 3).every((entry) => entry.id === before[0]?.id)
    ).toBe(true);
    expect(before.slice(3).every((entry) => entry.id === before[3]?.id)).toBe(
      true
    );
    const events = Schema.decodeUnknownSync(EventPage)(
      await cli(repository, ["run", "events", run.runId])
    );
    const scheduled = events.items.find(
      (event) => event.tag === "RetryScheduled"
    );
    expect(scheduled).toBeDefined();
    expect(before[2]?.at).toBeLessThanOrEqual(Date.parse(scheduled?.at ?? ""));
    first.kill("SIGKILL");
    await first.exited;
    children.push(await start(repository));
    const restored = await approval(repository, run.runId);
    expect(restored.waitId).toBe(wait.waitId);
    expect(await records()).toEqual(before);
    await cli(repository, ["run", "approve", wait.waitId]);
    const finished = Schema.decodeUnknownSync(Run)(
      await cli(repository, ["run", "watch", run.runId])
    );
    expect(finished.status).toBe("Succeeded");
    const after = await records();
    expect(after.slice(0, 6)).toEqual(before);
    expect(after.slice(6).map((entry) => entry.phase)).toEqual([
      "acquire",
      "finish",
      "release",
    ]);
    expect(after[6]?.id).not.toBe(before[3]?.id);
    expect(after.slice(6).every((entry) => entry.id === after[6]?.id)).toBe(
      true
    );
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
