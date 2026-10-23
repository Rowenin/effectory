import { Action } from "@effectory/core";
import { Effect, Schema } from "effect";

import { options, positional, positiveInteger, text } from "./cli.ts";
import type { ThreadDetail } from "./models.ts";
import { showThread } from "./show.ts";

export const WaitInput = Schema.Struct({
  ...options,
  pollIntervalMs: Schema.optionalKey(positiveInteger),
  runId: text,
  thread: positional,
  waitTimeoutMs: Schema.optionalKey(positiveInteger),
});

export const WaitResult = Schema.Struct({
  needsInput: Schema.Boolean,
  pendingRequestCount: Schema.Int,
  reply: Schema.NullOr(Schema.String),
  runId: Schema.String,
  // The run's status, or "unknown" when a later run replaced it before it was observed.
  status: Schema.String,
  threadId: Schema.String,
});

// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError is a schema class factory.
export class ThreadWaitError extends Schema.TaggedError<
  ThreadWaitError,
  { readonly brand: unique symbol }
>()("ThreadWaitError", {
  message: Schema.String,
  reason: Schema.Literals(["timeout"]),
  runId: Schema.String,
  threadId: Schema.String,
}) {}

const unsettled = new Set(["preparing", "queued", "starting", "running"]);
// Enough recent messages to include the run's final reply. Polls are not
// recorded, so their output may exceed the default process limit.
const recentMessages = 20;
const pollOutputBytes = 1024 * 1024;

const settle = (
  { messages, thread }: typeof ThreadDetail.Type,
  runId: string
): typeof WaitResult.Type | undefined => {
  const result = (status: string) => ({
    needsInput: thread.pendingRequestCount > 0,
    pendingRequestCount: thread.pendingRequestCount,
    reply:
      messages.findLast(
        (entry) => entry.runId === runId && entry.role === "assistant"
      )?.text ?? null,
    runId,
    status,
    threadId: thread.threadId,
  });
  if (thread.latestRunId === runId) {
    if (thread.pendingRequestCount > 0) {
      return result(thread.status);
    }
    // "waiting" without a pending request is still in progress.
    return unsettled.has(thread.status) || thread.status === "waiting"
      ? undefined
      : result(thread.status);
  }
  // A later run started. Treat the target as finished only once it was seen.
  return thread.activeRunId !== runId &&
    messages.some((entry) => entry.runId === runId)
    ? result("unknown")
    : undefined;
};

/**
 * Poll a thread until the run reaches a final status or waits for an answer
 * (`needsInput`), and record the outcome with the run's final reply. Polling
 * is read-only, so an interrupted wait simply reruns. `waitTimeoutMs` bounds
 * the whole wait; `timeoutMs` bounds each poll. Fake mode records a completed
 * run without polling.
 */
export const ThreadWait = Action.make("T3.ThreadWait", {
  description: "Wait for a T3 Code thread's run to settle",
  fake: (input) =>
    Effect.succeed({
      needsInput: false,
      pendingRequestCount: 0,
      reply: `[fake t3] reply for ${input.runId}`,
      runId: input.runId,
      status: "completed",
      threadId: input.thread,
    }),
  input: WaitInput,
  output: WaitResult,
  run: (input) =>
    Effect.gen(function* waitForRun() {
      for (;;) {
        const detail = yield* showThread(
          {
            ...input,
            maxOutputBytes: input.maxOutputBytes ?? pollOutputBytes,
            messages: recentMessages,
          },
          "T3.ThreadWait"
        );
        const settled = settle(detail, input.runId);
        if (settled) {
          return settled;
        }
        yield* Effect.sleep(input.pollIntervalMs ?? 2000);
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: input.waitTimeoutMs ?? 30 * 60_000,
        orElse: () =>
          Effect.fail(
            new ThreadWaitError({
              message: `Run ${input.runId} did not settle in time`,
              reason: "timeout",
              runId: input.runId,
              threadId: input.thread,
            })
          ),
      })
    ),
});
