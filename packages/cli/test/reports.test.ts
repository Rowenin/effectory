import { expect, test } from "bun:test";

import { Cause, Effect, Exit, Option } from "effect";

import {
  aggregateExit,
  reportExit,
  reportsPreflight,
  safeMarkdown,
} from "../src/reports.ts";

test("report exit codes distinguish pending work, operator attention, cancellation and exclusions", () => {
  expect(
    (["WaitingSource", "Queued", "Running", "NeedsAttention"] as const).map(
      reportExit
    )
  ).toEqual([4, 4, 4, 4]);
  expect(reportExit("Succeeded")).toBe(0);
  expect(reportExit("NotApplicable")).toBe(0);
  expect(reportExit("Failed")).toBe(1);
  expect(reportExit("Cancelled")).toBe(1);
  const counts = {
    Cancelled: 1,
    Failed: 1,
    NeedsAttention: 1,
    NotApplicable: 0,
    Queued: 0,
    Running: 0,
    Succeeded: 1,
    WaitingSource: 0,
    observedAt: "now",
    sourceTerminal: true,
    total: 4,
  };
  expect(aggregateExit(counts)).toBe(4);
  expect(aggregateExit({ ...counts, NeedsAttention: 0 })).toBe(1);
  expect(
    aggregateExit({ ...counts, Cancelled: 0, Failed: 0, NeedsAttention: 0 })
  ).toBe(0);
});

test("report terminal rendering preserves document layout but escapes control and bidi characters", () => {
  expect(safeMarkdown("# Title\n\tline\u001B[2J\u202E\u0085\uD800")).toBe(
    "# Title\n\tline\\u001b[2J\\u202e\\u0085\\ud800"
  );
  expect(safeMarkdown("markdown 😀 `code`\n")).toBe("markdown 😀 `code`\n");
});

test("report capability preflight refuses an old daemon before the operation runs", async () => {
  let sent = false;
  const result = await Effect.runPromiseExit(
    reportsPreflight({
      SystemStatus: () => Effect.succeed({ capabilities: [] }),
    }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          sent = true;
        })
      )
    )
  );
  expect(sent).toBe(false);
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) {
    expect(Option.getOrNull(Cause.findErrorOption(result.cause))).toMatchObject(
      { code: "Unavailable" }
    );
  }
});
