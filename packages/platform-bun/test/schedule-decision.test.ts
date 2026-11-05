import { expect, test } from "bun:test";

import { Cron } from "effect";

import { dueSlots, eligibility } from "../src/schedule-decision.ts";

const instant = (text: string) => Date.parse(text);
test("exact-now slots count once, forward gaps are bounded, rollback never replays", () => {
  const cron = Cron.parseUnsafe("* * * * *", "UTC");
  const start = instant("2026-01-01T00:00:00Z");
  expect(dueSlots(cron, start, start + 60_000)).toMatchObject({
    count: 1,
    first: start + 60_000,
    latest: start + 60_000,
    previous: start + 60_000,
    saturated: false,
  });
  expect(dueSlots(cron, start, start)).toBeNull();
  expect(dueSlots(cron, start, start - 1)).toBeNull();
  expect(dueSlots(cron, start, start + 60_000 * 20_000)).toMatchObject({
    count: 10_000,
    latest: start + 60_000 * 20_000,
    saturated: true,
  });
  expect(eligibility(start + 60_000, start, null)).toBe("on-time");
  expect(eligibility(start + 60_001, start, null)).toBe("missed");
  expect(eligibility(start + 60_001, start, 120_000)).toBe("catch-up");
  expect(eligibility(start + 120_001, start, 120_000)).toBe("missed");
});

test("DST gaps shift once and folds choose the first instant, including exact wake times", () => {
  const cases = [
    [
      "30 2 * * *",
      "America/Chicago",
      "2026-03-08T07:00:00Z",
      "2026-03-08T08:30:00Z",
    ],
    [
      "30 1 * * *",
      "America/Chicago",
      "2026-11-01T05:00:00Z",
      "2026-11-01T06:30:00Z",
    ],
    [
      "30 1 * * *",
      "Europe/London",
      "2026-03-29T00:00:00Z",
      "2026-03-29T01:30:00Z",
    ],
    [
      "30 1 * * *",
      "Europe/London",
      "2026-10-24T23:00:00Z",
      "2026-10-25T00:30:00Z",
    ],
    [
      "30 2 * * *",
      "Australia/Sydney",
      "2026-10-03T15:00:00Z",
      "2026-10-03T16:30:00Z",
    ],
    [
      "30 2 * * *",
      "Australia/Sydney",
      "2026-04-04T14:00:00Z",
      "2026-04-04T15:30:00Z",
    ],
  ] as const;
  for (const [expression, zone, before, expected] of cases) {
    const cron = Cron.parseUnsafe(expression, zone);
    expect(Cron.next(cron, before).toISOString()).toBe(
      new Date(expected).toISOString()
    );
    expect(dueSlots(cron, instant(before), instant(expected))?.latest).toBe(
      instant(expected)
    );
  }
  const fold = Cron.parseUnsafe("30 1 * * *", "America/Chicago");
  expect(
    dueSlots(
      fold,
      instant("2026-11-01T06:30:00Z"),
      instant("2026-11-01T07:30:00Z")
    )
  ).toBeNull();
  const quarters = Cron.parseUnsafe("*/15 * * * *", "America/Chicago");
  expect(Cron.next(quarters, "2026-11-01T06:45:00Z").toISOString()).toBe(
    "2026-11-01T08:00:00.000Z"
  );
  const collision = Cron.parseUnsafe("30 2,3 * * *", "America/Chicago");
  expect(
    dueSlots(
      collision,
      instant("2026-03-08T07:00:00Z"),
      instant("2026-03-08T09:00:00Z")
    )?.count
  ).toBe(1);
});

test("a retained shifted DST candidate retries with the same instant", () => {
  const cron = Cron.parseUnsafe("30 2 * * *", "America/Chicago");
  const pending = instant("2026-03-08T08:30:00Z");
  expect(dueSlots(cron, pending - 1, pending + 1000, pending)).toMatchObject({
    count: 1,
    first: pending,
    latest: pending,
  });
});

test("exactly 10000 older missed slots are not marked saturated when the latest is admitted", () => {
  const start = instant("2026-01-01T00:00:00Z");
  const due = dueSlots(
    Cron.parseUnsafe("* * * * *", "UTC"),
    start,
    start + 10_001 * 60_000
  );
  expect(due).toMatchObject({
    count: 10_000,
    olderSaturated: false,
    saturated: true,
  });
});
