import { expect, test } from "bun:test";

import { Thread } from "@effectory/t3";

import { run, useFakeT3 } from "../fake-t3.ts";

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
    Thread.send(
      { executable, message: "--fix it\nplease", thread: "thread-1" },
      { key: "repair-1" }
    ),
    Thread.SendResult
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
    Thread.send(
      { executable, message: "next", thread: "thread-1" },
      { key: "queued" }
    ),
    Thread.SendResult
  );
  expect(result.runId).toBeNull();
});
