/* Poll persisted outcomes after each preceding read. */
/* eslint-disable no-await-in-loop */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Agent, Claude, Process } from "@effectory/activities";
import { openEngine } from "@effectory/runtime/engine";
import type { RegisteredTask } from "@effectory/runtime/task";
import { AutomationError, Effectory } from "@effectory/sdk";
import { Effect, Layer, Schema } from "effect";

import implementWorkflow from "../../../.effectory/automations/implement/index.ts";
import planImplement from "../../../.effectory/automations/plan-implement/index.ts";

const until = async <A>(
  read: () => Promise<A>,
  ready: (value: A) => boolean
) => {
  const deadline = Date.now() + 10_000;
  while (true) {
    const value = await read();
    if (ready(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${JSON.stringify(value)}`);
    }
    await Bun.sleep(30);
  }
};

const provenance = {
  access: "read-only" as const,
  durationMs: 1,
  effort: null,
  models: [],
  provider: "claude" as const,
  requestedModel: null,
  sessionId: null,
  totalCostUsd: null,
};

const plan = (summary: string) => ({
  deletions: ["old"],
  risks: [],
  steps: ["edit"],
  summary,
});

/**
 * Fake services: the reviewer approves on `approveOnRound`; lint fails for
 * the first `lintFailures` implementation attempts.
 */
const setup = (
  definition: typeof planImplement | typeof implementWorkflow,
  { approveOnRound = 0, lintFailures = 0 } = {}
) => {
  const calls: string[] = [];
  let round = 0;
  let revision = 0;
  let attempt = 0;
  const respond = (prompt: string): unknown => {
    if (prompt.startsWith("You are reviewing")) {
      round += 1;
      calls.push(`review ${round}`);
      return round === approveOnRound
        ? { issues: [], verdict: "approve" }
        : { issues: [`issue ${round}`], verdict: "revise" };
    }
    if (prompt.startsWith("Revise")) {
      revision += 1;
      calls.push(`revise ${revision}`);
      return plan(`v${revision + 1}`);
    }
    calls.push("draft");
    return plan("v1");
  };
  const agent = Layer.succeed(
    Agent.Service,
    Agent.Service.of({
      generate: (input) =>
        Schema.decodeUnknownEffect(input.schema)(respond(input.prompt)).pipe(
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
          attempt += 1;
          const fixing = input.prompt.includes("lint error");
          calls.push(
            `implement ${attempt}${fixing ? " fixing lint" : ""} ${input.access}`
          );
          return { ...provenance, output: `attempt ${attempt}` };
        }),
      spec: Claude.make(),
    })
  );
  const process = Layer.succeed(
    Process.Service,
    Process.Service.of({
      exec: (input) => {
        const command = [input.command, ...(input.args ?? [])].join(" ");
        calls.push(command);
        return command === "bun run check" && attempt <= lintFailures
          ? Effect.fail(
              new Process.ProcessError({
                exitCode: 1,
                message: "lint failed",
                reason: "non-zero-exit",
                stderr: "lint error",
                stdout: "",
              })
            )
          : Effect.succeed({
              durationMs: 1,
              exitCode: 0,
              stderr: "",
              stdout: "ok",
            });
      },
    })
  );
  const workspace = mkdtempSync(path.join(tmpdir(), "effectory-plan-impl-"));
  const task: RegisteredTask = {
    ...definition,
    directory: ".",
    entrypoint: import.meta.path,
    fingerprint: { digest: `${definition.name}-v1`, files: [] },
    inputSchema: Schema.toJsonSchemaDocument(definition.workflow.payloadSchema),
  };
  const config = Effectory.make({
    services: Layer.mergeAll(agent, process),
  });
  return { calls, config, definition, task, workspace };
};

const start = async (...args: Parameters<typeof setup>) => {
  const { calls, config, definition, task, workspace } = setup(...args);
  const engine = await openEngine({ config, tasks: [task], workspace });
  const run = await engine.submit({
    input: { repo: workspace, request: "add a flag", requestId: "r" },
    requestKey: "r",
    task: definition.name,
  });
  return { calls, engine, run, workspace };
};

type Engine = Awaited<ReturnType<typeof start>>["engine"];

const gate = async (engine: Engine, key: string) => {
  const [pending] = await until(
    () => engine.listApprovals(),
    (values) =>
      values.some(
        (value) => value.status === "pending" && value.key.endsWith(key)
      )
  ).then((values) => values.filter((value) => value.status === "pending"));
  if (!pending) {
    throw new Error(`Missing approval ${key}`);
  }
  return pending;
};

const approve = async (
  engine: Engine,
  runId: string,
  pending: Awaited<ReturnType<typeof gate>>
) => {
  await engine.decideApproval({
    digest: pending.digest,
    id: pending.id,
    outcome: "approved",
    revision: pending.revision,
  });
  await engine.resumeRun(runId);
};

const finished = (engine: Engine, runId: string) =>
  until(
    () => engine.inspectRun(runId),
    (value) => value.status === "succeeded" || value.status === "failed"
  );

test("plan review stops after three rounds, waits for approval, then fixes failing checks", async () => {
  const { calls, engine, run, workspace } = await start(planImplement, {
    lintFailures: 1,
  });
  try {
    const planGate = await gate(engine, "approve-plan");
    expect(planGate.review).toMatchObject({
      approved: false,
      plan: { summary: "v3" },
      reviews: [
        { verdict: "revise" },
        { verdict: "revise" },
        { verdict: "revise" },
      ],
    });
    expect(calls).toEqual([
      "draft",
      "review 1",
      "revise 1",
      "review 2",
      "revise 2",
      "review 3",
    ]);
    await approve(engine, run.id, planGate);
    const result = await finished(engine, run.id);
    expect(result.status).toBe("succeeded");
    expect(result.result).toMatchObject({
      implementation: {
        attempts: [
          {
            checks: [
              { passed: true, script: "install" },
              { passed: true, script: "test" },
              { output: "lint error", passed: false, script: "check" },
            ],
            summary: "attempt 1",
          },
          { summary: "attempt 2" },
        ],
        passed: true,
      },
    });
    const after = calls.slice(6);
    expect(after.slice(0, 3)).toEqual([
      "git rm -r --quiet -- old",
      "implement 1 workspace-write",
      "bun install",
    ]);
    expect(after.slice(3, 5).toSorted()).toEqual([
      "bun run check",
      "bun run test",
    ]);
    expect(after.slice(5, 7)).toEqual([
      "implement 2 fixing lint workspace-write",
      "bun install",
    ]);
    expect(after.slice(7).toSorted()).toEqual([
      "bun run check",
      "bun run test",
    ]);
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("an approving review ends the review loop early", async () => {
  const { calls, engine, workspace } = await start(planImplement, {
    approveOnRound: 1,
  });
  try {
    const planGate = await gate(engine, "approve-plan");
    expect(planGate.review).toMatchObject({
      approved: true,
      plan: { summary: "v1" },
      reviews: [{ verdict: "approve" }],
    });
    expect(calls).toEqual(["draft", "review 1"]);
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("implementation that never passes its checks waits for approval", async () => {
  const { calls, engine, run, workspace } = await start(implementWorkflow, {
    lintFailures: 99,
  });
  try {
    const failing = await gate(engine, "accept-failing-checks");
    expect(failing.review).toMatchObject({
      attempts: [{}, {}, {}],
      passed: false,
    });
    expect(calls.filter((call) => call.startsWith("implement"))).toEqual([
      "implement 1 workspace-write",
      "implement 2 fixing lint workspace-write",
      "implement 3 fixing lint workspace-write",
    ]);
    await approve(engine, run.id, failing);
    const result = await finished(engine, run.id);
    expect(result.status).toBe("succeeded");
    expect(result.result).toMatchObject({ passed: false });
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
});
