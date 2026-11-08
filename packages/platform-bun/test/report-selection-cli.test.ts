/* oxlint-disable no-await-in-loop -- Sequential operator and restart proof. */
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RunPage } from "@effectory/runtime/history-protocol";
import { Run } from "@effectory/runtime/protocol";
import { RunReportsPage } from "@effectory/runtime/report-protocol";
import { Effect, Schema } from "effect";

import { connectionConfig } from "../src/connection-config.ts";
import { cli, effectory, start } from "./fixtures/cli.ts";
import { arrayContaining, objectContaining } from "./fixtures/matchers.ts";

const app = (includeCost = true) => `
import {Application,Report,Task,Tag,Workflow} from "@offtree/effectory-sdk";
import {Effect,Schema} from "effect";
const Category=Tag.make("category",Schema.Literals(["cost","audit"]));
const Source=Task.make({id:"source",version:1,input:Schema.Null,success:Schema.Null,error:Schema.Never,replay:"idempotent"},()=>Effect.succeed(null));
const Reporter=Task.make({id:"reporter",version:1,input:Report.Source,success:Report.result(Schema.Null),error:Schema.Never,replay:"idempotent"},()=>Effect.succeed({markdown:"ok",data:null}));
const Flow=Workflow.make({id:"flow",version:1,input:Schema.Null,success:Schema.Null,error:Schema.Never},Effect.gen(function*(){const g=yield* Workflow.Builder;return yield* g.task("work",Source,null);}));
export default Application.make({tasks:[Source,Reporter],workflows:[Flow],reports:[
${includeCost ? 'Report.make({id:"cost",target:Flow,task:Reporter,tags:[Category("cost")]}),' : ""}
Report.make({id:"audit",target:Flow,task:Reporter,required:true,tags:[Category("audit")]}),
Report.make({id:"step",target:Source,task:Reporter,scope:"invocation",tags:[Category("cost")]}),
Report.make({id:"task-root",target:Source,task:Reporter,scope:"run",tags:[Category("cost")]})]});
`;

test("CLI selects report attachments, preserves source outcome and receipts across deployment/restart", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-selection-cli-")
  );
  let daemon: Awaited<ReturnType<typeof start>> | undefined;
  const command = async (args: string[]) => {
    const child = Bun.spawn(
      [...effectory, ...args, "--repository", repository, "--json"],
      { stderr: "pipe", stdout: "pipe" }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stderr, stdout };
  };
  const run = async (flags: string[]) =>
    Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "workflow",
        "run",
        "flow",
        "--input",
        "null",
        ...flags,
      ])
    );
  try {
    await writeFile(path.join(repository, "effectory.ts"), app());
    daemon = await start(repository);
    const skipped = await run(["--skip-reports"]);
    expect(skipped.status).toBe("Succeeded");
    expect(skipped.reportSelection).toMatchObject({
      excluded: ["cost", "step"],
      required: ["audit"],
      selected: ["audit"],
    });
    await cli(repository, ["report", "wait", skipped.runId]);
    const records = Schema.decodeUnknownSync(RunReportsPage)(
      await cli(repository, ["report", "list", skipped.runId])
    );
    expect(records.items.map((item) => item.attachmentId)).toEqual(["audit"]);
    expect(records.items[0]?.status).toBe("Succeeded");
    const selected = await run(["--report", "cost", "--request-key", "chosen"]);
    expect(selected.reportSelection?.selected).toEqual(["audit", "cost"]);
    await cli(repository, ["report", "wait", selected.runId]);
    const tagged = await run([
      "--report-tag",
      "category=cost",
      "--skip-report",
      "step",
    ]);
    expect(tagged.reportSelection?.selected).toEqual(["audit", "cost"]);
    const excludeTags = await run(["--skip-report-tag", "category=cost"]);
    expect(excludeTags.reportSelection?.selected).toEqual(["audit"]);
    const direct = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "task",
        "run",
        "source",
        "--input",
        "null",
        "--report",
        "task-root",
      ])
    );
    expect(direct.reportSelection).toMatchObject({
      excluded: ["step"],
      selected: ["task-root"],
    });
    const noMatch = await run(["--report-tag", "category=none"]);
    expect(noMatch.reportSelection?.selected).toEqual(["audit"]);
    const manualRuns = async () =>
      Schema.decodeUnknownSync(RunPage)(
        await cli(repository, ["run", "list", "--origin", "manual"])
      ).items.map((item) => item.runId);
    const beforeInvalid = await manualRuns();
    for (const flags of [
      ["--report", "unknown"],
      ["--report", "task-root"],
      ["--skip-reports", "--report", "cost"],
      ["--report-tag", "category=cost", "--report-tag", "category=audit"],
    ]) {
      const rejected = await command([
        "workflow",
        "run",
        "flow",
        "--background",
        "--input",
        "null",
        ...flags,
      ]);
      expect(rejected.code).toBe(2);
      expect(rejected.stdout).toBe("");
    }
    const config = Effect.runSync(connectionConfig(repository));
    const oversized = await fetch(config.url, {
      body: JSON.stringify([
        {
          _tag: "Request",
          headers: [],
          id: "large",
          payload: {
            input: "x".repeat(1_048_576 - 1024),
            reportSelection: {
              onlyTags: Object.fromEntries(
                Array.from({ length: 8 }, (_, index) => [
                  `label${index}`,
                  "y".repeat(256),
                ])
              ),
            },
            requestKey: "large",
            targetId: "flow",
          },
          tag: "WorkflowRun",
        },
      ]),
      headers: {
        authorization: `Bearer ${config.token}`,
        "x-effectory-protocol": "1",
        "x-effectory-repository": config.repositoryId,
      },
      method: "POST",
    });
    expect(oversized.status).toBe(413);
    await oversized.arrayBuffer();
    // The latest source-run membership is unchanged (report runs can settle concurrently).
    expect(await manualRuns()).toEqual(beforeInvalid);
    const conflict = await command([
      "workflow",
      "run",
      "flow",
      "--background",
      "--input",
      "null",
      "--request-key",
      "chosen",
      "--skip-reports",
    ]);
    expect(conflict.code).toBe(5);
    const description = await cli(repository, ["workflow", "describe", "flow"]);
    expect(description).toMatchObject({
      reports: arrayContaining([
        objectContaining({
          attachmentId: "audit",
          required: true,
          tags: { category: "audit" },
        }),
        objectContaining({ attachmentId: "step" }),
      ]),
    });
    expect(
      await cli(repository, ["workflow", "plan", "flow", "--input", "null"])
    ).toMatchObject({
      reports: arrayContaining([objectContaining({ attachmentId: "cost" })]),
    });
    await cli(repository, ["daemon", "stop"]);
    await daemon.exited;
    daemon = undefined;
    await writeFile(path.join(repository, "effectory.ts"), app(false));
    daemon = await start(repository);
    const replay = await command([
      "workflow",
      "run",
      "flow",
      "--background",
      "--input",
      "null",
      "--request-key",
      "chosen",
      "--report",
      "cost",
    ]);
    expect(replay.code).toBe(0);
    expect(
      Schema.decodeUnknownSync(Run)(JSON.parse(replay.stdout)).reportSelection
    ).toEqual(selected.reportSelection);
    expect(Schema.decodeUnknownSync(Run)(JSON.parse(replay.stdout)).runId).toBe(
      selected.runId
    );
    const removed = await command([
      "workflow",
      "run",
      "flow",
      "--background",
      "--input",
      "null",
      "--report",
      "cost",
    ]);
    expect(removed.code).toBe(2);
    expect(removed.stderr).toContain("Unknown or irrelevant");
    expect(
      Schema.decodeUnknownSync(Run)(
        await cli(repository, ["run", "get", selected.runId])
      ).reportSelection
    ).toEqual(selected.reportSelection);
  } finally {
    if (daemon) {
      await cli(repository, ["daemon", "stop"]).catch(() => daemon?.kill());
      await daemon.exited;
    }
    await rm(repository, { force: true, recursive: true });
  }
}, 90_000);
