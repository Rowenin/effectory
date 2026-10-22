import { expect, test } from "bun:test";

import { Thread } from "@effectory/t3";
import { Effect, Schema } from "effect";

import { fail, run, useFakeT3 } from "../fake-t3.ts";

const { calls, fakeT3, printing } = useFakeT3();
const launched = {
  projectId: "project-1",
  runId: "run:thread:thread-1:ordinal:1",
  threadId: "thread-1",
};

test("starts a thread with literal flags and the message on stdin", async () => {
  const executable = printing(launched);
  const message = "Review --this; $(echo nope)\nsecond line";
  const result = await run(
    Thread.start(
      {
        baseDir: "/tmp/t3 home",
        executable,
        message,
        model: "claude-haiku-5-5",
        project: "7990cd94",
        provider: "claudeAgent",
        title: "[effectory] review",
        worktree: { baseRef: "main", branch: "effectory/review" },
      },
      { key: "review" }
    ),
    Thread.StartResult
  );
  expect(result).toEqual(launched);
  expect(calls()).toEqual([
    {
      args: [
        "thread",
        "start",
        "--base-dir=/tmp/t3 home",
        "--title=[effectory] review",
        "--provider=claudeAgent",
        "--model=claude-haiku-5-5",
        "--worktree=main",
        "--branch=effectory/review",
        "--json",
        "7990cd94",
        "-",
      ],
      stdin: message,
    },
  ]);
});

test("omits optional flags", async () => {
  const executable = printing(launched);
  await run(
    Thread.start({ executable, message: "hi", project: "." }, { key: "min" }),
    Thread.StartResult
  );
  expect(calls()[0]?.args).toEqual(["thread", "start", "--json", ".", "-"]);
});

test("keyed starts launch once per key within an execution", async () => {
  const executable = printing(launched);
  const input = { executable, message: "hi", project: "." };
  await run(
    Effect.all([
      Thread.start(input, { key: "a" }),
      Thread.start(input, { key: "a" }),
      Thread.start(input, { key: "b" }),
    ]),
    Schema.Array(Thread.StartResult)
  );
  expect(calls()).toHaveLength(2);
});

test("a failing CLI surfaces its process error", async () => {
  const executable = fakeT3(
    "console.error('No T3 Code project matches'); process.exitCode = 1;"
  );
  const error = await fail(
    Thread.start(
      { executable, message: "hi", project: "missing" },
      { key: "fail" }
    ),
    Thread.StartResult
  );
  expect(error).toMatchObject({
    _tag: "ProcessError",
    reason: "non-zero-exit",
  });
  if (error._tag === "ProcessError") {
    expect(error.stderr).toContain("No T3 Code project matches");
  }
});

test("unexpected output fails as invalid output instead of a launch", async () => {
  const executable = fakeT3(
    "console.log('USAGE\\n  t3 thread start [flags]');"
  );
  const error = await fail(
    Thread.start({ executable, message: "hi", project: "." }, { key: "help" }),
    Thread.StartResult
  );
  expect(error).toMatchObject({
    _tag: "AutomationError",
    operation: "t3.thread.start",
    reason: "invalid-output",
  });
});

test("invalid input is refused before the CLI runs", async () => {
  const executable = printing(launched);
  const errors = await Promise.all(
    [
      { executable, message: "hi", project: "--json" },
      { executable, message: "", project: "." },
      { executable, message: "hi", project: ".", provider: "claudeAgent" },
    ].map((input) =>
      fail(Thread.start(input, { key: "invalid" }), Thread.StartResult)
    )
  );
  for (const error of errors) {
    expect(error).toMatchObject({
      _tag: "AutomationError",
      reason: "invalid-input",
    });
  }
  expect(calls()).toEqual([]);
});
