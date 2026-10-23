import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const main = path.resolve(import.meta.dir, "../src/main.ts");
const fixture = path.resolve(import.meta.dir, "fixtures/basic");

let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), "effectory-cli-"));
});

afterAll(() => {
  rmSync(home, { force: true, recursive: true });
});

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const cli = (
  args: readonly string[],
  options: { readonly cwd?: string } = {}
): Result => {
  const result = Bun.spawnSync(["bun", main, ...args], {
    cwd: options.cwd ?? fixture,
    env: { ...process.env, EFFECTORY_HOME: home, NO_COLOR: "1" },
  });
  return {
    code: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
};

const json = <A>(args: readonly string[], code = 0): A => {
  const result = cli([...args, "--json"]);
  expect({ code: result.code, stderr: result.stderr }).toEqual({
    code,
    stderr: "",
  });
  return JSON.parse(result.stdout) as A;
};

interface RunJson {
  readonly exitCode: number;
  readonly run: {
    readonly id: string;
    readonly status: string;
    readonly result?: unknown;
    readonly target?: string;
  };
  readonly nodes: readonly { readonly fqn: string; readonly status: string }[];
  readonly approvals: readonly { readonly id: string }[];
}

describe("effectory CLI", () => {
  test("describe --json lists the collection with JSON Schemas", () => {
    const described = json<{
      readonly name: string;
      readonly workflows: readonly {
        readonly name: string;
        readonly input: { readonly required: readonly string[] };
      }[];
      readonly actions: readonly { readonly type: string }[];
      readonly resources: readonly { readonly type: string }[];
      readonly targets: readonly { readonly name: string }[];
      readonly triggers: readonly { readonly route: string }[];
    }>(["describe"]);
    expect(described.name).toBe("cli-fixture");
    expect(described.workflows.map((workflow) => workflow.name)).toEqual([
      "hello",
      "check",
      "gated",
    ]);
    expect(described.workflows[0]?.input.required).toEqual(["name"]);
    expect(described.actions.map((action) => action.type)).toEqual(["Greet"]);
    expect(described.resources.map((resource) => resource.type)).toEqual([
      "Fixture.Note",
    ]);
    expect(described.targets.map((target) => target.name)).toEqual(["team"]);
    expect(described.triggers[0]?.route).toBe("/hello");
  });

  test("run --plan and --mermaid print the plan without running", () => {
    const plan = cli(["run", "hello", "--plan", "--input", "name=plan"]);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain("run      hello/greet (Greet)");
    expect(plan.stdout).toContain("hello/note (Fixture.Note)  <- hello/greet");
    const mermaid = cli(["run", "hello", "--mermaid", "--input", "name=plan"]);
    expect(mermaid.code).toBe(0);
    expect(mermaid.stdout).toContain("flowchart");
    const runs = json<readonly unknown[]>([
      "run",
      "list",
      "--workflow",
      "hello",
    ]);
    expect(runs).toHaveLength(0);
  });

  test("a successful run prints its nodes and result and exits 0", () => {
    const result = cli(["run", "hello", "--input", "name=ann"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      /Run \S+ of hello \(scope ann, live\): succeeded/u
    );
    expect(result.stdout).toContain("succeeded  hello/note");
    expect(result.stdout).toContain('"message": "Hello, ann!"');
  });

  test("failing assertions exit 1 unless --fail-on allows them", () => {
    const failing = cli([
      "run",
      "check",
      "--input",
      "name=bob",
      "--input",
      "expected=Hi, bob!",
    ]);
    expect(failing.code).toBe(1);
    expect(failing.stdout).toContain(
      'FAIL [medium] check/matches: expected "Hi, bob!", got "Hello, bob!"'
    );
    const high = cli([
      "run",
      "check",
      "--input-json",
      '{"name":"bob","expected":"x"}',
      "--fail-on",
      "high",
    ]);
    expect(high.code).toBe(0);
    const none = cli([
      "run",
      "check",
      "--input-json",
      '{"name":"bob","expected":"y"}',
      "--fail-on",
      "none",
    ]);
    expect(none.code).toBe(0);
  });

  test("--junit writes JUnit XML", () => {
    const file = path.join(home, "report.xml");
    const result = cli([
      "run",
      "check",
      "--input",
      "name=cy",
      "--input",
      "expected=Hello, cy!",
      "--junit",
      file,
    ]);
    expect(result.code).toBe(0);
    const xml = readFileSync(file, "utf-8");
    expect(xml).toContain('<testsuite id="');
    expect(xml).toContain('name="check/matches"/>');
    const other = path.join(home, "other.xml");
    expect(
      cli([
        "run",
        "check",
        "--input",
        "name=cy",
        "--input",
        "expected=nope",
        `--junit=${other}`,
      ]).code
    ).toBe(1);
    expect(readFileSync(other, "utf-8")).toContain("<failure");
  });

  test("approvals suspend a run until approved and resumed", () => {
    const suspended = json<RunJson>(["run", "gated", "--input", "name=dee"], 2);
    expect(suspended.run.status).toBe("suspended");
    const [approval] = suspended.approvals;
    expect(approval?.id).toBe(`${suspended.run.id}:gated/ship`);

    const human = cli(["run", "inspect", suspended.run.id.slice(0, 12)]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("suspended  gated/ship");
    expect(human.stdout).toContain("pending  Ship");

    const listed = cli(["approval", "list"]);
    expect(listed.stdout).toContain(`${approval?.id}`);
    expect(listed.stdout).toContain('Ship "Hello, dee!"?');

    const busy = cli(["run", "gated", "--input", "name=dee"]);
    expect(busy.code).toBe(1);
    expect(busy.stderr).toContain("resume or cancel it first");

    const approved = cli([
      "approval",
      "approve",
      approval?.id ?? "",
      "--note",
      "ship it",
      "--by",
      "tester",
    ]);
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain(
      `effectory run resume ${suspended.run.id}`
    );

    const resumed = json<RunJson>(["run", "resume", suspended.run.id]);
    expect(resumed.run.status).toBe("succeeded");
    expect(resumed.run.result).toEqual({ message: "Shipped, dee!" });
    expect(resumed.exitCode).toBe(0);

    const inspected = json<{
      readonly approvals: readonly {
        readonly status: string;
        readonly decidedBy: string;
        readonly note: string;
      }[];
      readonly records: readonly { readonly fqn: string }[];
    }>(["run", "inspect", suspended.run.id]);
    expect(inspected.approvals).toMatchObject([
      { decidedBy: "tester", note: "ship it", status: "approved" },
    ]);
    expect(inspected.records.map((record) => record.fqn).toSorted()).toEqual([
      "gated/after",
      "gated/before",
    ]);
  });

  test("rejecting an approval fails the run on resume; cancel finishes one", () => {
    const first = json<RunJson>(["run", "gated", "--input", "name=eve"], 2);
    expect(cli(["approval", "reject", first.approvals[0]?.id ?? ""]).code).toBe(
      0
    );
    const rejected = cli(["run", "resume", first.run.id]);
    expect(rejected.code).toBe(1);
    expect(rejected.stdout).toContain("ApprovalRejected");

    const second = json<RunJson>(["run", "gated", "--input", "name=fay"], 2);
    const cancelled = cli(["run", "cancel", second.run.id]);
    expect(cancelled.code).toBe(0);
    expect(cancelled.stdout).toContain(": cancelled");
    expect(cli(["approval", "list", "--run", second.run.id]).stdout).toBe(
      "No approvals.\n"
    );
  });

  test("run list filters by workflow and status", () => {
    const runs = json<readonly { readonly workflow: string }[]>([
      "run",
      "list",
      "--workflow",
      "gated",
      "--status",
      "succeeded",
    ]);
    expect(runs.map((run) => run.workflow)).toEqual(["gated"]);
    const human = cli(["run", "list", "--limit", "2"]);
    expect(human.stdout.split("\n")[0]).toMatch(/^ID\s+WORKFLOW\s+STATUS/u);
    expect(human.stdout.trim().split("\n")).toHaveLength(3);
    expect(cli(["run", "inspect", "nope"]).stderr).toContain("No run nope");
  });

  test("target presets merge with --input overrides", () => {
    const preset = json<RunJson>(["run", "hello", "--target", "team"]);
    expect(preset.run.result).toEqual({
      message: "Hi, team!",
      note: "hello/note",
    });
    expect(preset.run.target).toBe("team");
    const overridden = json<RunJson>([
      "run",
      "hello",
      "--target",
      "team",
      "--input",
      "greeting=Yo",
    ]);
    expect(overridden.run.result).toMatchObject({ message: "Yo, team!" });
    expect(cli(["run", "check", "--target", "team"]).stderr).toContain(
      "No target team for workflow check"
    );
  });

  test("data latest, versions, and query read records", () => {
    const latest = cli(["data", "latest", "hello/greet", "--scope", "team"]);
    expect(latest.code).toBe(0);
    expect(latest.stdout).toContain('"message": "Yo, team!"');
    const versions = json<readonly { readonly value: unknown }[]>([
      "data",
      "versions",
      "hello/greet",
      "--scope",
      "team",
    ]);
    expect(versions.map((record) => record.value)).toEqual([
      { message: "Yo, team!" },
      { message: "Hi, team!" },
    ]);
    const failed = json<readonly { readonly fqn: string }[]>([
      "data",
      "query",
      "--kind",
      "AssertResult",
      "--where",
      "passed = false and severity = 'medium'",
      "--since",
      "1h",
    ]);
    expect(failed.length).toBeGreaterThan(0);
    expect(new Set(failed.map((record) => record.fqn))).toEqual(
      new Set(["check/matches"])
    );
    expect(
      cli(["data", "latest", "hello/greet", "--scope", "nobody"]).code
    ).toBe(1);
    expect(cli(["data", "query", "--where", "a ~ b"]).stderr).toContain(
      "Unexpected"
    );
  });

  test("resource list and delete", () => {
    const listed = cli(["resource", "list", "--scope", "ann"]);
    expect(listed.stdout).toContain("hello/note");
    expect(listed.stdout).toContain("Fixture.Note");
    const deleted = cli(["resource", "delete", "hello/note", "--scope", "ann"]);
    expect(deleted.code).toBe(0);
    expect(
      json<readonly unknown[]>(["resource", "list", "--scope", "ann"])
    ).toEqual([]);
    expect(
      cli(["resource", "delete", "hello/note", "--scope", "ann"]).stderr
    ).toContain("No resource hello/note");
  });

  test("action run wraps an Action in a one-node workflow", () => {
    const ran = json<RunJson>([
      "action",
      "run",
      "Greet",
      "--input",
      "name=gus",
      "--input",
      "greeting=Hey",
    ]);
    expect(ran.run.result).toEqual({ message: "Hey, gus!" });
    expect(ran.nodes.map((node) => node.fqn)).toEqual(["Greet/run"]);
    const inspected = cli(["run", "inspect", ran.run.id]);
    expect(inspected.stdout).toContain("of Greet (scope adhoc");
    expect(cli(["action", "run", "Nope"]).stderr).toContain("No Action Nope");
  });

  test("errors are printed without stack traces", () => {
    const unknown = cli(["run", "missing"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe(
      "effectory: No workflow missing; workflows: hello, check, gated\n"
    );
    const invalid = cli(["run", "hello", "--input", "greeting=x"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toStartWith("effectory: Invalid input for hello");
    const noCollection = cli(["describe"], { cwd: home });
    expect(noCollection.code).toBe(1);
    expect(noCollection.stderr).toContain("No collection root");
  });

  test("serve dispatches webhook runs", async () => {
    const server = Bun.spawn(["bun", main, "serve", "--port", "0"], {
      cwd: fixture,
      env: { ...process.env, EFFECTORY_HOME: home },
      stderr: "pipe",
      stdout: "pipe",
    });
    try {
      const reader = server.stdout.getReader();
      let output = "";
      while (!output.includes("/hello")) {
        // oxlint-disable-next-line no-await-in-loop -- reading a stream in order.
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error(`serve exited: ${output}`);
        }
        output += new TextDecoder().decode(chunk.value);
      }
      const url = /POST (?<url>\S+\/hello)/u.exec(output)?.groups?.url ?? "";
      const response = await fetch(url, {
        body: JSON.stringify({ name: "hal" }),
        method: "POST",
      });
      expect(response.status).toBe(202);
      const { runId } = (await response.json()) as { readonly runId: string };
      reader.releaseLock();
      let status = "running";
      for (
        let attempt = 0;
        attempt < 50 && status === "running";
        attempt += 1
      ) {
        ({ status } = json<RunJson>(["run", "inspect", runId]).run);
        // oxlint-disable-next-line no-await-in-loop -- polling until the run finishes.
        await Bun.sleep(50);
      }
      expect(status).toBe("succeeded");
    } finally {
      server.kill();
      await server.exited;
    }
  });
});

describe("revisions", () => {
  test("resume is refused after the collection source changes", () => {
    const scratch = mkdtempSync(path.join(import.meta.dir, ".tmp-revision-"));
    try {
      cpSync(fixture, scratch, { recursive: true });
      const suspended = json<RunJson>(
        ["--collection", scratch, "run", "gated", "--input", "name=ivy"],
        2
      );
      appendFileSync(
        path.join(scratch, "greeting.ts"),
        "\nexport const changed = true;\n"
      );
      expect(
        cli(["approval", "approve", suspended.approvals[0]?.id ?? ""], {
          cwd: scratch,
        }).code
      ).toBe(0);
      const resumed = cli(["run", "resume", suspended.run.id], {
        cwd: scratch,
      });
      expect(resumed.code).toBe(1);
      expect(resumed.stderr).toContain(
        "Restore that source or start a new run"
      );
      expect(existsSync(path.join(scratch, "effectory.ts"))).toBe(true);
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });
});
