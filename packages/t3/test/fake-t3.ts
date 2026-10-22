import { afterEach, beforeEach } from "bun:test";
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
import { Process } from "@effectory/activities";
import { AutomationError } from "@effectory/sdk";
import { Thread } from "@effectory/t3";
import { Effect, Layer, Schema } from "effect";
import * as Workflow from "effect/workflow/Workflow";
import type { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import { WorkflowEngine, layerMemory } from "effect/workflow/WorkflowEngine";

export interface Call {
  readonly args: readonly string[];
  readonly stdin: string;
}

/** Registers a temporary directory per test for a fake `t3` executable and its call log. */
export const useFakeT3 = () => {
  let directory = "";
  let log = "";
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "effectory t3 "));
    log = path.join(directory, "calls.jsonl");
  });
  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  /** The fake records each invocation, then runs `body` with `call` as its zero-based index. */
  const fakeT3 = (body: string) => {
    const executable = path.join(directory, "t3");
    writeFileSync(
      executable,
      `#!${process.execPath}
const { appendFileSync, readFileSync } = await import("node:fs");
const stdin = await Bun.stdin.text();
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), stdin }) + "\\n");
const call = readFileSync(${JSON.stringify(log)}, "utf-8").trim().split("\\n").length - 1;
${body}
`
    );
    chmodSync(executable, 0o755);
    return executable;
  };
  /** A fake that prints one JSON value per call, repeating the last. */
  const printing = (...outputs: readonly unknown[]) =>
    fakeT3(
      `const outputs = ${JSON.stringify(outputs)}; console.log(JSON.stringify(outputs[Math.min(call, outputs.length - 1)]));`
    );
  const calls = (): Call[] =>
    existsSync(log)
      ? readFileSync(log, "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Call)
      : [];
  return { calls, fakeT3, printing };
};

type Failure = Process.ProcessError | AutomationError | Thread.ThreadWaitError;

/** Execute activities inside a fresh in-memory workflow. */
export const execute = <A>(
  body: Effect.Effect<
    A,
    Failure,
    WorkflowEngine | WorkflowInstance | Process.Service
  >,
  success: Schema.Codec<A, unknown>
) =>
  Effect.gen(function* executeThreadTest() {
    const workflow = Workflow.make("T3ThreadTest", {
      error: Schema.Union([
        Process.ProcessError,
        AutomationError,
        Thread.ThreadWaitError,
      ]),
      idempotencyKey: () => "test",
      payload: {},
      success,
    });
    const engine = yield* WorkflowEngine;
    yield* engine.register(workflow, () => body);
    return yield* workflow.execute({});
  }).pipe(
    Effect.scoped,
    Effect.provide([
      layerMemory,
      BunServices.layer,
      Process.layer.pipe(Layer.provide(BunServices.layer)),
    ])
  );

export const run = <A>(...args: Parameters<typeof execute<A>>) =>
  Effect.runPromise(execute(...args));
export const fail = <A>(...args: Parameters<typeof execute<A>>) =>
  Effect.runPromise(execute(...args).pipe(Effect.flip));
