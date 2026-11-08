/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Sequential daemon/process proof. */
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Run } from "@effectory/runtime/protocol";
import {
  RunReportsPage,
  ReportRetryReply,
} from "@effectory/runtime/report-protocol";
import { Schema } from "effect";

import { cli, effectory, start } from "./fixtures/cli.ts";

const application = `
import {Application,Report,Task,Workflow} from "@offtree/effectory-sdk";
import {Effect,Schema} from "effect";
const Source=Task.make({id:"source",version:1,input:Schema.Number,success:Schema.Number,error:Schema.Never,replay:"idempotent"}, n=>Effect.succeed(n+1));
const Reporter=Task.make({id:"reporter",version:1,input:Report.sourceOf(Source),success:Report.result(Schema.Number),error:Schema.Never,replay:"idempotent"},()=>Effect.gen(function*(){yield* Effect.sleep("2 seconds");const history=yield* Report.History;const outcome=yield* history.outcome(Source);return {markdown:"# Value\\n\\t42\\n",data:outcome._tag==="Succeeded"?outcome.value:-1}}));
const Waiting=Workflow.make({id:"waiting",version:1,input:Schema.Number,success:Schema.Number,error:Schema.Never},Effect.gen(function*(){const graph=yield* Workflow.Builder;const value=yield* graph.task("work",Source,yield* graph.input(Schema.Number));yield* graph.approval("review",{after:[value],prompt:"Review",timeout:"1 minute"});return value}));
export default Application.make({tasks:[Source,Reporter],workflows:[Waiting],reports:[Report.make({id:"summary",target:Source,task:Reporter,scope:"run"}),Report.make({id:"invocation",target:Source,task:Reporter,scope:"invocation"})]});
`;

test("report CLI reads Markdown/data, waits independently, retries after daemon death, and refuses overwrites", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-report-cli-"));
  const children: Awaited<ReturnType<typeof start>>[] = [];
  const command = async (args: string[]) => {
    const child = Bun.spawn(
      [...effectory, ...args, "--repository", directory],
      { stderr: "pipe", stdout: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stderr, stdout };
  };
  try {
    await writeFile(path.join(directory, "effectory.ts"), application);
    const daemon = await start(directory);
    children.push(daemon);
    const submitted = await command(["task", "run", "source", "--input", "41"]);
    expect(submitted.code).toBe(0);
    expect(submitted.stderr).toContain("Reports: effectory report list");
    const source = Schema.decodeUnknownSync(Run)(JSON.parse(submitted.stdout));
    const aggregate = await cli(directory, ["report", "wait", source.runId]);
    expect(aggregate).toMatchObject({ Succeeded: 2, total: 2 });
    const page = Schema.decodeUnknownSync(RunReportsPage)(
      await cli(directory, ["report", "list", source.runId])
    );
    const report = page.items.find((item) => item.attachmentId === "summary");
    if (!report) {
      throw new Error("Missing report");
    }
    const markdown = await command(["report", "get", report.reportId]);
    expect(markdown).toMatchObject({ code: 0, stdout: "# Value\n\t42\n" });
    const data = await command(["report", "get", report.reportId, "--data"]);
    expect(data).toMatchObject({ code: 0, stdout: "42" });
    const output = path.join(directory, "result.md");
    expect(
      (await command(["report", "get", report.reportId, "--output", output]))
        .code
    ).toBe(0);
    expect(await readFile(output, "utf-8")).toBe(markdown.stdout);
    expect(
      (await command(["report", "get", report.reportId, "--output", output]))
        .code
    ).toBe(5);
    expect(await readFile(output, "utf-8")).toBe(markdown.stdout);
    expect(
      (await command(["report", "get", report.reportId, "--json", "--data"]))
        .code
    ).toBe(2);
    const summary = await cli(directory, ["run", "summary", source.runId]);
    expect(summary).toMatchObject({
      data: {
        invocations: { Succeeded: 1, total: 1 },
        reports: { total: 2 },
        status: "Succeeded",
      },
    });
    const origins = await cli(directory, ["run", "list", "--origin", "report"]);
    expect(origins).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          report: expect.objectContaining({ sourceRunId: source.runId }),
        }),
      ]),
    });
    daemon.kill("SIGKILL");
    await daemon.exited;
    children.push(await start(directory));
    const retry = Schema.decodeUnknownSync(ReportRetryReply)(
      await cli(directory, [
        "report",
        "retry",
        report.reportId,
        "--request-key",
        "restart",
      ])
    );
    expect(retry.record.generation).toBe(2);
    expect(
      (
        await command([
          "report",
          "wait",
          "--report",
          retry.record.reportId,
          "--json",
        ])
      ).code
    ).toBe(0);
    const reread = await command(["report", "get", retry.record.reportId]);
    expect(reread.stdout).toBe(markdown.stdout);
    const replay = Schema.decodeUnknownSync(ReportRetryReply)(
      await cli(directory, [
        "report",
        "retry",
        report.reportId,
        "--request-key",
        "restart",
      ])
    );
    expect(replay).toMatchObject({
      record: { reportId: retry.record.reportId, status: "Succeeded" },
      replayed: true,
    });
    const waiting = Schema.decodeUnknownSync(Run)(
      await cli(directory, [
        "workflow",
        "run",
        "waiting",
        "--input",
        "41",
        "--background",
      ])
    );
    expect(
      (await command(["report", "wait", waiting.runId, "--json"])).code
    ).toBe(4);
    const waitingReports = Schema.decodeUnknownSync(RunReportsPage)(
      await cli(directory, ["report", "list", waiting.runId])
    );
    const [invocation] = waitingReports.items;
    if (!invocation) {
      throw new Error("Missing invocation report");
    }
    expect(
      (
        await command([
          "report",
          "wait",
          "--report",
          invocation.reportId,
          "--json",
        ])
      ).code
    ).toBe(0);
    expect(await cli(directory, ["run", "get", waiting.runId])).toMatchObject({
      status: "Waiting",
    });
    expect(
      (
        await command([
          "report",
          "cancel",
          "--run",
          waiting.runId,
          "--request-key",
          "bulk",
          "--json",
        ])
      ).code
    ).toBe(0);
    await cli(directory, ["run", "cancel", waiting.runId]);
    const interrupted = Schema.decodeUnknownSync(Run)(
      await cli(directory, [
        "task",
        "run",
        "source",
        "--input",
        "1",
        "--background",
      ])
    );
    let before: typeof RunReportsPage.Type | undefined;
    for (let poll = 0; poll < 100; poll += 1) {
      before = Schema.decodeUnknownSync(RunReportsPage)(
        await cli(directory, ["report", "list", interrupted.runId])
      );
      if (
        before.items.length === 2 &&
        before.items.every((item) => item.reportRunStatus === "Running")
      ) {
        break;
      }
      await Bun.sleep(20);
    }
    if (!before) {
      throw new Error("Missing pre-crash report page");
    }
    expect(
      before.items.every((item) => item.reportRunStatus === "Running")
    ).toBe(true);
    const runningDaemon = children.at(-1);
    if (!runningDaemon) {
      throw new Error("Missing daemon");
    }
    runningDaemon.kill("SIGKILL");
    await runningDaemon.exited;
    children.push(await start(directory));
    expect(
      await cli(directory, ["report", "wait", interrupted.runId])
    ).toMatchObject({ Succeeded: 2, total: 2 });
    const recovered = Schema.decodeUnknownSync(RunReportsPage)(
      await cli(directory, ["report", "list", interrupted.runId, "--history"])
    );
    expect(
      recovered.items.map((item) => [item.reportId, item.reportRunId])
    ).toEqual(before.items.map((item) => [item.reportId, item.reportRunId]));
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 120_000);
