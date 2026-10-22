import { expect, test } from "bun:test";

import { Thread } from "@effectory/t3";

import { fail, run, useFakeT3 } from "../fake-t3.ts";
import { detail } from "./fixtures.ts";

const { calls, fakeT3, printing } = useFakeT3();

test("records a thread snapshot and ignores fields it does not model", async () => {
  const shown = detail({ status: "completed" });
  const executable = printing({
    ...shown,
    thread: { ...shown.thread, futureField: { nested: true } },
  });
  const result = await run(
    Thread.show(
      { executable, messages: 5, thread: "thread-1" },
      { key: "snapshot" }
    ),
    Thread.ThreadDetail
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
    Thread.show({ executable, thread: "nope" }, { key: "missing" }),
    Thread.ThreadDetail
  );
  expect(error).toMatchObject({ _tag: "ProcessError", exitCode: 1 });
});
