/* Poll persisted outcomes after each preceding read. */
/* eslint-disable no-await-in-loop, unicorn/no-useless-undefined */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Process } from "@effectory/activities";
import { openEngine } from "@effectory/runtime/engine";
import type { RegisteredTask } from "@effectory/runtime/task";
import { Activity, Automation, Effectory, Task } from "@effectory/sdk";
import type { TaskManifest } from "@effectory/sdk/manifest";
import { Effect, Schema } from "effect";

const register = (
  definition: TaskManifest & { readonly name: string }
): RegisteredTask => ({
  ...definition,
  directory: ".",
  entrypoint: import.meta.path,
  fingerprint: { digest: "authoring-v1", files: [] },
  inputSchema: Schema.toJsonSchemaDocument(definition.workflow.payloadSchema),
});
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
const input = Schema.Struct({ requestId: Schema.String });
const defaults = {
  description: "Authoring contract test",
  error: Schema.String,
  idempotencyKey: (value: typeof input.Type) => value.requestId,
  input,
};

test("process Tasks reuse committed commands across approval replay and reopen", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "factory-process-replay-"));
  const output = path.join(workspace, "executions");
  const command = Task.make({
    error: Process.Failure,
    input: Process.Input,
    name: "command",
    run: Process.exec,
    success: Process.Result,
  });
  const definition = Automation.define({
    ...defaults,
    error: Process.Failure,
    execute: () =>
      Effect.gen(function* execute() {
        const first = yield* command(
          {
            args: [
              "--eval",
              `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'first\\n'); console.log('first')`,
            ],
            command: process.execPath,
          },
          { key: "first" }
        );
        const second = yield* command(
          {
            args: [
              "--eval",
              `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'second\\n'); console.log('second')`,
            ],
            command: process.execPath,
          },
          { key: "second" }
        );
        yield* Automation.approve({
          key: "finish",
          review: { first: first.stdout, second: second.stdout },
          title: "Accept process results",
        });
        return first.stdout + second.stdout;
      }),
    name: "process-replay",
    success: Schema.String,
  });
  const tasks = [register(definition)];
  const config = Effectory.make({ services: Process.layer, workflows: [] });
  let engine = await openEngine({ config, tasks, workspace });
  try {
    const run = await engine.submit({
      input: { requestId: "process" },
      requestKey: "process",
      task: definition.name,
    });
    const gates = await until(
      () => engine.listApprovals(),
      (values) => values.length === 1
    );
    const [gate] = gates;
    if (!gate) {
      throw new Error("Missing process approval");
    }
    await until(
      () => engine.inspectRun(run.id),
      (value) => value.status === "suspended"
    );
    await engine.close();
    engine = await openEngine({ config, tasks, workspace });
    await engine.decideApproval({
      digest: gate.digest,
      id: gate.id,
      outcome: "approved",
      revision: gate.revision,
    });
    await engine.resumeRun(run.id);
    const result = await until(
      () => engine.inspectRun(run.id),
      (value) => value.status === "succeeded"
    );
    expect(result.result).toBe("first\nsecond\n");
    expect(await Bun.file(output).text()).toBe("first\nsecond\n");
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("keyed authoring activities and encoded artifacts survive approval replay and reopen", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "effectory-authoring-"));
  let executions = 0;
  const double = Activity.define({
    error: Schema.Never,
    execute: (value) =>
      Effect.sync(() => {
        executions += 1;
        return value * 2;
      }),
    input: Schema.Int,
    name: "double",
    success: Schema.Int,
  });
  const definition = Automation.define({
    ...defaults,
    execute: () =>
      Effect.gen(function* execute() {
        const first = yield* double(2, { key: "first" });
        const second = yield* double(3, { key: "second" });
        yield* Automation.publish("total", {
          schema: Schema.BigInt,
          value: BigInt(first + second),
        });
        const approval = yield* Automation.approve({
          key: "finish",
          review: { total: first + second },
          title: "Accept total",
        });
        expect(approval.outcome).toBe("approved");
        return first + second;
      }),
    name: "typed-replay",
    success: Schema.Int,
  });
  const tasks = [register(definition)];
  let engine = await openEngine({ tasks, workspace });
  try {
    const run = await engine.submit({
      input: { requestId: "one" },
      requestKey: "one",
      task: definition.name,
    });
    const gates = await until(
      () => engine.listApprovals(),
      (values) => values.length === 1
    );
    const [gate] = gates;
    if (!gate) {
      throw new Error("Missing approval");
    }
    await until(
      () => engine.inspectRun(run.id),
      (value) => value.status === "suspended"
    );
    expect(executions).toBe(2);
    const artifacts = await engine.listArtifacts(run.id);
    expect(artifacts.map((artifact) => artifact.value)).toEqual(["10"]);
    await engine.close();
    engine = await openEngine({ tasks, workspace });
    await engine.decideApproval({
      digest: gate.digest,
      id: gate.id,
      outcome: "approved",
      revision: gate.revision,
    });
    await engine.resumeRun(run.id);
    const done = await until(
      () => engine.inspectRun(run.id),
      (value) => value.status === "succeeded"
    );
    expect(done.result).toBe(10);
    expect(done.inspectionError).toBeUndefined();
    expect(executions).toBe(2);
    expect(await engine.listArtifacts(run.id)).toHaveLength(1);
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("activity input, activity output, workflow output and publication validation fail truthfully", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "effectory-authoring-"));
  const positive = Schema.Int.check(Schema.isGreaterThan(0));
  let inputExecutions = 0;
  const activity = Activity.define({
    error: Schema.Never,
    execute: (value) =>
      Effect.sync(() => {
        inputExecutions += 1;
        return value;
      }),
    input: positive,
    name: "positive",
    success: positive,
  });
  const invalidResult = Activity.define({
    error: Schema.Never,
    execute: () => Effect.succeed(-1),
    input: Schema.Void,
    name: "invalid-result",
    success: positive,
  });
  const domainFailure = Activity.define({
    error: Schema.String,
    execute: () => Effect.fail("expected domain failure"),
    input: Schema.Void,
    name: "domain-failure",
    success: positive,
  });
  const definitions = [
    Automation.define({
      ...defaults,
      execute: () => activity(-1),
      name: "invalid-input",
      success: positive,
    }),
    Automation.define({
      ...defaults,
      execute: () => invalidResult(undefined),
      name: "invalid-activity-output",
      success: positive,
    }),
    Automation.define({
      ...defaults,
      execute: () => Effect.succeed(-1),
      name: "invalid-workflow-output",
      success: positive,
    }),
    Automation.define({
      ...defaults,
      execute: () =>
        Automation.publish("invalid", { schema: positive, value: -1 }),
      name: "invalid-publish",
      success: Schema.Void,
    }),
    Automation.define({
      ...defaults,
      execute: () => domainFailure(undefined),
      name: "domain-failure",
      success: positive,
    }),
  ];
  const engine = await openEngine({
    tasks: definitions.map(register),
    workspace,
  });
  try {
    for (const definition of definitions) {
      const run = await engine.submit({
        input: { requestId: definition.name },
        requestKey: definition.name,
        task: definition.name,
      });
      const done = await until(
        () => engine.inspectRun(run.id),
        (value) => value.status === "failed"
      );
      expect(done.inspectionError).toBeUndefined();
      expect(done.error).toBeString();
      if (definition.name === "domain-failure") {
        expect(done.error).toContain("expected domain failure");
      }
    }
    expect(inputExecutions).toBe(0);
    expect(await engine.listArtifacts()).toHaveLength(0);
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("approval rejection fails the authoring workflow before its following action", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "effectory-authoring-"));
  let executed = false;
  const definition = Automation.define({
    ...defaults,
    execute: () =>
      Effect.gen(function* execute() {
        yield* Automation.approve({
          key: "stop",
          review: { action: "write" },
          title: "Review action",
        });
        yield* Effect.sync(() => {
          executed = true;
        });
      }),
    name: "reject-review",
    success: Schema.Void,
  });
  const engine = await openEngine({ tasks: [register(definition)], workspace });
  try {
    const run = await engine.submit({
      input: { requestId: "reject" },
      requestKey: "reject",
      task: definition.name,
    });
    const gates = await until(
      () => engine.listApprovals(),
      (values) => values.length === 1
    );
    const [gate] = gates;
    if (!gate) {
      throw new Error("Missing approval");
    }
    await engine.decideApproval({
      digest: gate.digest,
      id: gate.id,
      outcome: "rejected",
      reason: "Do not publish",
      revision: gate.revision,
    });
    const done = await until(
      () => engine.inspectRun(run.id),
      (value) => value.status === "failed"
    );
    expect(done.error).toContain("Do not publish");
    expect(done.inspectionError).toBeUndefined();
    expect(executed).toBe(false);
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
});
