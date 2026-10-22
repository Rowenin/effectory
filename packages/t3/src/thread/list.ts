import { Task } from "@effectory/sdk";
import { Schema } from "effect";

import { ThreadActivityError, flag, options, runJson, text } from "./cli.ts";
import { ThreadSummary } from "./models.ts";

export const ListInput = Schema.Struct({
  ...options,
  // Project id or a path inside its main checkout; defaults to `cwd`.
  project: Schema.optionalKey(text),
});

export const ListResult = Schema.Array(ThreadSummary);

const task = Task.make({
  error: ThreadActivityError,
  input: ListInput,
  name: "t3.thread.list",
  run: (input) =>
    runJson("t3.thread.list", ListResult, {
      ...input,
      command: "list",
      flags: flag("project", input.project),
      positionals: [],
    }),
  success: ListResult,
});

/**
 * Record a project's threads, newest first. Use a new key for each
 * observation; reusing a key replays the first listing.
 */
export const list = (
  input: typeof ListInput.Type,
  invocation: { readonly key: string }
) => task(input, invocation);
