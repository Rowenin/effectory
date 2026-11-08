import { expect, test } from "bun:test";

import type { RunWatchFrame } from "@effectory/runtime/history-protocol";
import type { Schema } from "effect";

import { formatProgress } from "../src/progress-format.ts";

const at = "2026-11-05T16:00:00.000Z";
const event = (
  tag: string,
  payload: Schema.Json = null
): typeof RunWatchFrame.Type => ({
  _tag: "Event",
  event: { at, payload, runId: "run", sequence: 7, tag },
});

test("human event labels use only recorded fields for every supported lifecycle tag", () => {
  const cases: readonly [string, Schema.Json, string][] = [
    ["RunAccepted", { revision: "hidden" }, "RunAccepted"],
    ["RunStatus", { status: "Succeeded" }, "RunStatus Succeeded"],
    [
      "AttemptStarted",
      { attempt: 2, nodeId: '["fetch"]' },
      'AttemptStarted node=["fetch"] attempt=2',
    ],
    [
      "Log",
      { level: "Info", message: { ok: true }, nodeId: "fetch" },
      'Log Info node=fetch {"ok":true}',
    ],
    [
      "Log",
      {
        error: { message: "failed" },
        level: "Error",
        message: "bad",
        nodeId: "fetch",
      },
      'Log Error node=fetch "bad" error={"message":"failed"}',
    ],
    [
      "Log",
      { error: "fatal", level: "Fatal", message: null },
      'Log Fatal null error="fatal"',
    ],
    [
      "Log",
      { error: "hidden", level: "Info", message: "good" },
      'Log Info "good"',
    ],
    [
      "Progress",
      { completed: 2, message: "Copying", nodeId: "copy", total: 3 },
      "Progress node=copy Copying completed=2 total=3",
    ],
    [
      "WaitOpened",
      { nodeId: "gate", waitId: "wait" },
      "WaitOpened wait=wait node=gate",
    ],
    [
      "WaitSettled",
      { status: "Approved", waitId: "wait" },
      "WaitSettled wait=wait Approved",
    ],
    [
      "ArtifactPublished",
      { artifactId: "artifact", sequence: 900, version: 3 },
      "ArtifactPublished artifact=artifact version=3",
    ],
    [
      "RetryScheduled",
      { attempt: 3, deadline: Date.parse(at), nodeId: "fetch" },
      `RetryScheduled node=fetch nextAttempt=3 deadline=${at}`,
    ],
    [
      "NeedsAttention",
      { nodeId: "task" },
      "NeedsAttention node=task — assess run recover run",
    ],
    [
      "CancellationRequested",
      { actor: "owner", reason: "stop" },
      "CancellationRequested actor=owner reason=stop",
    ],
    [
      "FinalizationStalled",
      { message: "cleanup" },
      "FinalizationStalled cleanup",
    ],
    ["DeadlineStarted", { name: "timeout" }, "DeadlineStarted timeout"],
    [
      "TelemetryTruncated",
      { message: "unused" },
      "TelemetryTruncated stored telemetry was truncated",
    ],
    ["FutureEvent", { private: "not dumped" }, "FutureEvent"],
  ];
  for (const [tag, payload, expected] of cases) {
    expect(formatProgress(event(tag, payload))).toBe(`#7 ${at} ${expected}`);
  }
});

test("malformed display fields fall back independently and non-object payloads stay generic", () => {
  expect(
    formatProgress(
      event("Progress", {
        completed: null,
        message: "still visible",
        nodeId: "task",
        total: "bad",
      })
    )
  ).toBe(`#7 ${at} Progress node=task still visible`);
  expect(
    formatProgress(
      event("Progress", { completed: 2, message: {}, nodeId: 9, total: 4 })
    )
  ).toBe(`#7 ${at} Progress completed=2 total=4`);
  expect(
    formatProgress(
      event("Progress", {
        completed: Number.POSITIVE_INFINITY,
        message: "visible",
        total: Number.NaN,
      })
    )
  ).toBe(`#7 ${at} Progress visible`);
  expect(
    formatProgress(event("RetryScheduled", { attempt: 2, deadline: 1e30 }))
  ).toBe(`#7 ${at} RetryScheduled nextAttempt=2`);
  for (const payload of [null, [], "bad", 42]) {
    expect(formatProgress(event("Progress", payload))).toBe(
      `#7 ${at} Progress`
    );
  }
});

test("snapshots label current state and heartbeats remain quiet", () => {
  expect(
    formatProgress({
      _tag: "Snapshot",
      run: {
        acceptedAt: at,
        kind: "workflow",
        lastSequence: 9,
        revision: "revision",
        runId: "run",
        status: "Waiting",
        tags: {},
        targetId: "release",
      },
    })
  ).toBe("Run run — workflow release — snapshot Waiting at #9");
  expect(
    formatProgress({ _tag: "Heartbeat", at, lastSequence: 9, runId: "run" })
  ).toBeUndefined();
});

test("every printed string is escaped after JSON formatting, including tags, paths and snapshot ids", () => {
  const unsafe = "\u001B\r\n\u007F\u009B\u202E\u2028\u2029\uFEFF\u200D\uD800";
  const line =
    formatProgress(event(`Future${unsafe}`, { message: unsafe })) ?? "";
  expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u);
  expect(line).toContain("\\u001b\\u000d\\u000a\\u007f\\u009b\\u202e");
  const log =
    formatProgress(
      event("Log", {
        error: unsafe,
        level: "Error",
        message: unsafe,
        nodeId: unsafe,
      })
    ) ?? "";
  expect(log).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u);
  expect(log).toContain("\\u202e");
  expect(log).toContain("\\u200d");
  const snapshot =
    formatProgress({
      _tag: "Snapshot",
      run: {
        acceptedAt: at,
        kind: "task",
        lastSequence: 1,
        revision: "revision",
        runId: unsafe,
        status: "Running",
        tags: {},
        targetId: unsafe,
      },
    }) ?? "";
  expect(snapshot).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u);
  expect(snapshot.isWellFormed()).toBe(true);
});

test("long lines stay bounded without splitting Unicode code points or escape tokens", () => {
  const prefix = `#7 ${at} `;
  const exact = formatProgress(event("x".repeat(2048 - prefix.length))) ?? "";
  expect([...exact]).toHaveLength(2048);
  expect(exact).not.toContain("[truncated]");
  const long = formatProgress(event("😀".repeat(4000))) ?? "";
  expect([...long]).toHaveLength(2048);
  expect(long.endsWith("… [truncated]")).toBe(true);
  expect(long.isWellFormed()).toBe(true);
  for (const token of ["\u202E", "\\u202e", "\\n", "\u{E0001}"]) {
    const output = formatProgress(event(token.repeat(4000))) ?? "";
    expect([...output].length).toBeLessThanOrEqual(2048);
    expect(output).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u);
    const content = output.slice(prefix.length, -"… [truncated]".length);
    expect(content).toMatch(/^(?:\\u(?:[\da-f]{4}|\{[\da-f]+\})|\\n)*$/u);
  }
});
