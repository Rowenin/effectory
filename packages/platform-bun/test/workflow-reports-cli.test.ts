/* oxlint-disable no-await-in-loop -- Restart and wait observations are sequential. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Run } from "@effectory/runtime/protocol";
import { ReportSearchPage } from "@effectory/runtime/report-protocol";
import { Schema } from "effect";

import { approval, cli, start } from "./fixtures/cli.ts";

const application = `
import {Application,Report,Task,Workflow} from "@offtree/effectory-sdk";
import {Effect,Schema} from "effect";
const Child=Workflow.make({id:"child",version:1,input:Schema.Number,success:Schema.Number,error:Schema.Never},Effect.gen(function*(){const g=yield* Workflow.Builder;const input=yield* g.input(Schema.Number);yield* g.approval("child-gate",{prompt:"Child",timeout:"1 hour"});return input;}));
const Parent=Workflow.make({id:"parent",version:1,input:Schema.Number,success:Schema.Number,error:Schema.Never},Effect.gen(function*(){const g=yield* Workflow.Builder;const child=yield* g.workflow("child",Child,yield* g.input(Schema.Number));yield* g.approval("parent-gate",{after:[child],prompt:"Parent",timeout:"1 hour"});return child;}));
const Summary=Task.make({id:"summary",version:1,input:Report.sourceOf(Child),success:Report.result(Schema.Json),error:Schema.Never,replay:"idempotent"},()=>Effect.gen(function*(){const h=yield* Report.History;const result=yield* h.outcome(Child);const events=yield* h.events();return {markdown:"Child",data:{result,events:events.items.map(e=>e.tag)}};}));
export default Application.make({tasks:[Summary],workflows:[Parent],reports:[Report.make({id:"summary",target:Child,scope:"invocation",task:Summary})]});
`;

test("child report registration survives kill/restart; source-workflow CLI search and explicit retry preserve its source", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-child-reports-cli-")
  );
  const children: Awaited<ReturnType<typeof start>>[] = [];
  try {
    await writeFile(path.join(repository, "effectory.ts"), application);
    const first = await start(repository);
    children.push(first);
    const source = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "workflow",
        "run",
        "parent",
        "--input",
        "42",
        "--background",
      ])
    );
    const wait = await approval(repository, source.runId);
    expect(wait.prompt).toBe("Child");
    const before = Schema.decodeUnknownSync(ReportSearchPage)(
      await cli(repository, [
        "report",
        "search",
        "--source-workflow",
        "child",
        "--run",
        source.runId,
        "--status",
        "WaitingSource",
      ])
    );
    expect(before.items).toHaveLength(1);
    const [original] = before.items;
    if (!original) {
      throw new Error("Missing obligation");
    }
    first.kill("SIGKILL");
    await first.exited;
    const sql = (query: string) => {
      const db = new Database(path.join(repository, ".effectory/state.sqlite"));
      try {
        db.exec(query);
      } finally {
        db.close();
      }
    };
    // Stop between native completion and report materialization, then between
    // materialization and admission. Install the triggers while the daemon is
    // stopped so fixture setup cannot race its SQLite writes. They never touch
    // engine tables.
    sql(
      "CREATE TRIGGER pause_materialization BEFORE UPDATE OF phase ON host_report_sources WHEN NEW.phase='Ready' BEGIN SELECT RAISE(ABORT,'proof pause'); END"
    );
    const second = await start(repository);
    children.push(second);
    await cli(repository, ["run", "approve", wait.waitId]);
    const parentWait = await approval(repository, source.runId);
    expect(parentWait.prompt).toBe("Parent");
    second.kill("SIGKILL");
    await second.exited;
    sql(
      "DROP TRIGGER pause_materialization; CREATE TRIGGER pause_report_admission BEFORE INSERT ON host_runs WHEN NEW.reportJson IS NOT NULL BEGIN SELECT RAISE(ABORT,'proof pause'); END"
    );
    const third = await start(repository);
    children.push(third);
    let queued = false;
    for (let i = 0; i < 80; i += 1) {
      const page = Schema.decodeUnknownSync(ReportSearchPage)(
        await cli(repository, [
          "report",
          "search",
          "--source-workflow",
          "child",
          "--run",
          source.runId,
        ])
      );
      if (page.items[0]?.status === "Queued") {
        queued = true;
        break;
      }
      await Bun.sleep(50);
    }
    expect(queued).toBe(true);
    third.kill("SIGKILL");
    await third.exited;
    sql("DROP TRIGGER pause_report_admission");
    children.push(await start(repository));
    let found = before;
    for (let i = 0; i < 80; i += 1) {
      found = Schema.decodeUnknownSync(ReportSearchPage)(
        await cli(repository, [
          "report",
          "search",
          "--source-workflow",
          "child",
          "--workflow",
          "parent",
          "--run",
          source.runId,
        ])
      );
      if (found.items[0]?.status === "Succeeded") {
        break;
      }
      await Bun.sleep(50);
    }
    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.reportId).toBe(original.reportId);
    expect(found.items[0]?.status).toBe("Succeeded");
    expect(
      await cli(repository, ["report", "get", original.reportId])
    ).toMatchObject({
      content: {
        data: {
          events: expect.arrayContaining(["WaitOpened", "WaitSettled"]),
          result: { _tag: "Succeeded", value: 42 },
        },
      },
    });
    expect(
      Schema.decodeUnknownSync(Run)(
        await cli(repository, ["run", "get", source.runId])
      ).status
    ).toBe("Waiting");
    await cli(repository, [
      "report",
      "retry",
      original.reportId,
      "--request-key",
      "again",
    ]);
    const history = Schema.decodeUnknownSync(ReportSearchPage)(
      await cli(repository, [
        "report",
        "search",
        "--source-workflow",
        "child",
        "--run",
        source.runId,
        "--history",
      ])
    );
    expect(history.items).toHaveLength(2);
    expect(
      new Set(history.items.map((row) => row.source.invocationId)).size
    ).toBe(1);
    await cli(repository, ["run", "cancel", source.runId]);
    await cli(repository, ["daemon", "stop"]);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
    await rm(repository, { force: true, recursive: true });
  }
}, 90_000);
