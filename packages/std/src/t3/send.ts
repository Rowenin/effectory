import { Action } from "@effectory/core";
import { Effect, Schema } from "effect";

import { message, options, positional, runJson } from "./cli.ts";

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

/**
 * Send a message to a thread without waiting for the reply. A busy thread gets
 * it as its next turn. `retry: "never"`: an interrupted send may have been
 * delivered, so resuming asks for approval instead of sending it twice.
 */
export const ThreadSend = Action.make("T3.ThreadSend", {
  description: "Send a message to a T3 Code thread",
  fake: (input) =>
    Effect.succeed({
      delivery: "fake",
      messageId: "fake-message",
      runId: "fake-run",
      status: "fake",
      threadId: input.thread,
    }),
  input: SendInput,
  output: SendResult,
  retry: "never",
  run: (input) =>
    runJson("T3.ThreadSend", SendResult, {
      ...input,
      command: "send",
      flags: [],
      positionals: [input.thread, "-"],
      stdin: input.message,
    }),
});
