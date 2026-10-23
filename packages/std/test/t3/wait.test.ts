import { expect, test } from "bun:test";

import * as T3 from "../../src/t3/index.ts";
import { fail, run, useFakeT3 } from "./fake-t3.ts";
import { detail, runId } from "./fixtures.ts";

const { calls, printing } = useFakeT3();
const older = "run:thread:thread-1:ordinal:1";
const newer = "run:thread:thread-1:ordinal:3";
const waitFor = (executable: string, extra: { waitTimeoutMs?: number } = {}) =>
  T3.ThreadWait.definition.run({
    executable,
    pollIntervalMs: 1,
    runId,
    thread: "thread-1",
    ...extra,
  });

test("polls until the run completes and returns its final reply", async () => {
  const executable = printing(
    detail({ status: "starting" }),
    detail({ status: "running" }),
    detail({ status: "completed" }, [
      { role: "assistant", runId: older, text: "earlier answer" },
      { role: "user", runId, text: "question" },
      { role: "assistant", runId, text: "thinking" },
      { role: "assistant", runId, text: "final answer" },
    ])
  );
  const result = await run(waitFor(executable));
  expect(result).toEqual({
    needsInput: false,
    pendingRequestCount: 0,
    reply: "final answer",
    runId,
    status: "completed",
    threadId: "thread-1",
  });
  expect(calls()).toHaveLength(3);
  expect(calls()[0]?.args).toEqual([
    "thread",
    "show",
    "--messages=20",
    "--json",
    "thread-1",
  ]);
});

test("returns early when the run waits for an answer", async () => {
  const executable = printing(
    detail({ pendingRequestCount: 1, status: "waiting" })
  );
  const result = await run(waitFor(executable));
  expect(result).toMatchObject({
    needsInput: true,
    pendingRequestCount: 1,
    status: "waiting",
  });
});

test("keeps polling a waiting run without requests and reports failures as status", async () => {
  const executable = printing(
    detail({ status: "waiting" }),
    detail({ status: "failed" })
  );
  const result = await run(waitFor(executable));
  expect(result).toMatchObject({ reply: null, status: "failed" });
  expect(calls()).toHaveLength(2);
});

test("a run that has not started yet is not mistaken for a finished one", async () => {
  const executable = printing(
    detail({ latestRunId: older, status: "running" }),
    detail({ status: "completed" }, [{ role: "assistant", runId, text: "ok" }])
  );
  const result = await run(waitFor(executable));
  expect(result).toMatchObject({ reply: "ok", status: "completed" });
});

test("a run replaced by a later run settles with an unknown status", async () => {
  const executable = printing(
    detail({ latestRunId: newer, status: "running" }, [
      { role: "assistant", runId, text: "done" },
    ])
  );
  const result = await run(waitFor(executable));
  expect(result).toMatchObject({ reply: "done", status: "unknown" });
});

test("the wait deadline fails with a typed timeout", async () => {
  const executable = printing(detail({ status: "running" }));
  const error = await fail(waitFor(executable, { waitTimeoutMs: 200 }));
  expect(error).toMatchObject({
    _tag: "ThreadWaitError",
    reason: "timeout",
    runId,
    threadId: "thread-1",
  });
});

test("polling is read-only, so a wait keeps the default retry", () => {
  expect(T3.ThreadWait.definition.retry).toBeUndefined();
});
