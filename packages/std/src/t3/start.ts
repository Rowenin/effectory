import { Action } from "@effectory/core";
import { Effect, Schema } from "effect";

import { flag, message, options, positional, runJson, text } from "./cli.ts";

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

/**
 * Start a T3 Code thread without waiting for its run. `retry: "never"`: an
 * interrupted start may have launched a thread, so resuming asks for approval
 * instead of starting a duplicate.
 */
export const ThreadStart = Action.make("T3.ThreadStart", {
  description: "Start a T3 Code thread",
  fake: (input) =>
    Effect.succeed({
      projectId: input.project,
      runId: "fake-run",
      threadId: "fake-thread",
    }),
  input: StartInput,
  output: StartResult,
  retry: "never",
  run: (input) =>
    runJson("T3.ThreadStart", StartResult, {
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
});
