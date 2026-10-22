import { Task } from "@effectory/sdk";
import { Schema } from "effect";

import {
  ThreadActivityError,
  flag,
  options,
  positional,
  positiveInteger,
  runJson,
} from "./cli.ts";
import { ThreadDetail } from "./models.ts";

export const ShowInput = Schema.Struct({
  ...options,
  messages: Schema.optionalKey(positiveInteger),
  thread: positional,
});

/** `t3 thread show` for activities that poll a thread inside their own boundary. */
export const showThread = (input: typeof ShowInput.Type, operation: string) =>
  runJson(operation, ThreadDetail, {
    ...input,
    command: "show",
    flags: flag("messages", input.messages),
    positionals: [input.thread],
  });

const task = Task.make({
  error: ThreadActivityError,
  input: ShowInput,
  name: "t3.thread.show",
  run: (input) => showThread(input, "t3.thread.show"),
  success: ThreadDetail,
});

/**
 * Record a snapshot of a thread and its latest messages. Use a new key for each
 * observation; reusing a key replays the first snapshot.
 */
export const show = (
  input: typeof ShowInput.Type,
  invocation: { readonly key: string }
) => task(input, invocation);
