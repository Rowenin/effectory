import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import pathModule from "node:path";

import { Effect } from "effect";

import { writeReport } from "../../../.effectory/automations/approved-health-check/action.ts";
import { CliWorkspace, loopbackFixture, until } from "./fixtures/helpers.ts";
import type { Artifact, Gate } from "./fixtures/helpers.ts";

let workspace: CliWorkspace | undefined;
let fixture: ReturnType<typeof loopbackFixture> | undefined;
afterEach(async () => {
  fixture?.close();
  await workspace?.close();
  fixture = undefined;
  workspace = undefined;
});

const setup = () => {
  workspace = new CliWorkspace({ explicitWorkflows: true });
  fixture = loopbackFixture();
  return { http: fixture, ws: workspace };
};
const input = (baseUrl: string, requestId: string, concurrency = 3) => ({
  concurrency,
  monitors: [
    { config: { timeoutMs: 5000, url: `${baseUrl}/healthy` }, name: "healthy" },
    {
      config: { timeoutMs: 5000, url: `${baseUrl}/unhealthy` },
      name: "unhealthy",
    },
    { config: { timeoutMs: 5000, url: `${baseUrl}/slow` }, name: "slow" },
  ],
  requestId,
});
const reviewed = (gate: Gate) => [
  "--digest",
  gate.digest,
  "--revision",
  gate.revision,
];

test("CLI discovers standard process activities and records successful and failed commands", async () => {
  const ws = new CliWorkspace();
  workspace = ws;
  const root = pathModule.resolve(import.meta.dir, "../../..");
  for (const file of ["package.json", "src"]) {
    cpSync(
      pathModule.join(root, "packages/activities", file),
      pathModule.join(ws.path, "packages/activities", file),
      { recursive: true }
    );
  }
  symlinkSync(
    pathModule.join(ws.path, "packages/activities"),
    pathModule.join(ws.path, "node_modules/@effectory/activities"),
    "dir"
  );
  const directory = pathModule.join(
    ws.path,
    ".effectory/automations/process-command"
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    pathModule.join(directory, "index.ts"),
    `
    import { Process } from "@effectory/activities";
    import { Automation, Task } from "@effectory/sdk";
    import { Effect, Schema } from "effect";
    const command = Task.make({
      name: "command",
      input: Process.Input,
      success: Process.Result,
      error: Process.Failure,
      run: Process.exec,
    });
    export default Automation.define({
      name: "process-command",
      description: "Exercise the Process service through discovery",
      input: Schema.Struct({ requestId: Schema.String, command: Schema.String, exitCode: Schema.Int }),
      success: Schema.String,
      error: Process.Failure,
      idempotencyKey: (input) => input.requestId,
      execute: (input) => command({
        command: input.command,
        args: ["--eval", "console.log('process result'); process.exitCode = " + input.exitCode],
      }, { key: "command" }).pipe(Effect.map((result) => result.stdout)),
    });
  `
  );
  writeFileSync(
    pathModule.join(ws.path, "effectory.run.ts"),
    `import { Process } from "@effectory/activities";
     import { Effectory } from "@effectory/sdk";
     import processCommand from "./.effectory/automations/process-command/index.ts";
     export default Effectory.make({ services: Process.layer, workflows: [processCommand] });`
  );
  const server = await ws.serve();
  const succeeded = await ws.submit(
    "process-command",
    { command: process.execPath, exitCode: 0, requestId: "success" },
    "success"
  );
  const result = await ws.terminal(succeeded.id);
  expect(result.result).toBe("process result\n");
  const failed = await ws.submit(
    "process-command",
    { command: process.execPath, exitCode: 9, requestId: "failure" },
    "failure"
  );
  const failure = await ws.terminal(failed.id, "failed");
  expect(JSON.stringify(failure)).toContain("Process exited with code 9");
  expect(JSON.stringify(failure)).not.toContain("inspectionError");
  await ws.stop(server);
}, 30_000);

test("CLI discovers native demos, validates before admission, publishes outputs, and isolates request keys", async () => {
  const { ws, http } = setup();
  const server = await ws.serve();
  const tasks = await ws.command(["workflow", "list", "--json"]);
  expect(JSON.stringify(tasks)).toContain("health-check");
  const description = await ws.command([
    "workflow",
    "describe",
    "health-check",
    "--json",
  ]);
  expect(JSON.stringify(description)).toContain("requestId");
  expect(JSON.stringify(description)).toContain("monitors");
  const invalid = pathModule.join(ws.path, "invalid.json");
  writeFileSync(
    invalid,
    JSON.stringify({ monitors: [], requestId: "invalid" })
  );
  const rejected = await ws.command(
    [
      "workflow",
      "run",
      "health-check",
      "--input",
      invalid,
      "--request-key",
      "invalid",
    ],
    false
  );
  // Fail for the invalid input, not for an unknown command.
  expect(JSON.stringify(rejected)).toContain("length of at least 1");
  expect(await ws.command(["run", "list"])).toEqual([]);

  const payload = input(http.baseUrl, "first");
  const run = await ws.submit("health-check", payload, "first");
  const finished = await ws.terminal(run.id);
  expect(finished.result).toMatchObject({ healthy: 2, total: 3, unhealthy: 1 });
  const artifacts = (await ws.command([
    "artifact",
    "list",
    "--run",
    run.id,
  ])) as Artifact[];
  expect(artifacts.map((artifact) => artifact.name).toSorted()).toEqual([
    "observation-healthy",
    "observation-slow",
    "observation-unhealthy",
    "summary",
  ]);
  await Promise.all(
    artifacts.map(async (artifact) => {
      const stored = (await ws.command([
        "artifact",
        "get",
        artifact.id,
      ])) as Artifact;
      expect(stored.runId).toBe(run.id);
      expect(stored.schemaVersion).toBe(1);
      expect(stored.value).toBeDefined();
    })
  );
  const duplicate = await ws.submit("health-check", payload, "first");
  expect(duplicate.id).toBe(run.id);
  const changed = pathModule.join(ws.path, "changed.json");
  writeFileSync(changed, JSON.stringify({ ...payload, concurrency: 1 }));
  const conflict = await ws.command(
    [
      "workflow",
      "run",
      "health-check",
      "--input",
      changed,
      "--request-key",
      "first",
    ],
    false
  );
  expect(JSON.stringify(conflict)).toContain("Request key conflicts");
  const distinct = await ws.submit("health-check", payload, "second");
  expect(distinct.id).not.toBe(run.id);
  await ws.terminal(distinct.id);
  const secondArtifacts = (await ws.command([
    "artifact",
    "list",
    "--run",
    distinct.id,
  ])) as Artifact[];
  expect(secondArtifacts).toHaveLength(4);
  expect(
    secondArtifacts.every((artifact) => artifact.runId === distinct.id)
  ).toBe(true);
  expect(http.counts.get("/healthy")).toBe(2);
  expect(http.peak).toBeLessThanOrEqual(3);
  await ws.stop(server);
  await ws.serve();
  const reopened = await ws.inspect(run.id);
  expect(reopened.result).toEqual(finished.result);
  expect(await ws.command(["artifact", "list", "--run", run.id])).toEqual(
    artifacts
  );
}, 90_000);

test("CLI enforces bounded monitor concurrency while endpoints are blocked", async () => {
  const { ws, http } = setup();
  await ws.serve();
  const payload = {
    concurrency: 2,
    monitors: Array.from({ length: 7 }, (_, index) => ({
      config: { timeoutMs: 15_000, url: `${http.baseUrl}/blocked-${index}` },
      name: `monitor-${index}`,
    })),
    requestId: "bounded",
  };
  const run = await ws.submit("health-check", payload, "bounded");
  await until(
    "two active HTTP requests",
    () => [...http.counts.values()].reduce((sum, count) => sum + count, 0),
    (count) => count === 2
  );
  await Bun.sleep(150);
  expect([...http.counts.values()].reduce((sum, count) => sum + count, 0)).toBe(
    2
  );
  http.release();
  const completed = await ws.terminal(run.id);
  expect(completed.result).toMatchObject({
    healthy: 7,
    total: 7,
  });
  expect(http.peak).toBe(2);
}, 60_000);

test("cancelling a blocked run prevents later monitors from starting", async () => {
  const { ws, http } = setup();
  await ws.serve();
  const run = await ws.submit(
    "health-check",
    {
      concurrency: 1,
      monitors: Array.from({ length: 4 }, (_, index) => ({
        config: { timeoutMs: 15_000, url: `${http.baseUrl}/blocked-${index}` },
        name: `monitor-${index}`,
      })),
      requestId: "cancel-blocked",
    },
    "cancel-blocked"
  );
  await until(
    "first blocked monitor",
    () => http.counts.get("/blocked-0") ?? 0,
    (count) => count === 1
  );
  await ws.command(["run", "cancel", run.id]);
  await ws.terminal(run.id, "cancelled");
  http.release();
  await Bun.sleep(200);
  expect([...http.counts.keys()]).toEqual(["/blocked-0"]);
}, 60_000);

test("CLI refuses a live second owner and reuses a committed Activity after SIGKILL", async () => {
  const { ws, http } = setup();
  const server = await ws.serve();
  const refused = await ws.command(["serve"], false);
  expect(JSON.stringify(refused)).toMatch(/owned|owner|running|runner/iu);
  const payload = { baseUrl: http.baseUrl, requestId: "crash" };
  const run = await ws.submit("restart-proof", payload, "crash");
  await until(
    "second Activity commit barrier",
    () => http.counts.get("/blocked") ?? 0,
    (count) => count === 1
  );
  expect(http.counts.get("/first")).toBe(1);
  await ws.stop(server, "SIGKILL");
  http.release();
  const restarted = await ws.serve();
  const duplicate = await ws.submit("restart-proof", payload, "crash");
  expect(duplicate.id).toBe(run.id);
  const finished = await ws.terminal(run.id);
  expect(finished.result).toBe("first-committed");
  expect(http.counts.get("/first")).toBe(1);
  await ws.stop(restarted);
  await ws.serve();
  const reopened = await ws.inspect(run.id);
  expect(reopened.status).toBe("succeeded");
  expect(http.counts.get("/first")).toBe(1);
}, 90_000);

test("approval review survives restart; stale or missing review cannot authorize the exact action", async () => {
  const { ws, http } = setup();
  const server = await ws.serve();
  const run = await ws.submit(
    "approved-health-check",
    input(http.baseUrl, "approved"),
    "approved"
  );
  const gate = await ws.approval(run.id);
  const inspected = (await ws.command([
    "approval",
    "inspect",
    gate.id,
  ])) as Gate;
  expect(inspected.review.summary).toMatchObject({
    healthy: 2,
    total: 3,
    unhealthy: 1,
  });
  expect(existsSync(inspected.review.action.path)).toBe(false);
  const planArtifacts = (await ws.command([
    "artifact",
    "list",
    "--run",
    run.id,
  ])) as Artifact[];
  expect(
    planArtifacts.find((artifact) => artifact.name === "action-plan")?.value
  ).toEqual(inspected.review);
  await ws.stop(server);
  await ws.serve();
  const recovered = (await ws.command([
    "approval",
    "inspect",
    gate.id,
  ])) as Gate;
  expect(recovered.digest).toBe(inspected.digest);
  expect(recovered.review).toEqual(inspected.review);
  expect(http.counts.get("/healthy")).toBe(1);
  await ws.command(["approval", "approve", gate.id], false);
  await ws.command(
    [
      "approval",
      "approve",
      gate.id,
      "--digest",
      "stale-digest",
      "--revision",
      gate.revision,
    ],
    false
  );
  await ws.command(
    [
      "approval",
      "approve",
      gate.id,
      "--digest",
      gate.digest,
      "--revision",
      "stale-revision",
    ],
    false
  );
  expect(existsSync(inspected.review.action.path)).toBe(false);
  await ws.command(["approval", "approve", gate.id, ...reviewed(gate)]);
  await ws.command(["run", "resume", run.id]);
  const finished = await ws.terminal(run.id);
  expect(finished.result).toMatchObject({
    actionPath: inspected.review.action.path,
  });
  const bytes = readFileSync(inspected.review.action.path, "utf-8");
  expect(JSON.parse(bytes)).toEqual(inspected.review.action.value);
  await ws.command(["approval", "approve", gate.id, ...reviewed(gate)]);
  await ws.command(
    ["approval", "reject", gate.id, "--reason", "conflicting decision"],
    false
  );
  expect(readFileSync(inspected.review.action.path, "utf-8")).toBe(bytes);
  expect(http.counts.get("/healthy")).toBe(1);
}, 90_000);

test("rejection fails the workflow and cancellation prevents late approval after restart", async () => {
  const { ws, http } = setup();
  let server = await ws.serve();
  const rejected = await ws.submit(
    "approved-health-check",
    input(http.baseUrl, "rejected"),
    "rejected"
  );
  const rejectedGate = await ws.approval(rejected.id);
  await ws.command([
    "approval",
    "reject",
    rejectedGate.id,
    "--reason",
    "Revise the health report",
  ]);
  await ws.terminal(rejected.id, "failed");
  expect(existsSync(rejectedGate.review.action.path)).toBe(false);
  await ws.command(
    ["approval", "approve", rejectedGate.id, ...reviewed(rejectedGate)],
    false
  );

  const cancelled = await ws.submit(
    "approved-health-check",
    input(http.baseUrl, "cancelled"),
    "cancelled"
  );
  const cancelledGate = await ws.approval(cancelled.id);
  await ws.command(["run", "cancel", cancelled.id]);
  await ws.terminal(cancelled.id, "cancelled");
  await ws.stop(server);
  server = await ws.serve();
  await ws.command(
    ["approval", "approve", cancelledGate.id, ...reviewed(cancelledGate)],
    false
  );
  const inspectedCancelled = await ws.inspect(cancelled.id);
  expect(inspectedCancelled.status).toBe("cancelled");
  expect(existsSync(cancelledGate.review.action.path)).toBe(false);
  await ws.stop(server);
}, 90_000);

test("approved action refuses preexisting conflicting bytes and accepts identical replay", async () => {
  const { ws, http } = setup();
  await ws.serve();
  const run = await ws.submit(
    "approved-health-check",
    input(http.baseUrl, "conflict"),
    "conflict"
  );
  const gate = await ws.approval(run.id);
  const { path } = gate.review.action;
  // Exercise the same helper used by the action Activity at its ambiguous-write boundary.
  await Effect.runPromise(writeReport(path, gate.review.action.value));
  const original = readFileSync(path, "utf-8");
  await Effect.runPromise(writeReport(path, gate.review.action.value));
  expect(readFileSync(path, "utf-8")).toBe(original);
  writeFileSync(path, "conflicting preexisting bytes\n");
  await ws.command(["approval", "approve", gate.id, ...reviewed(gate)]);
  await ws.command(["run", "resume", run.id], false);
  await ws.terminal(run.id, "failed");
  expect(readFileSync(path, "utf-8")).toBe("conflicting preexisting bytes\n");
}, 60_000);

test("editing a suspended task's transitive source refuses runner activation", async () => {
  const { ws, http } = setup();
  const server = await ws.serve();
  const run = await ws.submit(
    "approved-health-check",
    input(http.baseUrl, "revision"),
    "revision"
  );
  const gate = await ws.approval(run.id);
  await ws.stop(server);
  const source = pathModule.join(
    ws.path,
    ".effectory/automations/health-check/definition.ts"
  );
  writeFileSync(
    source,
    `${readFileSync(source, "utf-8")}\n// changed implementation revision\n`
  );
  const refused = await ws.command(["serve"], false);
  expect(JSON.stringify(refused)).toMatch(
    /revision|changed|unfinished|fingerprint/iu
  );
  expect(existsSync(gate.review.action.path)).toBe(false);
}, 60_000);
