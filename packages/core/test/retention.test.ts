import { expect, test } from "bun:test";

import { Duration, Schema } from "effect";

import * as Artifact from "../src/artifact.ts";

test("artifact retention captures immutable normalized Effect durations", () => {
  const policy = { maxAge: "30 days" as const, maxVersions: 3 };
  const artifact = Artifact.make({
    id: "report",
    retention: policy,
    schema: Schema.Int,
    version: 1,
  });
  policy.maxVersions = 9;
  expect(artifact.retention).toEqual({
    maxAgeMillis: 2_592_000_000,
    maxVersions: 3,
  });
  expect(Object.isFrozen(artifact.retention)).toBe(true);
  const nanos = Artifact.make({
    id: "nanos",
    retention: { maxAge: 2_000_000n },
    schema: Schema.Int,
    version: 1,
  });
  expect(nanos.retention?.maxAgeMillis).toBe(2);
  for (const maxAge of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0.9,
    2n,
    "1 month",
    Duration.infinity,
  ]) {
    // Untyped callers can pass any retention shape.
    expect(() => {
      Reflect.apply(Artifact.make, undefined, [
        { id: "bad", retention: { maxAge }, schema: Schema.Int, version: 1 },
      ]);
    }).toThrow();
  }
  for (const maxVersions of [0, -1, 1.5, 2 ** 53]) {
    expect(() =>
      Artifact.make({
        id: "bad",
        retention: { maxVersions },
        schema: Schema.Int,
        version: 1,
      })
    ).toThrow();
  }
  expect(() =>
    Artifact.make({ id: "bad", retention: {}, schema: Schema.Int, version: 1 })
  ).toThrow();
});
