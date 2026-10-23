import { expect, test } from "bun:test";

import * as T3 from "../../src/t3/index.ts";
import { fail, run, useFakeT3 } from "./fake-t3.ts";
import { summary } from "./fixtures.ts";

const { calls, fakeT3, printing } = useFakeT3();

test("lists a project's threads", async () => {
  const threads = [summary({ threadId: "b" }), summary({ threadId: "a" })];
  const executable = printing(threads);
  const result = await run(
    T3.ThreadList.definition.run({ executable, project: "project-1" })
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
  const error = await fail(T3.ThreadList.definition.run({ executable }));
  expect(error).toMatchObject({
    _tag: "T3Error",
    operation: "T3.ThreadList",
    reason: "invalid-output",
  });
});
