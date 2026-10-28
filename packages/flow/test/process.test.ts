import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const fixture = path.join(import.meta.dir, "fixtures", "release.ts");

let dir = "";
let db = "";
let events = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "flow-process-"));
  db = path.join(dir, "runs.db");
  events = path.join(dir, "events.log");
  writeFileSync(events, "");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

const spawn = (args: readonly string[], env: Record<string, string> = {}) =>
  Bun.spawn(["bun", fixture, db, events, ...args], {
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });

/** Run one fixture command in its own process and parse its output. */
const command = async (
  args: readonly string[],
  env: Record<string, string> = {}
) => {
  const child = spawn(args, env);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`fixture ${args.join(" ")} exited ${code}: ${stderr}`);
  }
  // oxlint-disable-next-line typescript/no-explicit-any -- fixture output is JSON.
  return JSON.parse(stdout) as any;
};

const eventLog = () =>
  readFileSync(events, "utf-8").split("\n").filter(Boolean);

const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out");
    }
    // oxlint-disable-next-line no-await-in-loop -- polling, one check at a time.
    await Bun.sleep(20);
  }
};

const confirm = JSON.stringify({ 'Confirm("production")': true });

describe("durable runs across processes", () => {
  test("a run suspends in one process and finishes in the next", async () => {
    const started = await command(["start"]);
    expect(started).toMatchObject({
      _tag: "Suspended",
      pending: [{ key: 'Confirm("production")', request: "production" }],
    });
    expect(eventLog()).toEqual(["build"]);

    const resumed = await command(["resume", started.runId, confirm]);
    expect(resumed).toMatchObject({
      _tag: "Succeeded",
      output: "deployed artifact",
    });
    // Build ran once, in the first process.
    expect(eventLog()).toEqual(["build", "deploy:start", "deploy:end"]);
  });

  test("a killed run is busy while leased, then resumes and reruns only the cut-off node", async () => {
    const { runId } = await command(["start"]);

    const hanging = spawn(["resume", runId, confirm], {
      HANG: "deploy",
      LEASE_MS: "500",
    });
    await waitFor(() => eventLog().includes("deploy:start"));

    // The hanging process holds and renews the lease.
    expect(await command(["resume", runId])).toEqual({ error: "busy" });

    hanging.kill("SIGKILL");
    await hanging.exited;
    const cutOff = await command(["status", runId]);
    expect(cutOff.run.status).toBe("running");
    expect(
      cutOff.nodes.find((node: { key: string }) => node.key === "Deploy(null)")
    ).toMatchObject({ attempts: 1, status: "running" });

    // Once the dead process's lease lapses, the run can be resumed.
    await Bun.sleep(600);
    const resumed = await command(["resume", runId]);
    expect(resumed).toMatchObject({ _tag: "Succeeded" });
    expect(eventLog()).toEqual([
      "build",
      "deploy:start",
      "deploy:start",
      "deploy:end",
    ]);
    const finished = await command(["status", runId]);
    expect(
      finished.nodes.find(
        (node: { key: string }) => node.key === "Deploy(null)"
      )
    ).toMatchObject({ attempts: 2, status: "succeeded" });
  });
});
