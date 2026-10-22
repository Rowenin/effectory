import { Process } from "@effectory/activities";
import { AutomationError, Task } from "@effectory/sdk";
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

const task = Task.make({
  error: Schema.Union([Process.ProcessError, AutomationError, ThreadWaitError]),
  input: WaitInput,
  name: "t3.thread.wait",
  run: (input) =>
    Effect.gen(function* waitForRun() {
      for (;;) {
        const detail = yield* showThread(
          {
            ...input,
            maxOutputBytes: input.maxOutputBytes ?? pollOutputBytes,
            messages: recentMessages,
          },
          "t3.thread.wait"
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
  success: WaitResult,
});

/**
 * Poll a thread inside one activity until the run reaches a final status or
 * waits for an answer (`needsInput`). A crash re-executes the polling, which is
 * read-only. `waitTimeoutMs` bounds the whole wait; `timeoutMs` bounds each poll.
 */
export const wait = (
  input: typeof WaitInput.Type,
  invocation: { readonly key: string }
) => task(input, invocation);
