import { expect, test } from "bun:test";

import { ReclamationRequest } from "@effectory/runtime/lake-protocol";
import { Effect, Schema } from "effect";

import { parseReclamation, retentionFor } from "../src/reclamation.ts";

test("reclamation flags map to strict policy, selection and explicit version requests", () => {
  expect(parseReclamation({ policy: false })).toEqual({ _tag: "Policy" });
  expect(
    parseReclamation({ policy: true, schema: "report", schemaVersion: 1 })
  ).toEqual({ _tag: "Policy", schemaId: "report", schemaVersion: 1 });
  expect(
    parseReclamation({
      keepLatest: 2,
      olderThan: "30 days",
      policy: false,
      schema: "report",
    })
  ).toEqual({
    _tag: "Selection",
    keepLatest: 2,
    olderThanMillis: 2_592_000_000,
    schemaId: "report",
  });
  expect(
    parseReclamation({ artifact: "a", policy: false, version: 3 })
  ).toEqual({ _tag: "Version", artifactId: "a", version: 3 });
  for (const flags of [
    { olderThan: "1 day", policy: true },
    { olderThan: "1 day", policy: false },
    { artifact: "a", policy: false },
    { policy: false, schemaVersion: 1 },
    { keepLatest: 0, policy: false, schema: "report" },
    { olderThan: "Infinity", policy: false, schema: "report" },
    { olderThan: "1 month", policy: false, schema: "report" },
    { artifact: "a", policy: false, schema: "report", version: 1 },
  ]) {
    expect(() => parseReclamation(flags)).toThrow();
  }
  expect(() =>
    Schema.decodeSync(ReclamationRequest)({
      _tag: "Selection",
      olderThanMillis: 2 ** 53,
      schemaId: "report",
    })
  ).toThrow();
});

test("reclamation refuses an old daemon before sending a new command", async () => {
  const error = await Effect.runPromise(
    retentionFor({
      SystemStatus: () => Effect.succeed({ capabilities: [] }),
    }).pipe(Effect.flip)
  );
  expect(error.code).toBe("Unavailable");
  await Effect.runPromise(
    retentionFor({
      SystemStatus: () =>
        Effect.succeed({ capabilities: ["lake.retention.v1"] }),
    })
  );
});

test("automatic retention refuses unsupported daemons before a mutation", async () => {
  const { automaticRetentionFor } = await import("../src/reclamation.ts");
  let submitted = false;
  const error = await Effect.runPromise(
    automaticRetentionFor({
      SystemStatus: () =>
        Effect.succeed({ capabilities: ["lake.retention.v1"] }),
    }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          submitted = true;
        })
      ),
      Effect.flip
    )
  );
  expect(error.code).toBe("Unavailable");
  expect(error.message).toContain("daemon stop");
  expect(submitted).toBe(false);
  await Effect.runPromise(
    automaticRetentionFor({
      SystemStatus: () =>
        Effect.succeed({ capabilities: ["lake.retention.automatic.v1"] }),
    })
  );
});
