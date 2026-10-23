import { describe, expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";

import * as Action from "../src/action.ts";
import * as Data from "../src/data.ts";
import * as Engine from "../src/engine.ts";
import * as State from "../src/state.ts";
import * as Workflow from "../src/workflow.ts";

const options = { collection: "test", revision: "r1" };
const layer = Engine.layer.pipe(Layer.provideMerge(State.memory));
const run = <A, E>(effect: Effect.Effect<A, E, Engine.Engine | State.State>) =>
  Effect.runPromise(Effect.provide(effect, layer));

const Result = Schema.Struct({
  exitCode: Schema.Finite,
  stdout: Schema.String,
});

const Check = Action.make("Check", {
  input: Schema.Struct({ exitCode: Schema.Finite, stdout: Schema.String }),
  output: Result,
  run: (input) => Effect.succeed(input),
});

const producer = Workflow.make(
  "verify",
  {
    description: "",
    input: Schema.Struct({ code: Schema.Finite, pr: Schema.Finite }),
    scope: ({ pr }) => `#${pr}`,
  },
  ({ code }) => Check("test", { exitCode: code, stdout: `exit ${code}` })
);

const consumer = Workflow.make(
  "consume",
  {
    description: "",
    input: Schema.Struct({ pr: Schema.Finite }),
    scope: ({ pr }) => `#${pr}`,
  },
  Effect.fn(function* consume() {
    const fromAction = yield* Data.latest(Check, "verify/test");
    const fromSchema = yield* Data.latest(Result, "verify/test", {
      name: "schema",
    });
    const fromResource = yield* Data.latest(
      { attributes: Result },
      "verify/test",
      { name: "resource", scope: "#1" }
    );
    const missing = yield* Data.latest(Check, "verify/nothing");
    const history = yield* Data.versions(Check, "verify/test", { limit: 2 });
    return { fromAction, fromResource, fromSchema, history, missing };
  })
);

describe("Data", () => {
  test("latest and versions read records of earlier runs", async () => {
    const summary = await run(
      Effect.gen(function* dataRuns() {
        const engine = yield* Engine.Engine;
        yield* engine.run(producer, { code: 0, pr: 1 }, options);
        yield* engine.run(producer, { code: 1, pr: 2 }, options);
        yield* engine.run(producer, { code: 2, pr: 2 }, options);
        yield* engine.run(producer, { code: 3, pr: 2 }, options);
        return yield* engine.run(consumer, { pr: 2 }, options);
      })
    );
    expect(summary.run.status).toBe("succeeded");
    const result = summary.run.result as Record<string, unknown>;
    expect(result.fromAction).toEqual({ exitCode: 3, stdout: "exit 3" });
    expect(result.fromSchema).toEqual({ exitCode: 3, stdout: "exit 3" });
    expect(result.fromResource).toEqual({ exitCode: 0, stdout: "exit 0" });
    expect(result.missing).toBeUndefined();
    const history = result.history as readonly Data.Version<unknown>[];
    expect(history.map((version) => version.value)).toEqual([
      { exitCode: 3, stdout: "exit 3" },
      { exitCode: 2, stdout: "exit 2" },
    ]);
    expect(typeof history[0]?.runId).toBe("string");
    const fqns = summary.nodes.map((node) => [node.fqn, node.kind, node.type]);
    expect(fqns).toContainEqual([
      "consume/latest.verify.test",
      "data",
      "Data.latest",
    ]);
    expect(fqns).toContainEqual([
      "consume/versions.verify.test",
      "data",
      "Data.versions",
    ]);
  });

  test("data nodes write no records", async () => {
    const records = await run(
      Effect.gen(function* noRecords() {
        const engine = yield* Engine.Engine;
        const state = yield* State.State;
        yield* engine.run(consumer, { pr: 9 }, options);
        return yield* state.records({ collection: "test" });
      })
    );
    expect(records).toEqual([]);
  });

  test("parsed filters query records", async () => {
    const found = await run(
      Effect.gen(function* queryRecords() {
        const engine = yield* Engine.Engine;
        const state = yield* State.State;
        yield* engine.run(producer, { code: 0, pr: 1 }, options);
        yield* engine.run(producer, { code: 1, pr: 2 }, options);
        yield* engine.run(producer, { code: 2, pr: 3 }, options);
        return yield* state.records({
          collection: "test",
          kind: "Check",
          since: yield* Data.parseSince("1h"),
          where: yield* Data.parseWhere("exitCode != 0 and stdout != 'exit 2'"),
        });
      })
    );
    expect(found.map((record) => record.scope)).toEqual(["#2"]);
  });

  test("nameFor derives a single segment", () => {
    expect(Data.nameFor("latest", "verify-pr/check/unit test")).toBe(
      "latest.verify-pr.check.unit-test"
    );
  });
});

describe("Data.parseWhere", () => {
  test("parses comparisons joined by and", async () => {
    const parsed = await Effect.runPromise(
      Data.parseWhere(
        `exitCode != 0 and stdout = 'x y' and ok = true and n <= -1.5 and note = "a\\"b" and gone = null AND x >= 2`
      )
    );
    expect(parsed).toEqual([
      { op: "!=", path: "exitCode", value: 0 },
      { op: "=", path: "stdout", value: "x y" },
      { op: "=", path: "ok", value: true },
      { op: "<=", path: "n", value: -1.5 },
      { op: "=", path: "note", value: 'a"b' },
      { op: "=", path: "gone", value: null },
      { op: ">=", path: "x", value: 2 },
    ]);
    expect(await Effect.runPromise(Data.parseWhere("  "))).toEqual([]);
  });

  test("rejects anything else with InvalidQuery", async () => {
    const results = await Effect.runPromise(
      Effect.forEach(
        [
          "exitCode",
          "a = 1 or b = 2",
          "a = 1 b = 2",
          "a ~ 1",
          "a = 'open",
          "a > null",
          "a = bare",
        ],
        (input) => Effect.result(Data.parseWhere(input))
      )
    );
    for (const result of results) {
      expect(result).toMatchObject({ failure: { _tag: "InvalidQuery" } });
    }
  });
});

describe("Data.parseSince", () => {
  const now = Date.UTC(2026, 0, 10);
  test("parses durations and ISO dates", async () => {
    const since = (input: string) =>
      Effect.runPromise(Data.parseSince(input, now));
    expect(await since("7d")).toBe(now - 7 * 86_400_000);
    expect(await since("12h")).toBe(now - 12 * 3_600_000);
    expect(await since("30m")).toBe(now - 30 * 60_000);
    expect(await since("2026-01-01")).toBe(Date.UTC(2026, 0, 1));
    expect(await since("2026-01-01T12:00:00Z")).toBe(Date.UTC(2026, 0, 1, 12));
  });

  test("rejects garbage", async () => {
    const result = await Effect.runPromise(
      Effect.result(Data.parseSince("soon"))
    );
    expect(result._tag).toBe("Failure");
  });
});
