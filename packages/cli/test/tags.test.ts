import { expect, test } from "bun:test";

import { Effect } from "effect";

import { parseTags, tagsFor } from "../src/tags.ts";

test("tag flags split once, retain empty values and reject duplicate or malformed keys", () => {
  expect(parseTags(["build=042", "label=", "correlation=a=b"])).toEqual({
    build: "042",
    correlation: "a=b",
    label: "",
  });
  expect(parseTags([])).toEqual({});
  for (const values of [
    ["team=a", "team=a"],
    ["team"],
    ["bad:key=x"],
    [`build=${"x".repeat(257)}`],
  ]) {
    expect(() => parseTags(values)).toThrow();
  }
});

test("untagged commands skip capability probing and tagged commands refuse an old daemon", async () => {
  let probes = 0;
  const old = {
    SystemStatus: () =>
      Effect.sync(() => {
        probes += 1;
        return { capabilities: [] };
      }),
  };
  expect(await Effect.runPromise(tagsFor(old, []))).toEqual({});
  expect(probes).toBe(0);
  const error = await Effect.runPromise(
    tagsFor(old, ["team=platform"]).pipe(Effect.flip)
  );
  expect(error.code).toBe("Unavailable");
  expect(error.message).toContain("restart");
  expect(probes).toBe(1);
  expect(
    await Effect.runPromise(
      tagsFor(
        {
          SystemStatus: () => Effect.succeed({ capabilities: ["run-tags.v1"] }),
        },
        ["team=platform"]
      )
    )
  ).toEqual({ tags: { team: "platform" } });
});
