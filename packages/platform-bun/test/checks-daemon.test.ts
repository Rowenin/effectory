/* oxlint-disable no-await-in-loop -- Polling verifies persisted state before each process transition. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CheckPage } from "@effectory/runtime/check-protocol";
import { Run, terminal } from "@effectory/runtime/protocol";
import { RecoveryAssessment } from "@effectory/runtime/recovery-protocol";
import { Schema } from "effect";

import { cli, effectory, start } from "./fixtures/cli.ts";

const source = (gateDirectory: string) => `
import { Application, AssertionFailed, Checks, Task, Workflow } from "@offtree/effectory-sdk";
import { Context, Effect, Layer, Schema } from "effect";
// The parent opens these gates only after the process has been killed. CLI
// startup latency must not decide whether a crash lands before completion.
const gateDirectory = ${JSON.stringify(gateDirectory)};
const gate = (name) => Effect.gen(function* () {
  while (!(yield* Effect.promise(() => Bun.file(gateDirectory + "/" + name).exists()))) {
    yield* Effect.sleep("10 millis");
  }
});
class Setup extends Context.Service<Setup, boolean>()("checks/Setup") {}
const setup = Layer.effect(Setup, Effect.gen(function* () {
  yield* (yield* Checks).assert("setup", Effect.scoped(Effect.succeed(true)), { message: "setup passed" });
  return true;
}));
const task = Task.make({ id: "verify", version: 1, input: Schema.String, success: Schema.Boolean, error: AssertionFailed, replay: "idempotent" }, (mode) => Effect.gen(function* () {
  yield* Setup;
  const checks = yield* Checks;
  if (mode === "crash") yield* checks.assert("long", gate("crash").pipe(Effect.as(true)), { message: "re-entry must evaluate again" });
  yield* checks.assert("final", Effect.succeed(mode !== "fail"), { message: "A & B < C 😀", severity: "low" });
  if (mode === "completed") yield* gate("completed");
  return true;
})).provide(setup);
const manual = Task.make({ id: "manual", version: 1, input: Schema.Null, success: Schema.Boolean, error: AssertionFailed, replay: "manual" }, () => Effect.gen(function* () {
  yield* (yield* Checks).assert("uncertain", gate("manual").pipe(Effect.as(true)), { message: "manual" });
  return true;
}));
const retry = Task.make({ id: "retry", version: 1, input: Schema.Null, success: Schema.Boolean, error: AssertionFailed, replay: "idempotent" }, (_, context) => Effect.gen(function* () {
  if (context.attempt === 1) yield* (yield* Checks).assert("retry-check", Effect.succeed(false), { message: "retry then no check" });
  return true;
}));
const retryFlow = Workflow.make({ id: "retry-flow", version: 1, input: Schema.Null, success: Schema.Boolean, error: AssertionFailed }, Effect.gen(function* () {
  return yield* (yield* Workflow.Builder).task("retry", retry, null, { retry: { attempts: 2, delay: "50 millis", when: ["AssertionFailed"] } });
}));
const child = Workflow.make({ id: "child", version: 1, input: Schema.String, success: Schema.Boolean, error: AssertionFailed }, Effect.gen(function* () {
  const g = yield* Workflow.Builder;
  return yield* g.task("verify", task, yield* g.input(Schema.String));
}));
const Items = Schema.Array(Schema.String);
const fanout = Workflow.make({ id: "fanout", version: 1, input: Items, success: Schema.Array(Schema.Boolean), error: AssertionFailed }, Effect.gen(function* () {
  const g = yield* Workflow.Builder;
  return yield* g.forEach("items", yield* g.input(Items), { concurrency: 2, item: Schema.String, key: (s) => s, maxItems: 5, success: Schema.Boolean }, (item) => Effect.gen(function* () {
    return yield* (yield* Workflow.Builder).workflow("child", child, item);
  }));
}));
const paused = Workflow.make({ id: "paused", version: 1, input: Schema.Null, success: Schema.Boolean, error: AssertionFailed }, Effect.gen(function* () {
  const g = yield* Workflow.Builder;
  const result = yield* g.task("verify", task, "pass");
  yield* g.approval("pause", { after: [result], context: {}, prompt: "continue?", timeout: "1 hour" });
  return result;
}));
export default Application.make({ tasks: [task, manual, retry], workflows: [retryFlow, fanout, paused] });
`;
async function raw(repository: string, args: string[]) {
  const child = Bun.spawn([...effectory, ...args, "--repository", repository], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr, stdout };
}
async function settled(repository: string, id: string) {
  for (let index = 0; index < 80; index += 1) {
    const run = Schema.decodeUnknownSync(Run)(
      await cli(repository, ["run", "get", id])
    );
    if (terminal.has(run.status) || run.status === "NeedsAttention") {
      return run;
    }
    await Bun.sleep(50);
  }
  throw new Error("Run did not settle");
}
async function runningCheck(repository: string, id: string, check: string) {
  for (let index = 0; index < 80; index += 1) {
    const page = Schema.decodeUnknownSync(CheckPage)(
      await cli(repository, ["run", "checks", id])
    );
    if (
      page.items.some((row) => row.id === check && row.status === "Running")
    ) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error("Check did not start");
}

test("real CLI thresholds, completed XML, restart recovery and manual authorization", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "effectory-checks-"));
  let daemon: Awaited<ReturnType<typeof start>> | undefined;
  try {
    await symlink(
      path.resolve(import.meta.dir, "../../../node_modules"),
      path.join(repository, "node_modules"),
      "dir"
    );
    await writeFile(path.join(repository, "effectory.ts"), source(repository));
    daemon = await start(repository);
    const high = await raw(repository, [
      "task",
      "run",
      "verify",
      "--input",
      '"fail"',
      "--fail-on",
      "high",
      "--junit",
    ]);
    expect(high.code).toBe(0);
    expect(high.stdout).toContain('<failure type="AssertionFailed"');
    expect(high.stdout).not.toContain('"status":');
    const parse = Bun.spawn(
      [
        "python3",
        "-c",
        "import sys,xml.etree.ElementTree as E; r=E.fromstring(sys.stdin.read()); assert r.attrib['tests']=='3'; assert len(r.findall('.//failure'))==1; assert len(r.findall('.//error'))==0",
      ],
      { stderr: "pipe", stdin: new Blob([high.stdout]), stdout: "pipe" }
    );
    expect(await parse.exited).toBe(0);
    const low = await raw(repository, [
      "task",
      "run",
      "verify",
      "--input",
      '"fail"',
      "--junit",
    ]);
    expect(low.code).toBe(1);
    expect(low.stdout).toContain('type="Failed"');
    const destination = path.join(repository, "junit.xml");
    await writeFile(destination, "original");
    const refused = await raw(repository, [
      "task",
      "run",
      "verify",
      "--input",
      '"pass"',
      "--junit",
      "--output",
      destination,
    ]);
    expect(refused.code).toBe(2);
    expect(await readFile(destination, "utf-8")).toBe("original");
    const conflict = await raw(repository, [
      "task",
      "run",
      "verify",
      "--input",
      '"pass"',
      "--junit",
      "--background",
    ]);
    expect(conflict.code).toBe(2);

    const retryResult = await raw(repository, [
      "workflow",
      "run",
      "retry-flow",
      "--input",
      "null",
      "--junit",
    ]);
    expect(retryResult.code).toBe(0);
    expect(retryResult.stdout).toContain('tests="1"');
    expect(retryResult.stdout).not.toContain("<failure");
    const fanoutResult = await raw(repository, [
      "workflow",
      "run",
      "fanout",
      "--input",
      '["a","b"]',
      "--junit",
    ]);
    expect(fanoutResult.code).toBe(0);
    expect(fanoutResult.stdout).toContain('tests="5"');
    const pausedResult = await raw(repository, [
      "workflow",
      "run",
      "paused",
      "--input",
      "null",
      "--junit",
    ]);
    expect(pausedResult.code).toBe(4);
    expect(pausedResult.stdout).toBe("");
    const pausedId = /Run (?<id>[a-f0-9-]+) was accepted/u.exec(
      pausedResult.stderr
    )?.groups?.id;
    if (!pausedId) {
      throw new Error(pausedResult.stderr);
    }
    await cli(repository, ["run", "cancel", pausedId]);
    const cancelled = await settled(repository, pausedId);
    expect(cancelled.status).toBe("Cancelled");
    const cancelledXml = await raw(repository, ["run", "junit", pausedId]);
    expect(cancelledXml.code).toBe(1);
    expect(cancelledXml.stdout).toContain('type="Cancelled"');

    const crash = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "task",
        "run",
        "verify",
        "--input",
        '"crash"',
        "--background",
      ])
    );
    await runningCheck(repository, crash.runId, "long");
    const unfinished = await raw(repository, ["run", "junit", crash.runId]);
    expect(unfinished.code).toBe(5);
    expect(unfinished.stdout).toBe("");
    daemon.kill("SIGKILL");
    await daemon.exited;
    await writeFile(path.join(repository, "crash"), "open");
    daemon = await start(repository);
    const completed = await settled(repository, crash.runId);
    expect(completed.status).toBe("Succeeded");
    const history = Schema.decodeUnknownSync(CheckPage)(
      await cli(repository, ["run", "checks", crash.runId, "--attempts", "all"])
    );
    expect(
      history.items.some(
        (row) => row.id === "long" && row.status === "Incomplete"
      )
    ).toBe(true);
    expect(
      history.items.some(
        (row) => row.id === "long" && row.status === "Passed" && row.entry > 1
      )
    ).toBe(true);
    const output = path.join(repository, "restarted.xml");
    const exported = await raw(repository, [
      "run",
      "junit",
      crash.runId,
      "--output",
      output,
    ]);
    expect(exported.code).toBe(0);
    expect(await readFile(output, "utf-8")).not.toContain('type="Incomplete"');

    const completedBeforeActivity = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "task",
        "run",
        "verify",
        "--input",
        '"completed"',
        "--background",
      ])
    );
    let finalPassed = false;
    for (let poll = 0; poll < 80; poll += 1) {
      const page = Schema.decodeUnknownSync(CheckPage)(
        await cli(repository, ["run", "checks", completedBeforeActivity.runId])
      );
      if (
        page.items.some((row) => row.id === "final" && row.status === "Passed")
      ) {
        finalPassed = true;
        break;
      }
      await Bun.sleep(25);
    }
    expect(finalPassed).toBe(true);
    daemon.kill("SIGKILL");
    await daemon.exited;
    await writeFile(path.join(repository, "completed"), "open");
    daemon = await start(repository);
    const completedAgain = await settled(
      repository,
      completedBeforeActivity.runId
    );
    expect(completedAgain.status).toBe("Succeeded");
    const repeat = Schema.decodeUnknownSync(CheckPage)(
      await cli(repository, [
        "run",
        "checks",
        completedAgain.runId,
        "--attempts",
        "all",
      ])
    );
    expect(
      repeat.items
        .filter((row) => row.id === "final")
        .map((row) => [row.entry, row.status])
    ).toEqual([
      [1, "Passed"],
      [2, "Passed"],
    ]);

    const manual = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "task",
        "run",
        "manual",
        "--input",
        "null",
        "--background",
      ])
    );
    await runningCheck(repository, manual.runId, "uncertain");
    daemon.kill("SIGKILL");
    await daemon.exited;
    daemon = await start(repository);
    const heldRun = await settled(repository, manual.runId);
    expect(heldRun.status).toBe("NeedsAttention");
    const held = Schema.decodeUnknownSync(CheckPage)(
      await cli(repository, [
        "run",
        "checks",
        manual.runId,
        "--attempts",
        "all",
      ])
    );
    expect(held.items.map((row) => row.status)).toEqual(["Incomplete"]);
    const assessment = Schema.decodeUnknownSync(RecoveryAssessment)(
      await cli(repository, ["run", "recover", manual.runId])
    );
    if (!assessment.token) {
      throw new Error("Missing recovery token");
    }
    await writeFile(path.join(repository, "manual"), "open");
    await cli(repository, [
      "run",
      "recover",
      manual.runId,
      "--authorize",
      assessment.token,
      "--acknowledge-reexecution",
    ]);
    const recovered = await settled(repository, manual.runId);
    expect(recovered.status).toBe("Succeeded");
    const recoveredChecks = Schema.decodeUnknownSync(CheckPage)(
      await cli(repository, [
        "run",
        "checks",
        manual.runId,
        "--attempts",
        "all",
      ])
    );
    expect(recoveredChecks.items.map((row) => [row.entry, row.status])).toEqual(
      [
        [1, "Incomplete"],
        [2, "Passed"],
      ]
    );

    await cli(repository, ["daemon", "stop"]);
    await daemon.exited;
    const db = new Database(path.join(repository, ".effectory/state.sqlite"), {
      readonly: true,
    });
    try {
      expect(
        db
          .query(
            "SELECT COUNT(*) count FROM host_checks WHERE status='Running'"
          )
          .get()
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  } finally {
    if (daemon?.exitCode === null) {
      daemon.kill("SIGKILL");
    }
    if (daemon) {
      await daemon.exited;
    }
    await rm(repository, { force: true, recursive: true });
  }
}, 120_000);
