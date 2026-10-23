import { expect, test } from "bun:test";

import * as T3 from "../../src/t3/index.ts";
import { processLayer, runAction } from "../harness.ts";
import { fail, run, useFakeT3 } from "./fake-t3.ts";

const { calls, fakeT3, printing } = useFakeT3();
const launched = {
  projectId: "project-1",
  runId: "run:thread:thread-1:ordinal:1",
  threadId: "thread-1",
};
const start = T3.ThreadStart.definition.run;

test("starts a thread with literal flags and the message on stdin", async () => {
  const executable = printing(launched);
  const message = "Review --this; $(echo nope)\nsecond line";
  const result = await run(
    start({
      baseDir: "/tmp/t3 home",
      executable,
      message,
      model: "claude-haiku-5-5",
      project: "7990cd94",
      provider: "claudeAgent",
      title: "[effectory] review",
      worktree: { baseRef: "main", branch: "effectory/review" },
    })
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
  await run(start({ executable, message: "hi", project: "." }));
  expect(calls()[0]?.args).toEqual(["thread", "start", "--json", ".", "-"]);
});

test("a start runs once as a recorded node and is never retried after an interruption", async () => {
  expect(T3.ThreadStart.definition.retry).toBe("never");
  const executable = printing(launched);
  const { records, summary } = await runAction(
    T3.ThreadStart,
    { executable, message: "hi", project: "." },
    { services: processLayer }
  );
  expect(summary.run.result).toEqual(launched);
  expect(records.map((record) => [record.kind, record.value])).toEqual([
    ["T3.ThreadStart", launched],
  ]);
  expect(calls()).toHaveLength(1);
});

test("fake mode records a launch without running the CLI", async () => {
  const executable = printing(launched);
  const { summary } = await runAction(
    T3.ThreadStart,
    { executable, message: "hi", project: "project-1" },
    { mode: "fake", services: processLayer }
  );
  expect(summary.run.result).toEqual({
    projectId: "project-1",
    runId: "fake-run",
    threadId: "fake-thread",
  });
  expect(calls()).toEqual([]);
});

test("a failing CLI surfaces its process error", async () => {
  const executable = fakeT3(
    "console.error('No T3 Code project matches'); process.exitCode = 1;"
  );
  const error = await fail(
    start({ executable, message: "hi", project: "missing" })
  );
  expect(error).toMatchObject({
    _tag: "ProcessError",
    reason: "non-zero-exit",
    stderr: expect.stringContaining("No T3 Code project matches"),
  });
});

test("unexpected output fails as invalid output instead of a launch", async () => {
  const executable = fakeT3(
    "console.log('USAGE\\n  t3 thread start [flags]');"
  );
  const error = await fail(start({ executable, message: "hi", project: "." }));
  expect(error).toMatchObject({
    _tag: "T3Error",
    operation: "T3.ThreadStart",
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
      runAction(T3.ThreadStart, input, { services: processLayer }).then(
        () => null,
        (error: unknown) => error
      )
    )
  );
  for (const error of errors) {
    expect(error).toMatchObject({ _tag: "RunError", reason: "invalid-input" });
  }
  expect(calls()).toEqual([]);
});
