import { expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { checkJsonBudget } from "../src/boundary.ts";
import { TaskRuntimeError } from "../src/errors.ts";
import * as Task from "../src/task.ts";

test("JSON budgets count UTF-8 and escaping, bound nesting, and distinguish sharing from cycles", () => {
  const value = { array: [true, null, 2], quote: '"', unicode: "🌱" };
  const bytes = Buffer.byteLength(JSON.stringify(value));
  expect(() =>
    checkJsonBudget(value, { bytes, depth: 64, values: 100 })
  ).not.toThrow();
  expect(() =>
    checkJsonBudget(value, { bytes: bytes - 1, depth: 64, values: 100 })
  ).toThrow("exceeds");
  const shared = { value: "ok" };
  expect(() => checkJsonBudget([shared, shared])).not.toThrow();
  const cycle: { next?: unknown } = {};
  cycle.next = cycle;
  expect(() => checkJsonBudget(cycle)).toThrow("acyclic");
  let deep: Schema.Json = null;
  for (let depth = 0; depth < 65; depth += 1) {
    deep = [deep];
  }
  expect(() => checkJsonBudget(deep)).toThrow("exceeds");
  expect(() =>
    checkJsonBudget(Array.from({ length: 100_000 }, () => null))
  ).toThrow("exceeds");
});

test("task boundaries reject oversized inputs before handlers and oversized results after one attempt", async () => {
  let calls = 0;
  const echo = Task.make(
    {
      error: Schema.Never,
      id: "budget/echo",
      input: Schema.String,
      replay: "manual",
      success: Schema.String,
      version: 1,
    },
    (value) =>
      Effect.sync(() => {
        calls += 1;
        return value === "large" ? "x".repeat(1_048_576) : value;
      })
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* Effect.result(
        Task.test(echo, { input: "x".repeat(1_048_576) })
      );
      expect(input._tag).toBe("Failure");
      if (input._tag === "Failure") {
        expect(input.failure).toBeInstanceOf(TaskRuntimeError);
        expect(input.failure.code).toBe("LimitExceeded");
      }
      expect(calls).toBe(0);
      const result = yield* Effect.result(Task.test(echo, { input: "large" }));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe("LimitExceeded");
      }
      expect(calls).toBe(1);
      expect((yield* Task.test(echo, { input: "ok" })).value).toBe("ok");
    })
  );
});
