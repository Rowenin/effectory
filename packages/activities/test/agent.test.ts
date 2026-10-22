import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as BunServices from "@effect/platform-bun/BunServices";
import { Agent, Claude, Codex } from "@effectory/activities";
import type { InTask } from "@effectory/sdk";
import { AutomationError, Task } from "@effectory/sdk";
import { Effect, Layer, Schema } from "effect";
import * as Workflow from "effect/workflow/Workflow";
import type { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import { WorkflowEngine, layerMemory } from "effect/workflow/WorkflowEngine";

interface Call {
  readonly args: readonly string[];
  readonly env: string | null;
  readonly schema: unknown;
  readonly stdin: string;
}

let directory = "";
let log = "";
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "effectory agent "));
  log = path.join(directory, "calls.jsonl");
});
afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

/**
 * A fake CLI that records each call (including a Codex schema file's content),
 * then runs `body`. `args` and `option(name)` are in scope.
 */
const fake = (name: string, body: string) => {
  const executable = path.join(directory, name);
  writeFileSync(
    executable,
    `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = await import("node:fs");
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const stdin = await Bun.stdin.text();
const schemaFile = option("--output-schema");
const schema = schemaFile ? JSON.parse(readFileSync(schemaFile, "utf-8")) : JSON.parse(option("--json-schema") ?? "null");
const env = process.env.ANTHROPIC_API_KEY ?? process.env.CODEX_API_KEY ?? null;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env, schema, stdin }) + "\\n");
${body}
`
  );
  chmodSync(executable, 0o755);
  return executable;
};
const calls = (): Call[] =>
  existsSync(log)
    ? readFileSync(log, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Call)
    : [];

const claudeReply = (fields: Record<string, unknown> = {}, name = "claude") =>
  fake(
    name,
    `console.log(JSON.stringify(${JSON.stringify({
      is_error: false,
      modelUsage: { "claude-haiku-5-5": {} },
      result: "done",
      session_id: "session-1",
      subtype: "success",
      total_cost_usd: 0.01,
      type: "result",
      ...fields,
    })}));`
  );
const codexReply = (message: string) =>
  fake(
    "codex",
    `writeFileSync(option("--output-last-message"), ${JSON.stringify(message)}); console.log("ignored");`
  );

const Summary = Schema.Struct({
  risk: Schema.Literals(["low", "high"]),
  title: Schema.String,
});

// Named Tasks over the Agent service, as an automation would define them.
const ask = Task.make({
  error: Agent.Failure,
  input: Schema.Struct({
    access: Schema.optionalKey(Agent.Access),
    model: Schema.optionalKey(Schema.String),
    prompt: Schema.String,
  }),
  name: "ask",
  run: (input) => Agent.run(input),
  success: Agent.RunResult,
});
const summarize = Task.make({
  error: Agent.Failure,
  input: Schema.Struct({ prompt: Schema.String }),
  name: "summarize",
  run: ({ prompt }) => Agent.generate({ prompt, schema: Summary }),
  success: Agent.GenerateResult(Summary),
});

const execute = <A>(
  agent: Layer.Layer<Agent.Service>,
  body: Effect.Effect<
    A,
    typeof Agent.Failure.Type,
    WorkflowEngine | WorkflowInstance | Agent.Service
  >,
  success: Schema.Codec<A, unknown>
) =>
  Effect.gen(function* executeAgentTest() {
    const workflow = Workflow.make("AgentTest", {
      error: Agent.Failure,
      idempotencyKey: () => "test",
      payload: {},
      success,
    });
    const engine = yield* WorkflowEngine;
    yield* engine.register(workflow, () => body);
    return yield* workflow.execute({});
  }).pipe(Effect.scoped, Effect.provide([layerMemory, agent]));
const layerFor = (spec: Agent.Spec) =>
  Agent.make(spec).pipe(Layer.provide(BunServices.layer));
const run = <A>(...args: Parameters<typeof execute<A>>) =>
  Effect.runPromise(execute(...args));
const fail = <A>(...args: Parameters<typeof execute<A>>) =>
  Effect.runPromise(execute(...args).pipe(Effect.flip));
const argsFor = async (spec: Agent.Spec) => {
  await run(
    layerFor(spec),
    ask({ prompt: "hi" }, { key: "access" }),
    Agent.RunResult
  );
  return calls().at(-1)?.args ?? [];
};

test("runs Claude from its spec with the prompt on stdin and records provenance", async () => {
  const agent = layerFor(
    Claude.make({
      addDirs: ["/tmp/shared"],
      effort: "high",
      executable: claudeReply(),
      model: "claude-haiku-5-5",
    })
  );
  const prompt = "Explain --this; $(echo nope)";
  const result = await run(
    agent,
    ask({ prompt }, { key: "explain" }),
    Agent.RunResult
  );
  expect(result).toMatchObject({
    access: "read-only",
    effort: "high",
    models: ["claude-haiku-5-5"],
    output: "done",
    provider: "claude",
    requestedModel: "claude-haiku-5-5",
    sessionId: "session-1",
    totalCostUsd: 0.01,
  });
  expect(calls()).toEqual([
    {
      args: [
        "--print",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--model",
        "claude-haiku-5-5",
        "--effort",
        "high",
        "--add-dir",
        "/tmp/shared",
        "--tools",
        "Read,Grep,Glob",
      ],
      env: null,
      schema: null,
      stdin: prompt,
    },
  ]);
});

test("a call can override the spec's model", async () => {
  const agent = layerFor(
    Claude.make({ executable: claudeReply(), model: "claude-haiku-5-5" })
  );
  const result = await run(
    agent,
    ask({ model: "claude-sonnet-5-5", prompt: "hi" }, { key: "override" }),
    Agent.RunResult
  );
  expect(result.requestedModel).toBe("claude-sonnet-5-5");
  expect(calls()[0]?.args).toContain("claude-sonnet-5-5");
});

test("skills and system prompts come from the spec", async () => {
  const args = await argsFor(
    Claude.make({
      appendSystemPrompt: "You are an adversarial reviewer.",
      executable: claudeReply(),
      pluginDirs: ["/plugins/review"],
    })
  );
  expect(args.slice(5)).toEqual([
    "--append-system-prompt",
    "You are an adversarial reviewer.",
    "--plugin-dir",
    "/plugins/review",
    // Read-only access keeps the Skill tool when plugins are loaded.
    "--tools",
    "Read,Grep,Glob,Skill",
  ]);
});

test("maps access levels to Claude tools and Codex sandboxes", async () => {
  const claude = claudeReply();
  const codex = codexReply("ok");
  const none = await argsFor(
    Claude.make({ access: "none", executable: claude })
  );
  expect(none.slice(-2)).toEqual(["--tools", ""]);
  const write = await argsFor(
    Claude.make({ access: "workspace-write", executable: claude })
  );
  expect(write.slice(-2)).toEqual(["--permission-mode", "acceptEdits"]);
  expect(
    await argsFor(
      Codex.make({
        access: "workspace-write",
        effort: "low",
        executable: codex,
      })
    )
  ).toEqual([
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--sandbox",
    "workspace-write",
    "--config",
    'model_reasoning_effort="low"',
    "--output-last-message",
    expect.stringMatching(/message\.txt$/u),
    "-",
  ]);
});

test("a call's access overrides the spec's and is recorded", async () => {
  const claude = layerFor(Claude.make({ executable: claudeReply() }));
  const result = await run(
    claude,
    ask({ access: "workspace-write", prompt: "edit" }, { key: "edit" }),
    Agent.RunResult
  );
  expect(result.access).toBe("workspace-write");
  expect(calls().at(-1)?.args.slice(-2)).toEqual([
    "--permission-mode",
    "acceptEdits",
  ]);
  const codex = layerFor(
    Codex.make({ access: "workspace-write", executable: codexReply("ok") })
  );
  const readOnly = await run(
    codex,
    ask({ access: "read-only", prompt: "look" }, { key: "look" }),
    Agent.RunResult
  );
  expect(readOnly.access).toBe("read-only");
  expect(calls().at(-1)?.args).toContain("read-only");
  const error = await fail(
    codex,
    ask({ access: "none", prompt: "nothing" }, { key: "none" }),
    Agent.RunResult
  );
  expect(error).toMatchObject({ reason: "invalid-input" });
});

test("reads Codex's final message from its output file, not stdout", async () => {
  const result = await run(
    layerFor(Codex.make({ executable: codexReply("final answer") })),
    ask({ prompt: "hi" }, { key: "codex" }),
    Agent.RunResult
  );
  expect(result).toMatchObject({
    models: [],
    output: "final answer",
    provider: "codex",
    sessionId: null,
  });
});

test("invalid specs throw where they are made", () => {
  expect(() =>
    // @ts-expect-error -- Codex has no tool-less mode.
    Codex.make({ access: "none" })
  ).toThrow();
  expect(() => Claude.make({ model: "--json" })).toThrow();
  expect(() => Claude.make({ apiKeyEnv: "NOT-A-NAME" })).toThrow();
});

test("forwards an API key from a named environment variable", async () => {
  const agent = layerFor(
    Claude.make({
      apiKeyEnv: "EFFECTORY_AGENT_TEST_KEY",
      executable: claudeReply(),
    })
  );
  process.env.EFFECTORY_AGENT_TEST_KEY = "sk-test";
  try {
    await run(agent, ask({ prompt: "hi" }, { key: "auth" }), Agent.RunResult);
  } finally {
    delete process.env.EFFECTORY_AGENT_TEST_KEY;
  }
  expect(calls()[0]?.env).toBe("sk-test");
  const error = await fail(
    agent,
    ask({ prompt: "hi" }, { key: "missing" }),
    Agent.RunResult
  );
  expect(error).toMatchObject({ _tag: "AgentError", reason: "auth" });
  expect(calls()).toHaveLength(1);
});

test("an agent-reported error fails instead of recording an answer", async () => {
  const error = await fail(
    layerFor(
      Claude.make({
        executable: claudeReply({
          is_error: true,
          result: "overloaded",
          subtype: "error_during_execution",
        }),
      })
    ),
    ask({ prompt: "hi" }, { key: "error" }),
    Agent.RunResult
  );
  expect(error).toMatchObject({ _tag: "AgentError", reason: "agent-failed" });
});

test("a nonzero exit surfaces as a process error", async () => {
  const error = await fail(
    layerFor(
      Claude.make({
        executable: fake(
          "claude",
          "console.error('bad auth'); process.exitCode = 1;"
        ),
      })
    ),
    ask({ prompt: "hi" }, { key: "exit" }),
    Agent.RunResult
  );
  expect(error).toMatchObject({
    _tag: "ProcessError",
    reason: "non-zero-exit",
    stderr: "bad auth\n",
  });
});

test("generates through Claude's schema channel and decodes the value", async () => {
  const result = await run(
    layerFor(
      Claude.make({
        executable: claudeReply({
          structured_output: { risk: "low", title: "Rename" },
        }),
      })
    ),
    summarize({ prompt: "Summarize" }, { key: "summary" }),
    Agent.GenerateResult(Summary)
  );
  expect(result.value).toEqual({ risk: "low", title: "Rename" });
  expect(calls()[0]?.schema).toEqual({
    additionalProperties: false,
    properties: {
      risk: { enum: ["low", "high"], type: "string" },
      title: { type: "string" },
    },
    required: ["risk", "title"],
    type: "object",
  });
});

test("generates through Codex's output schema file", async () => {
  const result = await run(
    layerFor(
      Codex.make({ executable: codexReply('{"risk":"high","title":"Drop"}') })
    ),
    summarize({ prompt: "Summarize" }, { key: "summary" }),
    Agent.GenerateResult(Summary)
  );
  expect(result.value).toEqual({ risk: "high", title: "Drop" });
  expect(calls()[0]?.schema).toMatchObject({ additionalProperties: false });
});

test("structured output that misses the schema is invalid output", async () => {
  const errors = await Promise.all(
    [
      { structured_output: { risk: "medium" } },
      { result: '{"risk":"low","title":"x"}' },
    ].map((fields, index) =>
      fail(
        layerFor(
          Claude.make({ executable: claudeReply(fields, `claude-${index}`) })
        ),
        summarize({ prompt: "Summarize" }, { key: "wrong" }),
        Agent.GenerateResult(Summary)
      )
    )
  );
  for (const error of errors) {
    expect(error).toMatchObject({
      _tag: "AutomationError",
      reason: "invalid-output",
    });
  }
});

test("agent calls only typecheck inside a Task", () => {
  // Calling it in a workflow body would leave InTask unsatisfied: a type error.
  type Requires = Effect.Services<ReturnType<typeof Agent.run>>;
  const requiresTask: [InTask | Agent.Service] extends [Requires]
    ? true
    : false = true;
  expect(requiresTask).toBe(true);
});

// A review behavior built from primitives: one child Task per skill, merged
// and judged by pure code. The agent is a fake layer, so no CLI runs.
const Severity = Schema.Literals(["low", "medium", "high", "critical"]);
const Findings = Schema.Struct({
  findings: Schema.Array(
    Schema.Struct({ description: Schema.String, severity: Severity })
  ),
});
const reviewWith = Task.make({
  error: Agent.Failure,
  input: Schema.Struct({ diff: Schema.String, skill: Schema.String }),
  name: "review-with",
  run: ({ diff, skill }) =>
    Agent.generate({ prompt: `${skill}\n${diff}`, schema: Findings }),
  success: Agent.GenerateResult(Findings),
});
const Review = Schema.Struct({
  findings: Findings.fields.findings,
  verdict: Schema.Literals(["pass", "fail"]),
});
const codeReview = Task.make({
  error: Agent.Failure,
  input: Schema.Struct({
    diff: Schema.String,
    skills: Schema.Array(Schema.String),
  }),
  name: "code-review",
  run: ({ diff, skills }) =>
    Effect.forEach(
      skills,
      (skill) => reviewWith({ diff, skill }, { key: skill }),
      { concurrency: "unbounded" }
    ).pipe(
      Effect.map((reviews) => {
        const findings = reviews.flatMap((review) => review.value.findings);
        const blocking = findings.some(({ severity }) =>
          ["high", "critical"].includes(severity)
        );
        return { findings, verdict: blocking ? "fail" : "pass" } as const;
      })
    ),
  success: Review,
});

const fakeAgent = (respond: (prompt: string) => unknown) => {
  const prompts: string[] = [];
  const provenance = {
    access: "read-only" as const,
    durationMs: 0,
    effort: null,
    models: [],
    provider: "claude" as const,
    requestedModel: null,
    sessionId: null,
    totalCostUsd: null,
  };
  const layer = Layer.succeed(
    Agent.Service,
    Agent.Service.of({
      generate: (input) =>
        Effect.suspend(() => {
          prompts.push(input.prompt);
          return Schema.decodeUnknownEffect(input.schema)(
            respond(input.prompt)
          );
        }).pipe(
          Effect.mapError(
            (cause) =>
              new AutomationError({
                message: String(cause),
                operation: "fake.generate",
                reason: "invalid-output",
              })
          ),
          Effect.map((value) => ({ ...provenance, value }))
        ),
      run: (input) =>
        Effect.sync(() => {
          prompts.push(input.prompt);
          return { ...provenance, output: "ok" };
        }),
      spec: Claude.make(),
    })
  );
  return { layer, prompts };
};

test("a composite review Task composes one child Task per skill over a fake agent", async () => {
  const agent = fakeAgent((prompt) => ({
    findings: prompt.startsWith("security")
      ? [{ description: "SQL injection", severity: "high" }]
      : [{ description: "Long function", severity: "low" }],
  }));
  const input = {
    diff: "+ query(input)",
    skills: ["architecture", "security"],
  };
  const [first, again, second] = await run(
    agent.layer,
    Effect.all([
      codeReview(input, { key: "review-1" }),
      // Same key: the recorded review, not another round of agent calls.
      codeReview(input, { key: "review-1" }),
      // A new round uses a new key; its children don't collide with round 1's.
      codeReview(
        { diff: "+ fixed", skills: ["architecture"] },
        { key: "review-2" }
      ),
    ]),
    Schema.Array(Review)
  );
  expect(first).toEqual({
    findings: [
      { description: "Long function", severity: "low" },
      { description: "SQL injection", severity: "high" },
    ],
    verdict: "fail",
  });
  expect(again).toEqual(first);
  expect(second?.verdict).toBe("pass");
  expect(agent.prompts.toSorted()).toEqual([
    "architecture\n+ fixed",
    "architecture\n+ query(input)",
    "security\n+ query(input)",
  ]);
});
