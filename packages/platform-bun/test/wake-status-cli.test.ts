/* oxlint-disable no-await-in-loop */
// Phase gates and process readiness are observed sequentially with deadlines.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Run } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { approval, cli, effectory, start } from "./fixtures/cli.ts";

async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error("Wake status phase did not arrive");
    }
    await Bun.sleep(25);
  }
}

function application(directory: string, signalAfterSleep: boolean) {
  return `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { Application, Task, Workflow } from "@offtree/effectory-sdk";
import { Context, Effect, Layer, Schema } from "effect";
const directory = ${JSON.stringify(directory)};
const Resource = Context.Service("wake/Resource");
const phase = (name) => Effect.sync(() => writeFileSync(directory + "/" + name, "ready"));
const gate = (name) => Effect.gen(function* () { while (!existsSync(directory + "/" + name)) yield* Effect.sleep("10 millis"); });
const task = Task.make({ id: "work", version: 1, input: Schema.Null, success: Schema.Null, error: Schema.Never, replay: "idempotent" }, () => Effect.gen(function* () {
  yield* Resource;
  yield* phase("entered");
  yield* gate("finish");
  return null;
})).provide(Layer.effect(Resource, Effect.acquireRelease(
  Effect.sync(() => { appendFileSync(directory + "/acquisitions", "acquire\\n"); return true; }),
  () => phase("cleaning").pipe(Effect.andThen(gate("release")))
)));
const flow = Workflow.make({ id: "wake", version: 1, input: Schema.Null, success: Schema.String, error: Schema.Never }, Effect.gen(function* () {
  const graph = yield* Workflow.Builder;
  const slept = yield* graph.sleep("delay", "200 millis");
  const signal = yield* graph.registerSignal("answer", { schema: Schema.String, timeout: "1 hour", ${signalAfterSleep ? "after: [slept]" : ""} });
  const work = yield* graph.task("work", task, null, { after: [slept] });
  return yield* graph.awaitSignal("result", signal, { after: [work] });
}));
export default Application.make({ tasks: [task], workflows: [flow] });
`;
}

test.each(["human", "json"] as const)(
  "foreground %s stays attached through wake and cleanup with an open signal",
  async (mode) => {
    const repository = await mkdtemp(
      path.join(tmpdir(), "effectory-wake-cli-")
    );
    const children: ReturnType<typeof Bun.spawn>[] = [];
    try {
      await writeFile(
        path.join(repository, "effectory.ts"),
        application(repository, mode === "json")
      );
      children.push(await start(repository));
      const args = [
        "workflow",
        "run",
        "wake",
        "--input",
        "null",
        "--request-key",
        "wake",
      ];
      const run = Schema.decodeUnknownSync(Run)(
        await cli(repository, [...args, "--background"])
      );
      const current = async () =>
        Schema.decodeUnknownSync(Run)(
          await cli(repository, ["run", "get", run.runId])
        );
      await until(() => existsSync(path.join(repository, "entered")));
      await until(async () => {
        const snapshot = await current();
        return snapshot.status === "Running";
      });
      const wait = await approval(repository, run.runId);
      expect(wait.status).toBe("Open");
      // Reusing the request key observes this same run after the timer has woken.
      const observer = Bun.spawn(
        [
          ...effectory,
          ...args,
          "--repository",
          repository,
          ...(mode === "json" ? ["--json"] : []),
        ],
        { stderr: "pipe", stdout: "pipe" }
      );
      children.push(observer);
      const stdout = new Response(observer.stdout).text();
      const stderr = new Response(observer.stderr).text();
      await Bun.sleep(700);
      expect(observer.exitCode).toBeNull();
      await writeFile(path.join(repository, "finish"), "ready");
      await until(() => existsSync(path.join(repository, "cleaning")));
      await Bun.sleep(700);
      const cleaning = await current();
      expect(cleaning.status).toBe("Running");
      expect(observer.exitCode).toBeNull();
      await writeFile(path.join(repository, "release"), "ready");
      await until(() => observer.exitCode !== null);
      expect(await observer.exited).toBe(4);
      const final = Schema.decodeUnknownSync(Run)(JSON.parse(await stdout));
      expect(final.runId).toBe(run.runId);
      expect(final.status).toBe("Waiting");
      expect(await stderr).toContain(run.runId);
      // Completed task Activities must stay cached when the waiting root restarts.
      await cli(repository, ["daemon", "stop"]);
      children.push(await start(repository));
      const restarted = await current();
      expect(restarted.status).toBe("Waiting");
      expect(
        await readFile(path.join(repository, "acquisitions"), "utf-8")
      ).toBe("acquire\n");
      await cli(repository, [
        "run",
        "signal",
        wait.waitId,
        "--payload",
        '"done"',
      ]);
      await until(async () => {
        const snapshot = await current();
        return snapshot.status === "Succeeded";
      });
      const completed = await current();
      expect(completed.result).toBe("done");
      expect(
        await readFile(path.join(repository, "acquisitions"), "utf-8")
      ).toBe("acquire\n");
    } finally {
      // Open finalizer gates before stopping the daemon, including on assertion failure.
      await writeFile(path.join(repository, "finish"), "ready");
      await writeFile(path.join(repository, "release"), "ready");
      for (const child of children) {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
        }
        await child.exited;
      }
      await rm(repository, { force: true, recursive: true });
    }
  },
  60_000
);
