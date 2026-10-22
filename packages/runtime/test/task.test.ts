/* Poll persisted outcomes after each preceding read. */
/* eslint-disable no-await-in-loop */
import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openEngine } from "@effectory/runtime/engine";
import type { LocalEngine } from "@effectory/runtime/engine";
import type { RegisteredTask } from "@effectory/runtime/task";
import { Automation, Task } from "@effectory/sdk";
import type { TaskManifest } from "@effectory/sdk/manifest";
import { Effect, Schema } from "effect";

const register = (
  definition: TaskManifest & { readonly name: string }
): RegisteredTask => ({
  ...definition,
  directory: ".",
  entrypoint: import.meta.path,
  fingerprint: { digest: "task-v1", files: [] },
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

test("a parent Task replays finished children after it suspends and the engine reopens", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "effectory-task-nesting-"));
  const log = path.join(workspace, "calls");
  const record = Task.make({
    error: Schema.Never,
    input: Schema.Struct({ label: Schema.String }),
    name: "record",
    run: ({ label }) =>
      Effect.sync(() => {
        appendFileSync(log, `${label}\n`);
        return label;
      }),
    success: Schema.String,
  });
  const pair = Task.make({
    error: Schema.Never,
    input: Schema.Struct({ round: Schema.String }),
    name: "pair",
    run: ({ round }) =>
      Effect.gen(function* runPair() {
        // The same child key in two parents must not collide.
        const first = yield* record({ label: `${round}-a` }, { key: "a" });
        yield* Automation.approve({
          key: `continue-${round}`,
          review: { first },
          title: `Continue ${round}`,
        });
        const second = yield* record({ label: `${round}-b` }, { key: "b" });
        return `${first}+${second}`;
      }),
    success: Schema.String,
  });
  const definition = Automation.define({
    description: "Nested task test",
    error: Schema.Never,
    execute: () =>
      Effect.gen(function* execute() {
        const one = yield* pair({ round: "one" }, { key: "one" });
        const two = yield* pair({ round: "two" }, { key: "two" });
        return `${one} ${two}`;
      }),
    idempotencyKey: (value) => value.requestId,
    input: Schema.Struct({ requestId: Schema.String }),
    name: "task-nesting",
    success: Schema.String,
  });
  const tasks = [register(definition)];
  let engine = await openEngine({ tasks, workspace });
  try {
    const run = await engine.submit({
      input: { requestId: "nesting" },
      requestKey: "nesting",
      task: definition.name,
    });
    // Approve each round's gate after a full engine reopen.
    const reopenAndApprove = async (current: LocalEngine, round: string) => {
      const key = `continue-${round}`;
      const approvals = await until(
        () => current.listApprovals(),
        (values) => values.some((value) => value.key === key)
      );
      const gate = approvals.find((value) => value.key === key);
      if (!gate) {
        throw new Error(`Missing approval for ${round}`);
      }
      await until(
        () => current.inspectRun(run.id),
        (value) => value.status === "suspended"
      );
      await current.close();
      const reopened = await openEngine({ tasks, workspace });
      await reopened.decideApproval({
        digest: gate.digest,
        id: gate.id,
        outcome: "approved",
        revision: gate.revision,
      });
      await reopened.resumeRun(run.id);
      return reopened;
    };
    engine = await reopenAndApprove(engine, "one");
    engine = await reopenAndApprove(engine, "two");
    const result = await until(
      () => engine.inspectRun(run.id),
      (value) => value.status === "succeeded"
    );
    expect(result.result).toBe("one-a+one-b two-a+two-b");
    // Each child ran once even though its parent's body re-ran on resume.
    expect(readFileSync(log, "utf-8")).toBe("one-a\none-b\ntwo-a\ntwo-b\n");
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
});
