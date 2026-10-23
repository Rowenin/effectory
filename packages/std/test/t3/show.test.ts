import { expect, test } from "bun:test";

import * as T3 from "../../src/t3/index.ts";
import { fail, run, useFakeT3 } from "./fake-t3.ts";
import { detail } from "./fixtures.ts";

const { calls, fakeT3, printing } = useFakeT3();

test("records a thread snapshot and ignores fields it does not model", async () => {
  const shown = detail({ status: "completed" });
  const executable = printing({
    ...shown,
    thread: { ...shown.thread, futureField: { nested: true } },
  });
  const result = await run(
    T3.ThreadShow.definition.run({
      executable,
      messages: 5,
      thread: "thread-1",
    })
  );
  expect(result).toEqual(shown);
  expect(calls()[0]?.args).toEqual([
    "thread",
    "show",
    "--messages=5",
    "--json",
    "thread-1",
  ]);
});

test("a missing thread fails with the CLI's diagnostic", async () => {
  const executable = fakeT3(
    "console.error('Thread nope is no longer available.'); process.exitCode = 1;"
  );
  const error = await fail(
    T3.ThreadShow.definition.run({ executable, thread: "nope" })
  );
  expect(error).toMatchObject({
    _tag: "ProcessError",
    exitCode: 1,
    message: "Process exited with code 1: Thread nope is no longer available.",
  });
});
