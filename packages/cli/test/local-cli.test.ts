import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CliWorkspace, loopbackFixture, until } from "./fixtures/helpers.ts";
import type { Gate, Run } from "./fixtures/helpers.ts";

let workspace: CliWorkspace | undefined;
let fixture: ReturnType<typeof loopbackFixture> | undefined;
afterEach(async () => {
  fixture?.close();
  await workspace?.close();
  workspace = undefined;
  fixture = undefined;
});
const setup = () => {
  workspace = new CliWorkspace();
  fixture = loopbackFixture();
  return { http: fixture, ws: workspace };
};
const taskArgs = (
  ws: CliWorkspace,
  name: string,
  input: unknown,
  key: string
) => {
  const file = path.join(ws.path, `${key}.json`);
  writeFileSync(file, JSON.stringify(input));
  return ["workflow", "run", name, "--input", file, "--request-key", key];
};
const payload = (baseUrl: string, requestId: string) => ({
  concurrency: 1,
  monitors: [
    { config: { timeoutMs: 5000, url: `${baseUrl}/healthy` }, name: "healthy" },
  ],
  requestId,
});
const reviewFlags = (gate: Gate) => [
  "--digest",
  gate.digest,
  "--revision",
  gate.revision,
];
const collect = async (child: ReturnType<CliWorkspace["spawn"]>) => {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stderr, stdout };
};

test("local CLI runs to completion, closes its runtime, and inspects history without importing task code", async () => {
  const { ws, http } = setup();
  expect(
    JSON.stringify(await ws.command(["workflow", "list", "--json"]))
  ).toContain("health-check");
  const args = taskArgs(
    ws,
    "health-check",
    payload(http.baseUrl, "local"),
    "local"
  );
  const result = (await ws.command(args)) as Run;
  expect(result.status).toBe("succeeded");
  expect(result.result).toMatchObject({ healthy: 1, total: 1 });
  expect(existsSync(path.join(ws.path, ".effectory/state/control.sock"))).toBe(
    false
  );
  const duplicate = (await ws.command(args)) as Run;
  expect(duplicate.id).toBe(result.id);
  expect(http.counts.get("/healthy")).toBe(1);
  writeFileSync(
    path.join(ws.path, ".effectory/automations/health-check/index.ts"),
    'throw new Error("must not import for inspection")'
  );
  const inspected = await ws.inspect(result.id);
  expect(inspected.status).toBe("succeeded");
  expect(
    await ws.command(["artifact", "list", "--run", result.id])
  ).toHaveLength(2);
}, 60_000);

test("local approval only records a decision; explicit resume completes without replaying checks", async () => {
  const { ws, http } = setup();
  const run = (await ws.command(
    taskArgs(ws, "approved-health-check", payload(http.baseUrl, "gate"), "gate")
  )) as Run;
  expect(run.status).toBe("suspended");
  const gate = await ws.approval(run.id);
  await ws.command(["run", "resume", run.id], false);
  await ws.command(["approval", "approve", gate.id], false);
  await ws.command(["approval", "approve", gate.id, ...reviewFlags(gate)]);
  await ws.command(["approval", "approve", gate.id, ...reviewFlags(gate)]);
  const inspected = await ws.inspect(run.id);
  expect(inspected.status).toBe("suspended");
  expect(existsSync(gate.review.action.path)).toBe(false);
  expect(await ws.command(["approval", "inspect", gate.id])).toMatchObject({
    delivered: false,
    status: "approved",
  });
  // Even an executing host reopening the native journal cannot bypass explicit resume.
  const server = await ws.serve();
  await Bun.sleep(300);
  expect(existsSync(gate.review.action.path)).toBe(false);
  await ws.stop(server);
  const completed = (await ws.command(["run", "resume", run.id])) as Run;
  expect(completed.status).toBe("succeeded");
  expect(JSON.parse(readFileSync(gate.review.action.path, "utf-8"))).toEqual(
    gate.review.action.value
  );
  expect(http.counts.get("/healthy")).toBe(1);
  const replay = (await ws.command(["run", "resume", run.id])) as Run;
  expect(replay.status).toBe("succeeded");
}, 90_000);

test("local rejection fails the run and failed execution exits nonzero", async () => {
  const { ws, http } = setup();
  const run = (await ws.command(
    taskArgs(
      ws,
      "approved-health-check",
      payload(http.baseUrl, "reject"),
      "reject"
    )
  )) as Run;
  const gate = await ws.approval(run.id);
  await ws.command([
    "approval",
    "reject",
    gate.id,
    "--reason",
    "Revise this plan",
  ]);
  expect(await ws.inspect(run.id)).toMatchObject({
    error: "Revise this plan",
    status: "failed",
  });
  const failed = (await ws.command(["run", "resume", run.id], false)) as {
    stdout: string;
    stderr: string;
  };
  expect(failed.stdout, failed.stderr).not.toBe("");
  expect(JSON.parse(failed.stdout).status).toBe("failed");
  expect(existsSync(gate.review.action.path)).toBe(false);
}, 60_000);

test("a killed foreground CLI resumes committed activities in a later invocation", async () => {
  const { ws, http } = setup();
  const args = taskArgs(
    ws,
    "restart-proof",
    { baseUrl: http.baseUrl, requestId: "crash-local" },
    "crash-local"
  );
  const child = ws.spawn(args);
  const output = collect(child);
  await until(
    "foreground second activity",
    () => http.counts.get("/blocked"),
    (count) => count === 1
  );
  child.kill("SIGKILL");
  const exited = await output;
  expect(exited.code).not.toBe(0);
  http.release();
  const [run] = (await ws.command(["run", "list"])) as Run[];
  expect(http.counts.get("/blocked")).toBe(1);
  if (!run) {
    throw new Error("Missing persisted run");
  }
  const result = (await ws.command(["run", "resume", run.id])) as Run;
  expect(result.status).toBe("succeeded");
  expect(result.result).toBe("first-committed");
  expect(http.counts.get("/first")).toBe(1);
}, 60_000);

test("a workflow failure prints its final record and exits nonzero", async () => {
  const { ws } = setup();
  const directory = path.join(ws.path, ".effectory/automations/failure-proof");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "index.ts"),
    `
import { Effect, Schema } from "effect";
import * as Workflow from "effect/workflow/Workflow";
const workflow = Workflow.make("LocalFailureProof", {
  payload: { requestId: Schema.String }, success: Schema.String, error: Schema.String,
  idempotencyKey: (input) => input.requestId,
});
export default { description: "Expected workflow failure", workflow,
  implementation: workflow.toLayer(() => Effect.fail("expected failure")) };
`
  );
  const failed = (await ws.command(
    taskArgs(ws, "failure-proof", { requestId: "failure" }, "failure"),
    false
  )) as { stdout: string };
  const record = JSON.parse(failed.stdout) as Run & { error: string };
  expect(record.status).toBe("failed");
  expect(record.error).toContain("expected failure");
  expect(await ws.inspect(record.id)).toMatchObject({ status: "failed" });
}, 60_000);

test("SIGTERM cancels a foreground CLI run and releases the workspace", async () => {
  const { ws, http } = setup();
  const child = ws.spawn(
    taskArgs(
      ws,
      "health-check",
      {
        concurrency: 1,
        monitors: [
          {
            config: { timeoutMs: 15_000, url: `${http.baseUrl}/blocked-0` },
            name: "blocked",
          },
          {
            config: { timeoutMs: 5000, url: `${http.baseUrl}/healthy` },
            name: "later",
          },
        ],
        requestId: "signal-local",
      },
      "signal-local"
    )
  );
  const output = collect(child);
  await until(
    "foreground activity before signal",
    () => http.counts.get("/blocked-0"),
    (count) => count === 1
  );
  child.kill("SIGTERM");
  await until(
    "persisted cancellation request",
    async () => (await ws.command(["run", "list"])) as Run[],
    (runs) => runs.some((run) => run.status === "cancelling")
  );
  expect(child.exitCode).toBeNull();
  http.release();
  const exited = await output;
  expect(exited.code).not.toBe(0);
  const [run] = (await ws.command(["run", "list"])) as Run[];
  expect(run?.status).toBe("cancelled");
  expect(http.counts.get("/healthy")).toBeUndefined();
  expect(existsSync(path.join(ws.path, ".effectory/state/control.sock"))).toBe(
    false
  );
}, 60_000);
