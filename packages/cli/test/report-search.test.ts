import { expect, test } from "bun:test";

import { Cause, Effect, Exit, Option } from "effect";

import {
  searchContinuation,
  searchPreflight,
  searchRequest,
} from "../src/report-search.ts";

test("search preflight refuses old daemons and filter decoding preserves the typed error channel", async () => {
  let sent = false;
  const result = await Effect.runPromiseExit(
    searchPreflight({
      SystemStatus: () => Effect.succeed({ capabilities: ["reports.v1"] }),
    }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          sent = true;
        })
      )
    )
  );
  expect(sent).toBe(false);
  if (!Exit.isFailure(result)) {
    throw new Error("Expected capability refusal");
  }
  expect(Option.getOrNull(Cause.findErrorOption(result.cause))).toMatchObject({
    code: "Unavailable",
  });
  const bad = await Effect.runPromiseExit(searchRequest({ limit: 0 }, []));
  if (!Exit.isFailure(bad)) {
    throw new Error("Expected invalid input");
  }
  expect(Option.getOrNull(Cause.findErrorOption(bad.cause))).toMatchObject({
    code: "InvalidInput",
  });
});

test("continuation quotes shell and terminal controls while preserving the complete filter set", async () => {
  const request = {
    history: true,
    limit: 1,
    query: "-x'$(echo wrong)\n\u001B[2J",
    reporterId: "a'b",
    statuses: ["Failed" as const, "Cancelled" as const],
    tags: { "team.name/key": "x'$()" },
  };
  const line = searchContinuation(request, "cursor", "/tmp/a b");
  expect(line).not.toContain("\u001B");
  expect(line).not.toContain("\n");
  const command = line.replace(/^effectory /u, "printf '%s\\0' ");
  const child = Bun.spawn(["/bin/zsh", "-c", command], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(stdout.split("\0")).toEqual([
    "--repository",
    "/tmp/a b",
    "report",
    "search",
    "--reporter",
    "a'b",
    "--status",
    "Failed",
    "--status",
    "Cancelled",
    "--tag",
    "team.name/key=x'$()",
    "--history",
    "--limit",
    "1",
    "--cursor",
    "cursor",
    "--",
    request.query,
    "",
  ]);
});

test("source-workflow requires the new capability and survives continuation", async () => {
  const client = {
    SystemStatus: () => Effect.succeed({ capabilities: ["reports.search.v1"] }),
  };
  expect(
    Exit.isSuccess(await Effect.runPromiseExit(searchPreflight(client)))
  ).toBe(true);
  const result = await Effect.runPromiseExit(searchPreflight(client, true));
  expect(Exit.isFailure(result)).toBe(true);
  expect(
    searchContinuation(
      { sourceWorkflowId: "child", workflowId: "parent" },
      "cursor",
      "/repo"
    )
  ).toContain("--source-workflow $'child'");
});
