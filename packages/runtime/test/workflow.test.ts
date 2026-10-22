/* Poll persisted outcomes after each preceding read. */
/* eslint-disable no-await-in-loop */
import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openEngine } from "@effectory/runtime/engine";
import type { RegisteredTask } from "@effectory/runtime/task";
import { Expr, Task, Workflow } from "@effectory/sdk";
import { Effect, Schema } from "effect";

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

const setup = () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "effectory-plan-"));
  const log = path.join(workspace, "calls");
  const recorded = <A>(label: string, value: A) =>
    Effect.sync(() => {
      appendFileSync(log, `${label}\n`);
      return value;
    });
  const measure = Task.make({
    error: Schema.Never,
    input: Schema.Struct({ text: Schema.String }),
    name: "measure",
    run: ({ text }) => recorded(`measure ${text}`, text.length),
    success: Schema.Finite,
  });
  const score = Task.make({
    error: Schema.Never,
    input: Schema.Struct({ lens: Schema.String, size: Schema.Finite }),
    name: "score",
    run: ({ lens, size }) =>
      recorded(`score ${lens}`, lens === "strict" ? size * 2 : size),
    success: Schema.Finite,
  });
  const definition = Workflow.make("plan-test", {
    description: "Declarative plan test",
    input: Schema.Struct({ requestId: Schema.String, text: Schema.String }),
    key: ($) => $.input.requestId,
  }).pipe(
    Workflow.step("size", measure, ($) => ({ text: $.input.text })),
    Workflow.each("scores", ["lenient", "strict"], score, ($, lens) => ({
      lens,
      size: $.steps.size,
    })),
    Workflow.compute(
      "total",
      (args: { readonly scores: readonly number[] }) =>
        args.scores.reduce((sum, value) => sum + value, 0),
      ($) => ({ scores: $.steps.scores })
    ),
    Workflow.publish("total", Schema.Finite, ($) => $.steps.total),
    Workflow.approve("large", {
      review: ($) => ({ total: $.steps.total }),
      title: "Large total; continue?",
      when: ($) => Expr.not(Expr.eq($.steps.size, 0)),
    }),
    Workflow.step("after", measure, () => ({ text: "approved" })),
    Workflow.returns(
      Schema.Struct({ after: Schema.Finite, total: Schema.Finite }),
      ($) => ({ after: $.steps.after, total: $.steps.total })
    )
  );
  const registered: RegisteredTask = {
    ...definition,
    directory: ".",
    entrypoint: import.meta.path,
    fingerprint: { digest: "plan-v1", files: [] },
    inputSchema: Schema.toJsonSchemaDocument(definition.workflow.payloadSchema),
  };
  return { definition, log, tasks: [registered], workspace };
};

test("a plan lists its Tasks by step name", () => {
  const { definition, workspace } = setup();
  rmSync(workspace, { force: true, recursive: true });
  expect(
    Workflow.tasks(definition.plan).map(({ step, task }) => [
      step,
      task.taskName,
    ])
  ).toEqual([
    ["size", "measure"],
    ["scores", "score"],
    ["after", "measure"],
  ]);
});

test("a plan runs its steps once each across an approval and an engine reopen", async () => {
  const { definition, log, tasks, workspace } = setup();
  let engine = await openEngine({ tasks, workspace });
  try {
    const run = await engine.submit({
      input: { requestId: "plan", text: "hello" },
      requestKey: "plan",
      task: definition.name,
    });
    const [gate] = await until(
      () => engine.listApprovals(),
      (values) => values.length === 1
    );
    if (!gate) {
      throw new Error("Missing approval");
    }
    expect(gate.review).toEqual({ total: 15 });
    await until(
      () => engine.inspectRun(run.id),
      (value) => value.status === "suspended"
    );
    await engine.close();
    engine = await openEngine({ tasks, workspace });
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
    expect(result.result).toEqual({ after: 8, total: 15 });
    // The plan body replayed after the reopen; each Task ran exactly once.
    expect(readFileSync(log, "utf-8").trim().split("\n").toSorted()).toEqual([
      "measure approved",
      "measure hello",
      "score lenient",
      "score strict",
    ]);
    const artifacts = await engine.listArtifacts(run.id);
    expect(artifacts.map(({ name, value }) => [name, value])).toEqual([
      ["total", 15],
    ]);
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("an approval whose condition is false is skipped", async () => {
  const { definition, tasks, workspace } = setup();
  const engine = await openEngine({ tasks, workspace });
  try {
    const run = await engine.submit({
      input: { requestId: "empty", text: "" },
      requestKey: "empty",
      task: definition.name,
    });
    const result = await until(
      () => engine.inspectRun(run.id),
      (value) => value.status === "succeeded" || value.status === "failed"
    );
    expect(result.result).toEqual({ after: 8, total: 0 });
    expect(await engine.listApprovals()).toEqual([]);
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("a called workflow runs inside the parent run under the call's name", async () => {
  const { definition: child, log, workspace } = setup();
  const parent = Workflow.make("plan-parent", {
    description: "Calls the plan test twice",
    input: Schema.Struct({ requestId: Schema.String }),
    key: ($) => $.input.requestId,
  }).pipe(
    Workflow.call("first", child, ($) => ({
      requestId: $.input.requestId,
      text: "hi",
    })),
    Workflow.call("second", child, ($) => ({
      requestId: $.input.requestId,
      text: "hey",
    })),
    Workflow.returns(
      Schema.Struct({ first: Schema.Finite, second: Schema.Finite }),
      ($) => ({ first: $.steps.first.total, second: $.steps.second.total })
    )
  );
  expect(Workflow.tasks(parent.plan).map(({ step }) => step)).toEqual([
    "first/size",
    "first/scores",
    "first/after",
    "second/size",
    "second/scores",
    "second/after",
  ]);
  const tasks: RegisteredTask[] = [
    {
      ...parent,
      directory: ".",
      entrypoint: import.meta.path,
      fingerprint: { digest: "parent-v1", files: [] },
      inputSchema: Schema.toJsonSchemaDocument(parent.workflow.payloadSchema),
    },
  ];
  let engine = await openEngine({ tasks, workspace });
  try {
    const run = await engine.submit({
      input: { requestId: "parent" },
      requestKey: "parent",
      task: parent.name,
    });
    const approveNext = async (key: string) => {
      const [gate] = await until(
        () => engine.listApprovals(),
        (values) => values.some((value) => value.status === "pending")
      ).then((values) => values.filter((value) => value.status === "pending"));
      if (!gate) {
        throw new Error("Missing approval");
      }
      expect(gate.key).toEndWith(key);
      await until(
        () => engine.inspectRun(run.id),
        (value) => value.status === "suspended"
      );
      await engine.decideApproval({
        digest: gate.digest,
        id: gate.id,
        outcome: "approved",
        revision: gate.revision,
      });
      await engine.resumeRun(run.id);
    };
    await approveNext("first/large");
    // Reopen between the calls: the first call replays from its records.
    await engine.close();
    engine = await openEngine({ tasks, workspace });
    await approveNext("second/large");
    const result = await until(
      () => engine.inspectRun(run.id),
      (value) => value.status === "succeeded" || value.status === "failed"
    );
    expect(result.result).toEqual({ first: 6, second: 9 });
    expect(readFileSync(log, "utf-8").trim().split("\n").toSorted()).toEqual([
      "measure approved",
      "measure approved",
      "measure hey",
      "measure hi",
      "score lenient",
      "score lenient",
      "score strict",
      "score strict",
    ]);
    const artifacts = await engine.listArtifacts(run.id);
    expect(artifacts.map(({ name, value }) => [name, value])).toEqual([
      ["first/total", 6],
      ["second/total", 9],
    ]);
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
});
