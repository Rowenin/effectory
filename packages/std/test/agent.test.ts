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
import { Engine, Output, State, Workflow } from "@effectory/core";
import { Effect, Layer, Schema } from "effect";

import * as Agent from "../src/agent/index.ts";
import { Claude, Codex } from "../src/agent/index.ts";
import { runAction } from "./harness.ts";

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

// Calls over the Agent service, as an Action's `run` makes them.
const ask = (input: Agent.RunInput) => Agent.run(input);
const summarize = ({ prompt }: { readonly prompt: string }) =>
  Agent.generate({ prompt, schema: Summary });

const execute = <A>(
  agent: Layer.Layer<Agent.Service>,
  body: Effect.Effect<A, Agent.Failure, Agent.Service>
) => body.pipe(Effect.provide(agent));
const layerFor = (spec: Agent.Spec) =>
  Agent.make(spec).pipe(Layer.provide(BunServices.layer));
const run = <A>(...args: Parameters<typeof execute<A>>) =>
  Effect.runPromise(execute(...args));
const fail = <A>(...args: Parameters<typeof execute<A>>) =>
  Effect.runPromise(execute(...args).pipe(Effect.flip));
const argsFor = async (spec: Agent.Spec) => {
  await run(layerFor(spec), ask({ prompt: "hi" }));
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
  const result = await run(agent, ask({ prompt }));
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
    ask({ model: "claude-sonnet-5-5", prompt: "hi" })
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
    ask({ access: "workspace-write", prompt: "edit" })
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
    ask({ access: "read-only", prompt: "look" })
  );
  expect(readOnly.access).toBe("read-only");
  expect(calls().at(-1)?.args).toContain("read-only");
  const error = await fail(codex, ask({ access: "none", prompt: "nothing" }));
  expect(error).toMatchObject({ reason: "invalid-input" });
});

test("reads Codex's final message from its output file, not stdout", async () => {
  const result = await run(
    layerFor(Codex.make({ executable: codexReply("final answer") })),
    ask({ prompt: "hi" })
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
    await run(agent, ask({ prompt: "hi" }));
  } finally {
    delete process.env.EFFECTORY_AGENT_TEST_KEY;
  }
  expect(calls()[0]?.env).toBe("sk-test");
  const error = await fail(agent, ask({ prompt: "hi" }));
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
    ask({ prompt: "hi" })
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
    ask({ prompt: "hi" })
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
    summarize({ prompt: "Summarize" })
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
    summarize({ prompt: "Summarize" })
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
        summarize({ prompt: "Summarize" })
      )
    )
  );
  for (const error of errors) {
    expect(error).toMatchObject({
      _tag: "AgentError",
      reason: "invalid-output",
    });
  }
});

test("Agent.Prompt records the answer with provenance", async () => {
  const { records, summary } = await runAction(
    Agent.Prompt,
    { model: "claude-sonnet-5-5", prompt: "Explain" },
    { services: layerFor(Claude.make({ executable: claudeReply() })) }
  );
  expect(summary.run.status).toBe("succeeded");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    fqn: "Agent.Prompt/run",
    kind: "Agent.Prompt",
    value: {
      access: "read-only",
      output: "done",
      provider: "claude",
      requestedModel: "claude-sonnet-5-5",
      sessionId: "session-1",
    },
  });
  expect(calls()).toHaveLength(1);
});

test("Agent.Prompt keeps the default retry and refuses invalid input", async () => {
  expect(Agent.Prompt.definition.retry).toBeUndefined();
  await expect(
    runAction(
      Agent.Prompt,
      { prompt: "" },
      { services: layerFor(Claude.make({ executable: claudeReply() })) }
    )
  ).rejects.toMatchObject({ reason: "invalid-input" });
  expect(calls()).toEqual([]);
});

test("Agent.Prompt in fake mode records a deterministic answer without running the CLI", async () => {
  const { records, summary } = await runAction(
    Agent.Prompt,
    { effort: "low", prompt: "Summarize the diff\nwith details" },
    {
      mode: "fake",
      services: layerFor(
        Codex.make({ executable: codexReply("real"), model: "gpt-5" })
      ),
    }
  );
  expect(summary.run.status).toBe("succeeded");
  expect(summary.run.mode).toBe("fake");
  expect(records[0]?.value).toEqual({
    access: "read-only",
    durationMs: 0,
    effort: "low",
    models: [],
    output: "[fake agent] Summarize the diff",
    provider: "codex",
    requestedModel: "gpt-5",
    sessionId: null,
    totalCostUsd: null,
  });
  expect(calls()).toEqual([]);
});

test("Agent.structured records a schema-enforced value", async () => {
  const Summarize = Agent.structured("Summarize", Summary);
  const { records } = await runAction(
    Summarize,
    { prompt: "Summarize" },
    {
      services: layerFor(
        Claude.make({
          executable: claudeReply({
            structured_output: { risk: "low", title: "Rename" },
          }),
        })
      ),
    }
  );
  expect(records[0]).toMatchObject({
    kind: "Summarize",
    value: { provider: "claude", value: { risk: "low", title: "Rename" } },
  });
  expect(calls()[0]?.schema).toMatchObject({ additionalProperties: false });
});

test("Agent.structured fakes a value from options, or fails without one", async () => {
  const services = layerFor(Claude.make({ executable: claudeReply() }));
  const withFake = Agent.structured("Summarize", Summary, {
    fake: ({ prompt }) => ({ risk: "low" as const, title: `fake: ${prompt}` }),
  });
  const faked = await runAction(
    withFake,
    { prompt: "Summarize" },
    { mode: "fake", services }
  );
  expect(faked.summary.run.result).toMatchObject({
    value: { risk: "low", title: "fake: Summarize" },
  });
  const constant = await runAction(
    Agent.structured("Summarize", Summary, {
      fake: { risk: "high", title: "constant" },
    }),
    { prompt: "Summarize" },
    { mode: "fake", services }
  );
  expect(constant.summary.run.result).toMatchObject({
    value: { risk: "high", title: "constant" },
  });
  const missing = await runAction(
    Agent.structured("Summarize", Summary),
    { prompt: "Summarize" },
    { mode: "fake", services }
  );
  expect(missing.summary.run.status).toBe("failed");
  expect(missing.node?.error?.tag).toBe("MissingFake");
  expect(calls()).toEqual([]);
});

// A review built from primitives: one structured Action per skill, merged and
// judged by pure code. The agent is a fake layer, so no CLI runs.
const Severity = Schema.Literals(["low", "medium", "high", "critical"]);
const Findings = Schema.Struct({
  findings: Schema.Array(
    Schema.Struct({ description: Schema.String, severity: Severity })
  ),
});
const ReviewWith = Agent.structured("ReviewWith", Findings);
const codeReview = Workflow.make(
  "code-review",
  {
    description: "Review a diff once per skill",
    input: Schema.Struct({
      diff: Schema.String,
      skills: Schema.Array(Schema.String),
    }),
  },
  Effect.fn(function* codeReviewBody({ diff, skills }) {
    const reviews = yield* Effect.forEach(skills, (skill) =>
      ReviewWith(skill, { prompt: `${skill}\n${diff}` })
    );
    return Output.map(Output.all(reviews), (results) => {
      const findings = results.flatMap((review) => review.value.findings);
      const blocking = findings.some(({ severity }) =>
        ["high", "critical"].includes(severity)
      );
      return { findings, verdict: blocking ? "fail" : "pass" };
    });
  })
);

test("a review workflow composes one structured Action per skill over a fake agent", async () => {
  const prompts: string[] = [];
  const agent = Agent.fake(({ prompt }) => {
    prompts.push(prompt);
    return {
      findings: prompt.startsWith("security")
        ? [{ description: "SQL injection", severity: "high" }]
        : [{ description: "Long function", severity: "low" }],
    };
  });
  const layer = Engine.layer.pipe(
    Layer.provideMerge(State.memory),
    Layer.merge(agent)
  );
  const summary = await Effect.runPromise(
    Effect.flatMap(Engine.Engine, (engine) =>
      engine.run(
        codeReview,
        { diff: "+ query(input)", skills: ["architecture", "security"] },
        { collection: "std-test", revision: "r1" }
      )
    ).pipe(Effect.provide(layer))
  );
  expect(summary.run.result).toEqual({
    findings: [
      { description: "Long function", severity: "low" },
      { description: "SQL injection", severity: "high" },
    ],
    verdict: "fail",
  });
  expect(prompts.toSorted()).toEqual([
    "architecture\n+ query(input)",
    "security\n+ query(input)",
  ]);
});
