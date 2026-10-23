/**
 * `Shell` runs one command and records `{ exitCode, stdout, stderr,
 * durationMs }`. A nonzero exit is data: the workflow decides what it means
 * (e.g. with an `Assert` on `exitCode`). Spawn failures, timeouts, and output
 * overflow still fail the node.
 *
 * Record size: `maxOutputBytes` (default 64 KiB across stdout and stderr)
 * fails the node when exceeded. For chatty commands such as test runners, raise
 * it and set `tailChars` to record only the end of each stream, where failures
 * usually are.
 */
import { Action } from "@effectory/core";
import { Effect, Schema } from "effect";

import * as Process from "./process.ts";

const { fields } = Process.Input;

export const ShellInput = Schema.Struct({
  args: fields.args,
  command: fields.command,
  cwd: fields.cwd,
  env: fields.env,
  maxOutputBytes: fields.maxOutputBytes,
  stdin: fields.stdin,
  /** Record only the last `tailChars` characters of stdout and of stderr. */
  tailChars: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  timeoutMs: fields.timeoutMs,
});

export const ShellResult = Process.Result;

const tail = (text: string, chars: number | undefined) =>
  chars === undefined || text.length <= chars ? text : text.slice(-chars);

const action = Action.make("Shell", {
  description:
    "Run a command with literal arguments and record its exit code, output, and duration",
  input: ShellInput,
  output: ShellResult,
  run: ({ tailChars, ...input }) =>
    Process.exec({ ...input, allowNonZeroExit: true }).pipe(
      Effect.map((result) => ({
        ...result,
        stderr: tail(result.stderr, tailChars),
        stdout: tail(result.stdout, tailChars),
      }))
    ),
});

/**
 * Run a command with literal arguments (no shell parsing) and record its
 * result. `Shell.Input` and `Shell.Result` are its schemas.
 *
 * ```ts
 * const test = yield* Shell("test", { cwd, command: "bun", args: ["test"] });
 * yield* Assert("passes", { that: Output.map(test, (r) => r.exitCode === 0) });
 * ```
 */
export const Shell = Object.assign(action, {
  Input: ShellInput,
  Result: ShellResult,
});
