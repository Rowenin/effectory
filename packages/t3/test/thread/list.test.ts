import { expect, test } from "bun:test";

import { Thread } from "@effectory/t3";

import { fail, run, useFakeT3 } from "../fake-t3.ts";
import { summary } from "./fixtures.ts";

const { calls, fakeT3, printing } = useFakeT3();

test("lists a project's threads", async () => {
  const threads = [summary({ threadId: "b" }), summary({ threadId: "a" })];
  const executable = printing(threads);
  const result = await run(
    Thread.list({ executable, project: "project-1" }, { key: "threads" }),
    Thread.ListResult
  );
  expect(result).toEqual(threads);
  expect(calls()[0]?.args).toEqual([
    "thread",
    "list",
    "--project=project-1",
    "--json",
  ]);
});

test("an unmatched project is invalid output, not an empty list", async () => {
  // The CLI exits 0 with a message when no project matches.
  const executable = fakeT3(
    "console.log(\"No T3 Code project matches '.'. Pass a project id or a path inside a project.\");"
  );
  const error = await fail(
    Thread.list({ executable }, { key: "unmatched" }),
    Thread.ListResult
  );
  expect(error).toMatchObject({
    _tag: "AutomationError",
    operation: "t3.thread.list",
    reason: "invalid-output",
  });
});
