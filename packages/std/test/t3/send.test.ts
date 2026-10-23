import { expect, test } from "bun:test";

import * as T3 from "../../src/t3/index.ts";
import { run, useFakeT3 } from "./fake-t3.ts";

const { calls, printing } = useFakeT3();

test("sends the message on stdin and decodes delivery", async () => {
  const sent = {
    delivery: "started",
    messageId: "message-1",
    runId: "run:thread:thread-1:ordinal:2",
    status: "starting",
    threadId: "thread-1",
  };
  const executable = printing(sent);
  const result = await run(
    T3.ThreadSend.definition.run({
      executable,
      message: "--fix it\nplease",
      thread: "thread-1",
    })
  );
  expect(result).toEqual(sent);
  expect(calls()).toEqual([
    {
      args: ["thread", "send", "--json", "thread-1", "-"],
      stdin: "--fix it\nplease",
    },
  ]);
});

test("a queued message without a run decodes", async () => {
  const executable = printing({
    delivery: "queued",
    messageId: "message-2",
    runId: null,
    status: "running",
    threadId: "thread-1",
  });
  const result = await run(
    T3.ThreadSend.definition.run({
      executable,
      message: "next",
      thread: "thread-1",
    })
  );
  expect(result.runId).toBeNull();
});

test("a send is never retried after an interruption", () => {
  expect(T3.ThreadSend.definition.retry).toBe("never");
});
