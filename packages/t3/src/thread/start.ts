import { Task } from "@effectory/sdk";
import { Schema } from "effect";

import {
  ThreadActivityError,
  flag,
  message,
  options,
  positional,
  runJson,
  text,
} from "./cli.ts";

export const StartInput = Schema.Struct({
  ...options,
  message,
  model: Schema.optionalKey(text),
  project: positional,
  provider: Schema.optionalKey(text),
  title: Schema.optionalKey(text),
  worktree: Schema.optionalKey(
    Schema.Struct({ baseRef: text, branch: Schema.optionalKey(text) })
  ),
}).check(
  Schema.makeFilter(
    (input) => input.provider === undefined || input.model !== undefined,
    { expected: "a model when a provider is selected" }
  )
);

export const StartResult = Schema.Struct({
  projectId: Schema.String,
  runId: Schema.String,
  threadId: Schema.String,
});

const task = Task.make({
  error: ThreadActivityError,
  input: StartInput,
  name: "t3.thread.start",
  run: (input) =>
    runJson("t3.thread.start", StartResult, {
      ...input,
      command: "start",
      flags: [
        ...flag("title", input.title),
        ...flag("provider", input.provider),
        ...flag("model", input.model),
        ...flag("worktree", input.worktree?.baseRef),
        ...flag("branch", input.worktree?.branch),
      ],
      // The message is read from stdin so prompt text never reaches argument parsing.
      positionals: [input.project, "-"],
      stdin: input.message,
    }),
  success: StartResult,
});

/**
 * Start a T3 Code thread without waiting for its run. Each logical thread needs
 * a distinct stable key; a crash before the launch is recorded can start a
 * duplicate thread.
 */
export const start = (
  input: typeof StartInput.Type,
  invocation: { readonly key: string }
) => task(input, invocation);
