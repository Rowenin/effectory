import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { OutputPage, RunPage } from "@effectory/runtime/history-protocol";
import { Run } from "@effectory/runtime/protocol";
import { ServerStatus } from "@effectory/runtime/rpc";
import {
  ScheduleDescription,
  ScheduleHistory,
  ScheduleList,
  ScheduleReceipt,
} from "@effectory/runtime/schedule-protocol";
import { Schema } from "effect";

import { Endpoint } from "../src/daemon.ts";
import { approval, cli, effectory, start } from "./fixtures/cli.ts";

test("schedule CLI/RPC recovers an occurrence after kill, exposes blockers, and retries a lost pause reply", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-schedule-cli-")
  );
  const processes: Awaited<ReturnType<typeof start>>[] = [];
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  try {
    // Put the next natural firing roughly twelve hours away. A minute schedule
    // can legitimately fire between daemon startup and the first inspection.
    const cron = `0 ${(new Date().getUTCHours() + 12) % 24} * * *`;
    const source = await readFile(
      path.resolve(import.meta.dir, "../../../examples/scheduled/effectory.ts"),
      "utf-8"
    );
    await writeFile(
      path.join(repository, "effectory.ts"),
      source
        .replace('cron: "* * * * *"', `cron: ${JSON.stringify(cron)}`)
        .replace('catchUp: "skip"', 'catchUp: { latestWithin: "1 day" }')
    );
    const first = await start(repository);
    processes.push(first);
    const status = Schema.decodeUnknownSync(ServerStatus)(
      await cli(repository, ["daemon", "status"])
    );
    expect(status.capabilities).toContain("schedule.v1");
    expect(status.scheduler).toMatchObject({
      activeSchedules: 1,
      blockedSchedules: 0,
      pausedSchedules: 0,
      revision: status.revision,
      state: "Running",
    });
    const listed = Schema.decodeUnknownSync(ScheduleList)(
      await cli(repository, [
        "schedule",
        "list",
        "--state",
        "active",
        "--workflow",
        "scheduled/welcome",
      ])
    );
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      cron,
      scheduleId: "minute-greeting",
      state: "Active",
      timeZone: "UTC",
    });
    const paused = Schema.decodeUnknownSync(ScheduleReceipt)(
      await cli(repository, [
        "schedule",
        "pause",
        "minute-greeting",
        "--reason",
        "deploy",
        "--request-key",
        "first-pause",
      ])
    );
    expect(paused).toMatchObject({
      changed: true,
      operation: "Pause",
      paused: true,
      requestKey: "first-pause",
    });
    expect(
      Schema.decodeUnknownSync(ScheduleDescription)(
        await cli(repository, ["schedule", "get", "minute-greeting"])
      ).nextScheduledAt
    ).toBeNull();
    expect(
      Schema.decodeUnknownSync(ScheduleReceipt)(
        await cli(repository, ["schedule", "resume", "minute-greeting"])
      )
    ).toMatchObject({ changed: true, operation: "Resume", paused: false });
    first.kill("SIGKILL");
    await first.exited;
    // Seed one missed daily occurrence while offline. Startup admits the latest
    // slot through catch-up without exposing a production test clock or RPC.
    const database = new Database(
      path.join(repository, ".effectory/state.sqlite")
    );
    database
      .query("UPDATE host_schedules SET watermark=?")
      .run(Date.now() - 86_400_000);
    database.close();
    const second = await start(repository);
    processes.push(second);
    const schedule = Schema.decodeUnknownSync(ScheduleDescription)(
      await cli(repository, ["schedule", "get", "minute-greeting"])
    );
    if (!schedule.blockedBy) {
      throw new Error("No scheduled run admitted on startup");
    }
    const { runId } = schedule.blockedBy;
    const wait = await approval(repository, runId);
    const beforeRestart = Schema.decodeUnknownSync(OutputPage)(
      await cli(repository, ["run", "outputs", runId])
    );
    const original = beforeRestart.items.find(
      (item) => item.taskId === "scheduled/greet"
    );
    expect(original?.status).toBe("Succeeded");
    second.kill("SIGKILL");
    await second.exited;
    const third = await start(repository);
    processes.push(third);
    const recovered = Schema.decodeUnknownSync(ScheduleDescription)(
      await cli(repository, ["schedule", "get", "minute-greeting"])
    );
    expect(recovered.blockedBy?.runId).toBe(runId);
    expect(recovered.state).toBe("Blocked");
    const history = Schema.decodeUnknownSync(ScheduleHistory)(
      await cli(repository, ["schedule", "history", "minute-greeting"])
    );
    expect(
      history.items.filter((entry) => entry._tag === "Admitted")
    ).toHaveLength(1);
    const run = Schema.decodeUnknownSync(Run)(
      await cli(repository, ["run", "get", runId])
    );
    expect(run.schedule?.scheduleId).toBe("minute-greeting");
    expect(run.schedule?.catchUp).toBe(true);
    expect(original?.result).toMatchObject({ occurrence: run.schedule });
    const runs = Schema.decodeUnknownSync(RunPage)(
      await cli(repository, ["run", "list"])
    );
    expect(runs.items.find((item) => item.runId === runId)?.schedule).toEqual(
      run.schedule
    );
    const human = Bun.spawn(
      [
        ...effectory,
        "schedule",
        "get",
        "minute-greeting",
        "--repository",
        repository,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const [, hint, humanExit] = await Promise.all([
      new Response(human.stdout).text(),
      new Response(human.stderr).text(),
      human.exited,
    ]);
    expect(humanExit).toBe(0);
    expect(hint).toContain(`run get ${runId}`);
    expect(hint).toContain(`run waits ${runId}`);
    const endpointPath = path.join(repository, ".effectory/daemon.json");
    const endpointText = await readFile(endpointPath, "utf-8");
    const endpoint = Schema.decodeUnknownSync(Endpoint)(
      JSON.parse(endpointText)
    );
    proxy = Bun.serve({
      async fetch(request) {
        const body = await request.text();
        const response = await fetch(endpoint.url, {
          body,
          headers: request.headers,
          method: request.method,
        });
        if (body.includes('"SchedulePause"')) {
          await response.text();
          return new Response("lost reply", {
            headers: { "content-type": "application/json" },
          });
        }
        return response;
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    await writeFile(
      endpointPath,
      JSON.stringify({ ...endpoint, url: `http://127.0.0.1:${proxy.port}/rpc` })
    );
    const pause = Bun.spawn(
      [
        ...effectory,
        "schedule",
        "pause",
        "minute-greeting",
        "--repository",
        repository,
        "--json",
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const [, stderr, code] = await Promise.all([
      new Response(pause.stdout).text(),
      new Response(pause.stderr).text(),
      pause.exited,
    ]);
    expect(code).toBe(3);
    expect(stderr).toContain("delivery is uncertain");
    const key = /--request-key (?<key>[a-f\d-]{36})/u.exec(stderr)?.groups?.key;
    if (key === undefined) {
      throw new Error("No retry key printed");
    }
    await writeFile(endpointPath, endpointText);
    const retry = [
      "schedule",
      "pause",
      "minute-greeting",
      "--request-key",
      key,
    ];
    const receipt = await cli(repository, retry);
    expect(await cli(repository, retry)).toEqual(receipt);
    expect(receipt).toMatchObject({
      changed: true,
      paused: true,
      requestKey: key,
    });
    await cli(repository, ["run", "approve", wait.waitId]);
    const completed = Schema.decodeUnknownSync(Run)(
      await cli(repository, ["run", "watch", runId])
    );
    expect(completed.status).toBe("Succeeded");
    expect(completed.schedule).toEqual(run.schedule);
    const afterRestart = Schema.decodeUnknownSync(OutputPage)(
      await cli(repository, ["run", "outputs", runId])
    );
    expect(afterRestart.items).toHaveLength(2);
    for (const item of afterRestart.items) {
      expect(item.status).toBe("Succeeded");
      expect(item.result).toMatchObject({ occurrence: run.schedule });
    }
    const finalHistory = Schema.decodeUnknownSync(ScheduleHistory)(
      await cli(repository, ["schedule", "history", "minute-greeting"])
    );
    expect(
      finalHistory.items.find((entry) => entry._tag === "Admitted")
    ).toMatchObject({ status: "Succeeded" });
    await cli(repository, ["daemon", "stop", "--grace-period-ms", "0"]);
    expect(await third.exited).toBe(0);
  } finally {
    await proxy?.stop(true);
    for (const child of processes) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
    await Promise.all(processes.map(async (child) => await child.exited));
    await rm(repository, { force: true, recursive: true });
  }
}, 120_000);
