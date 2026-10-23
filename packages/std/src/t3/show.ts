import { Action } from "@effectory/core";
import { Effect, Schema } from "effect";

import { flag, options, positional, positiveInteger, runJson } from "./cli.ts";
import { ThreadDetail } from "./models.ts";

export const ShowInput = Schema.Struct({
  ...options,
  messages: Schema.optionalKey(positiveInteger),
  thread: positional,
});

/** `t3 thread show`, for Actions that poll a thread inside their own run. */
export const showThread = (input: typeof ShowInput.Type, operation: string) =>
  runJson(operation, ThreadDetail, {
    ...input,
    command: "show",
    flags: flag("messages", input.messages),
    positionals: [input.thread],
  });

/** A completed, idle thread with no messages, recorded in fake mode. */
export const fakeDetail = (thread: string): typeof ThreadDetail.Type => ({
  messages: [],
  thread: {
    activeRunId: null,
    branch: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    interactionMode: "default",
    latestRunId: null,
    model: null,
    pendingRequestCount: 0,
    projectId: "fake-project",
    providerInstanceId: null,
    runtimeMode: "fake",
    status: "completed",
    threadId: thread,
    title: "[fake] thread",
    updatedAt: "1970-01-01T00:00:00.000Z",
    worktreePath: null,
  },
});

/** Record a snapshot of a thread and its latest messages. */
export const ThreadShow = Action.make("T3.ThreadShow", {
  description: "Show a T3 Code thread and its latest messages",
  fake: (input) => Effect.succeed(fakeDetail(input.thread)),
  input: ShowInput,
  output: ThreadDetail,
  run: (input) => showThread(input, "T3.ThreadShow"),
});
