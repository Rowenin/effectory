import { Action } from "@effectory/core";
import { Effect, Schema } from "effect";

import { flag, options, runJson, text } from "./cli.ts";
import { ThreadSummary } from "./models.ts";

export const ListInput = Schema.Struct({
  ...options,
  // Project id or a path inside its main checkout; defaults to `cwd`.
  project: Schema.optionalKey(text),
});

export const ListResult = Schema.Array(ThreadSummary);

/** Record a project's threads, newest first. Fake mode records an empty list. */
export const ThreadList = Action.make("T3.ThreadList", {
  description: "List a T3 Code project's threads",
  fake: () => Effect.succeed([]),
  input: ListInput,
  output: ListResult,
  run: (input) =>
    runJson("T3.ThreadList", ListResult, {
      ...input,
      command: "list",
      flags: flag("project", input.project),
      positionals: [],
    }),
});
