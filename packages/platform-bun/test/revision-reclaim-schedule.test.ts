/* oxlint-disable no-await-in-loop -- Daemon transitions and cleanup are sequential. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { RunPage } from "@effectory/runtime/history-protocol";
import {
  ScheduleDescription,
  ScheduleHistory,
} from "@effectory/runtime/schedule-protocol";
import { Schema } from "effect";

import { RevisionReclaimPlan } from "../src/revision-reclaim-record.ts";
import { cli, start } from "./fixtures/cli.ts";

const source = (cron: string, enabled: boolean, value: string) => `
import { Application, Task, Workflow, WorkflowSchedule } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";
const task=Task.make({id:"value",version:1,input:Schema.Null,success:Schema.String,error:Schema.Never,replay:"idempotent"},()=>Effect.succeed(${JSON.stringify(value)}));
const flow=Workflow.make({id:"daily",version:1,input:Schema.Null,success:Schema.String,error:Schema.Never},Effect.gen(function*(){return yield* (yield* Workflow.Builder).task("value",task,null);}));
const schedule=WorkflowSchedule.make({id:"daily",workflow:flow,input:null,cron:${JSON.stringify(cron)},timeZone:"UTC",catchUp:"skip"});
export default Application.make({tasks:[task],workflows:[flow],schedules:${enabled ? "[schedule]" : "[]"}});
`;

test("removed schedule history survives bundle deletion, resume never restores code, and re-add uses the new revision", async () => {
  const repository = mkdtempSync(
    path.join(tmpdir(), "effectory-reclaim-schedule-")
  );
  const children: Awaited<ReturnType<typeof start>>[] = [];
  const cron = `0 ${(new Date().getUTCHours() + 12) % 24} * * *`;
  const filename = path.join(repository, "effectory.ts");
  const get = async () =>
    Schema.decodeUnknownSync(ScheduleDescription)(
      await cli(repository, ["schedule", "get", "daily"])
    );
  try {
    writeFileSync(filename, source(cron, true, "old"));
    const first = await start(repository);
    children.push(first);
    const original = await get();
    await cli(repository, ["schedule", "pause", "daily"]);
    await cli(repository, ["daemon", "stop"]);
    await first.exited;
    const db = new Database(
      path.join(repository, ".effectory", "state.sqlite")
    );
    db.query("UPDATE host_schedules SET watermark=?").run(
      Date.now() - 86_400_000
    );
    db.close();
    const second = await start(repository);
    children.push(second);
    const history = Schema.decodeUnknownSync(ScheduleHistory)(
      await cli(repository, ["schedule", "history", "daily"])
    );
    expect(history.items.length).toBeGreaterThan(0);
    expect(history.items.every((item) => item._tag === "Missed")).toBe(true);
    await cli(repository, ["daemon", "stop"]);
    await second.exited;
    writeFileSync(filename, source(cron, false, "removed"));
    const third = await start(repository);
    children.push(third);
    const removed = await get();
    expect(removed.state).toBe("Removed");
    expect(removed.revision).toBe(original.revision);
    await cli(repository, ["daemon", "stop"]);
    await third.exited;
    const plan = Schema.decodeUnknownSync(RevisionReclaimPlan)(
      await cli(repository, [
        "revision",
        "reclaim",
        "plan",
        "--revision",
        original.revision,
      ])
    );
    expect(plan.status).toBe("Ready");
    await cli(repository, ["revision", "reclaim", "apply", plan.planId]);
    const fourth = await start(repository);
    children.push(fourth);
    expect(
      Schema.decodeUnknownSync(ScheduleHistory)(
        await cli(repository, ["schedule", "history", "daily"])
      ).items
    ).toEqual(history.items);
    await cli(repository, ["schedule", "resume", "daily"]);
    const resumed = await get();
    expect(resumed.state).toBe("Removed");
    await cli(repository, ["schedule", "pause", "daily"]);
    const paused = await get();
    expect(paused.state).toBe("Removed");
    await cli(repository, ["schedule", "resume", "daily"]);
    expect(
      Schema.decodeUnknownSync(RunPage)(await cli(repository, ["run", "list"]))
        .items
    ).toHaveLength(0);
    expect(
      existsSync(
        path.join(repository, ".effectory", "revisions", original.revision)
      )
    ).toBe(false);
    await cli(repository, ["daemon", "stop"]);
    await fourth.exited;
    writeFileSync(filename, source(cron, true, "new"));
    const fifth = await start(repository);
    children.push(fifth);
    const added = await get();
    expect(added.state).toBe("Active");
    expect(added.revision).not.toBe(original.revision);
    expect(added.generation).toBeGreaterThan(original.generation);
    expect(
      existsSync(
        path.join(repository, ".effectory", "revisions", original.revision)
      )
    ).toBe(false);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
    rmSync(repository, { force: true, recursive: true });
  }
}, 120_000);
