import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dir, "..", "..", "..");
const main = path.join(repo, "packages", "cli", "src", "main.ts");

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "flow-cli-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

/** Run `flow` from the repository root against a fresh store. */
const flow = async (...args: readonly string[]) => {
  const child = Bun.spawn(
    ["bun", main, "--db", path.join(dir, "runs.db"), ...args],
    { cwd: repo, stderr: "pipe", stdout: "pipe" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr, stdout };
};

/** Run `flow ... --json` and parse what it prints. */
const flowJson = async (...args: readonly string[]) => {
  const { code, stderr, stdout } = await flow(...args, "--json");
  if (code !== 0) {
    throw new Error(`flow ${args.join(" ")} exited ${code}: ${stderr}`);
  }
  // oxlint-disable-next-line typescript/no-explicit-any -- CLI output is JSON.
  return JSON.parse(stdout) as any;
};

const approvalKey = (plan: string) =>
  `ApprovePlan(${JSON.stringify({ goal: "dark mode", plan })})`;

describe("flow", () => {
  test("tasks lists and searches the Tasks in flow.run.ts", async () => {
    const all = await flowJson("tasks");
    expect(all.map((task: { name: string }) => task.name)).toEqual([
      "Implement",
      "Approve",
      "ApprovePlan",
      "Refine",
      "Draft",
      "Review",
    ]);
    const human = await flowJson("tasks", "human");
    expect(human).toEqual([
      expect.objectContaining({ kind: "task", name: "Approve" }),
      expect.objectContaining({ kind: "input", name: "ApprovePlan" }),
    ]);
  });

  test("plan shows the graph, including where a person may be asked", async () => {
    const { code, stdout } = await flow(
      "plan",
      "Implement",
      "--input",
      '"dark mode"'
    );
    expect(code).toBe(0);
    expect(stdout).toStartWith("flowchart TD");
    expect(stdout).toContain('{{"ApprovePlan#40;…#41;"}}');
  });

  test("a run waits for a person, who revises then approves from a file", async () => {
    const started = await flowJson(
      "run",
      "Implement",
      "--input",
      '"dark mode"'
    );
    expect(started).toMatchObject({
      _tag: "Suspended",
      pending: [{ key: approvalKey("dark mode, add tests") }],
    });

    const revised = await flowJson(
      "resume",
      started.runId,
      "--respond",
      '{"_tag":"Revise","notes":"and docs"}'
    );
    expect(revised).toMatchObject({
      _tag: "Suspended",
      pending: [{ key: approvalKey("dark mode, and docs") }],
    });

    const answers = path.join(dir, "answers.json");
    writeFileSync(
      answers,
      JSON.stringify({
        [approvalKey("dark mode, and docs")]: { _tag: "Approve", by: "dana" },
      })
    );
    const approved = await flowJson(
      "resume",
      started.runId,
      "--responses",
      `@${answers}`
    );
    expect(approved).toMatchObject({
      _tag: "Succeeded",
      output: "Implemented: dark mode, and docs",
    });

    const state = await flowJson("status", started.runId);
    expect(state.run.status).toBe("succeeded");
    expect(
      state.nodes.find(
        (node: { key: string }) => node.key === 'Implement("dark mode")'
      )
    ).toMatchObject({ attempts: 1, status: "succeeded" });
    expect(await flowJson("runs")).toEqual([
      { id: started.runId, status: "succeeded", task: "Implement" },
    ]);
  });

  test("mistakes print one line and exit 1", async () => {
    const unknown = await flow("run", "Nope");
    expect(unknown).toMatchObject({
      code: 1,
      stderr: "flow: No Task named Nope\n",
    });

    const invalid = await flow("run", "Implement", "--input", "42");
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toStartWith("flow: Invalid input for Implement");

    const missing = await flow("status", "no-such-run");
    expect(missing).toMatchObject({
      code: 1,
      stderr: "flow: No run no-such-run\n",
    });

    const entry = path.join(dir, "flow.run.ts");
    writeFileSync(entry, "export default {};\n");
    const notAnApp = await flow("--file", entry, "tasks");
    expect(notAnApp).toMatchObject({
      code: 1,
      stderr: `flow: ${entry} must default-export Flow.make(...)\n`,
    });
  });
});
