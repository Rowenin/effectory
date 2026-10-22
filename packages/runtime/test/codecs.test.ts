/* Poll phase barriers sequentially. */
/* eslint-disable no-await-in-loop, unicorn/no-await-expression-member */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { openEngine } from "@effectory/runtime/engine";
import type { LocalEngine } from "@effectory/runtime/engine";
import type { RegisteredTask } from "@effectory/runtime/task";
import { Effect, Schema } from "effect";
import * as Workflow from "effect/workflow/Workflow";

import { TestStore as RuntimeStore } from "./store-fixture.ts";

const task = <S extends Schema.Top>(
  name: string,
  success: S,
  value: S["Type"] = undefined
): RegisteredTask => {
  const workflow = Workflow.make(`Codec/${name}`, {
    idempotencyKey: () => name,
    payload: {},
    success,
  });
  return {
    description: name,
    directory: ".",
    entrypoint: import.meta.path,
    fingerprint: { digest: "codecs-v1", files: [] },
    implementation: workflow.toLayer(() => Effect.succeed(value)),
    inputSchema: Schema.toJsonSchemaDocument(workflow.payloadSchema),
    name,
    workflow,
  };
};
const waitRun = async (engine: LocalEngine, id: string) => {
  const deadline = Date.now() + 10_000;
  while (true) {
    const run = await engine.inspectRun(id);
    if (run.status === "succeeded" || run.inspectionError) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${JSON.stringify(run)}`);
    }
    await Bun.sleep(50);
  }
};

test("native SQLite results use success JSON codecs and survive reopen", async () => {
  const workspace = mkdtempSync(nodePath.join(tmpdir(), "effectory-codecs-"));
  const tasks = [
    task("bigint", Schema.BigInt, 42n),
    task("date", Schema.Date, new Date("2026-01-02T03:04:05.000Z")),
    task("void", Schema.Void),
    task("transform", Schema.FiniteFromString, 123),
    task("other", Schema.String, "ok"),
  ];
  // Omitting success is the native default Void contract.
  const defaultWorkflow = Workflow.make("Codec/default", {
    idempotencyKey: () => "default",
    payload: {},
  });
  tasks.push({
    ...task("default", Schema.Void),
    implementation: defaultWorkflow.toLayer(() => Effect.void),
    workflow: defaultWorkflow,
  });
  let engine = await openEngine({ tasks, workspace });
  try {
    for (const [name, expected] of [
      ["bigint", "42"],
      ["date", "2026-01-02T03:04:05.000Z"],
      ["void", null],
      ["transform", "123"],
      ["default", null],
    ] as const) {
      const admitted = await engine.submit({
        input: {},
        requestKey: name,
        task: name,
      });
      const run = await waitRun(engine, admitted.id);
      expect(run.status).toBe("succeeded");
      expect(run.result).toEqual(expected);
      expect(run.inspectionError).toBeUndefined();
    }
    expect(await engine.listRuns()).toHaveLength(5);
    await engine.close();
    // Simulate native completion committing before the operational index update.
    const stale = new RuntimeStore(workspace);
    try {
      const bigint = stale.listRuns().find((run) => run.task === "bigint");
      if (!bigint) {
        throw new Error("Missing bigint run");
      }
      delete bigint.result;
      stale.putRun({ ...bigint, status: "running" });
    } finally {
      stale.close();
    }
    engine = await openEngine({ tasks, workspace });
    const runs = await engine.listRuns();
    expect(runs.find((run) => run.task === "bigint")?.result).toBe("42");
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
    const other = await engine.submit({
      input: {},
      requestKey: "other",
      task: "other",
    });
    expect((await waitRun(engine, other.id)).result).toBe("ok");
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
}, 25_000);

test("one unreadable native result leaves startup, list and unrelated runs operational", async () => {
  const workspace = mkdtempSync(
    nodePath.join(tmpdir(), "effectory-bad-codec-")
  );
  const tasks = [
    task("bad", Schema.Unknown, { invalid: Number.NaN }),
    task("good", Schema.String, "ok"),
  ];
  let engine = await openEngine({ tasks, workspace });
  try {
    const bad = await engine.submit({
      input: {},
      requestKey: "bad",
      task: "bad",
    });
    const unreadable = await waitRun(engine, bad.id);
    expect(unreadable.inspectionError).toContain("Native outcome unreadable");
    expect(unreadable.status).not.toBe("failed");
    expect(unreadable.status).not.toBe("succeeded");
    expect(unreadable.error).toBeUndefined();
    await Bun.sleep(500);
    expect((await engine.inspectRun(bad.id)).updatedAt).toBe(
      unreadable.updatedAt
    );
    await engine.close();
    engine = await openEngine({ tasks, workspace });
    expect((await engine.listRuns())[0]?.inspectionError).toContain(
      "inspection retries on engine reopen"
    );
    const good = await engine.submit({
      input: {},
      requestKey: "good",
      task: "good",
    });
    expect((await waitRun(engine, good.id)).result).toBe("ok");
    expect(await engine.listRuns()).toHaveLength(2);
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
}, 25_000);

test("decoded non-JSON inputs remain rejected before admission", async () => {
  const workspace = mkdtempSync(
    nodePath.join(tmpdir(), "effectory-input-codec-")
  );
  const workflow = Workflow.make("Codec/input", {
    idempotencyKey: () => "input",
    payload: { value: Schema.BigInt },
  });
  const inputTask = {
    ...task("input", Schema.Void),
    implementation: workflow.toLayer(() => Effect.void),
    workflow,
  };
  const engine = await openEngine({ tasks: [inputTask], workspace });
  try {
    await expect(
      engine.submit({
        input: { value: 42n },
        requestKey: "input",
        task: "input",
      })
    ).rejects.toThrow("Task input must decode to bounded finite JSON data");
    expect(await engine.listRuns()).toHaveLength(0);
    const store = new RuntimeStore(workspace);
    try {
      expect(store.listRuns()).toHaveLength(0);
    } finally {
      store.close();
    }
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
}, 15_000);

test("bounded wire result errors preserve confirmed native success without losing other history", async () => {
  const workspace = mkdtempSync(
    nodePath.join(tmpdir(), "effectory-result-bound-")
  );
  const tasks = [
    task("large", Schema.String, "x".repeat(256 * 1024)),
    task("small", Schema.String, "ok"),
  ];
  let engine = await openEngine({ tasks, workspace });
  try {
    const large = await engine.submit({
      input: {},
      requestKey: "large",
      task: "large",
    });
    const run = await waitRun(engine, large.id);
    expect(run.status).toBe("succeeded");
    expect(run.inspectionError).toContain(
      "Native workflow succeeded; result encoding failed"
    );
    expect(run.inspectionError).toContain("JSON exceeds 262144 bytes");
    expect(Object.hasOwn(run, "result")).toBe(false);
    expect(run.error).toBeUndefined();
    await engine.close();
    engine = await openEngine({ tasks, workspace });
    expect((await engine.inspectRun(run.id)).inspectionError).toBe(
      run.inspectionError
    );
    const small = await engine.submit({
      input: {},
      requestKey: "small",
      task: "small",
    });
    expect((await waitRun(engine, small.id)).result).toBe("ok");
    expect(await engine.listRuns()).toHaveLength(2);
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
}, 25_000);
