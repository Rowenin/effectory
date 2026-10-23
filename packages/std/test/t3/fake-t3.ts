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

import { Effect } from "effect";

import type * as Process from "../../src/process.ts";
import { processLayer } from "../harness.ts";

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

/** Run an Action's `run` directly over the Process service, keeping typed errors. */
export const run = <A, E>(effect: Effect.Effect<A, E, Process.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(processLayer)));
export const fail = <A, E>(effect: Effect.Effect<A, E, Process.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(processLayer), Effect.flip));
