import { Task } from "@effectory/sdk";
import { Schema } from "effect";

import {
  ThreadActivityError,
  message,
  options,
  positional,
  runJson,
} from "./cli.ts";

export const SendInput = Schema.Struct({
  ...options,
  message,
  thread: positional,
});

export const SendResult = Schema.Struct({
  delivery: Schema.String,
  messageId: Schema.String,
  // A busy thread queues the message as its next turn, which may not have a run yet.
  runId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.String,
  threadId: Schema.String,
});

const task = Task.make({
  error: ThreadActivityError,
  input: SendInput,
  name: "t3.thread.send",
  run: (input) =>
    runJson("t3.thread.send", SendResult, {
      ...input,
      command: "send",
      flags: [],
      positionals: [input.thread, "-"],
      stdin: input.message,
    }),
  success: SendResult,
});

/**
 * Send a message to a thread without waiting for the reply. A busy thread gets
 * it as its next turn. Each logical message needs a distinct stable key; a
 * crash before the send is recorded can deliver it twice.
 */
export const send = (
  input: typeof SendInput.Type,
  invocation: { readonly key: string }
) => task(input, invocation);
