import { describe, expect, test } from "bun:test";

import { Data, Effect, Layer, Schema } from "effect";

import * as Action from "../src/action.ts";
import { Assert } from "../src/assert.ts";
import type { AssertResult } from "../src/assert.ts";
import * as Engine from "../src/engine.ts";
import * as Output from "../src/output.ts";
import * as State from "../src/state.ts";
import * as Workflow from "../src/workflow.ts";

const options = { collection: "test", revision: "r1" };
const layer = Engine.layer.pipe(Layer.provideMerge(State.memory));
const run = <A, E>(effect: Effect.Effect<A, E, Engine.Engine | State.State>) =>
  Effect.runPromise(Effect.provide(effect, layer));

const Count = Action.make("Count", {
  input: Schema.Struct({ n: Schema.Finite }),
  output: Schema.Finite,
  run: ({ n }) => Effect.succeed(n),
});

class Boom extends Data.TaggedError("Boom")<{ readonly message: string }> {}

const Fail = Action.make("Fail", {
  input: Schema.Struct({}),
  output: Schema.Finite,
  run: () => Effect.fail(new Boom({ message: "boom" })),
});

const workflow = Workflow.make(
  "asserts",
  {
    description: "",
    input: Schema.Struct({}),
    reports: [Assert.junitReport],
  },
  Effect.fn(function* body() {
    const count = yield* Count("count", { n: 3 });
    const bad = yield* Fail("bad", {}, { allowFailure: true });
    const positive = yield* Assert("positive", {
      message: Output.map(count, (n) => `count is ${n}`),
      that: Output.map(count, (n) => n > 0),
    });
    const big = yield* Assert("big", {
      message: "count > 10 & <ok>",
      severity: "low",
      that: Output.map(count, (n) => n > 10),
    });
    const medium = yield* Assert("medium", {
      message: "count is even",
      severity: "medium",
      that: Output.map(count, (n) => n % 2 === 0),
    });
    const upstream = yield* Assert("upstream", {
      message: "bad is zero",
      that: Output.map(bad, (n) => n === 0),
    });
    yield* Assert("never", { message: "", that: true }, { when: false });
    yield* Count("gated", { n: 1 }, { when: big });
    return { big, medium, positive, upstream };
  })
);

const execute = () =>
  run(
    Effect.gen(function* test1() {
      const engine = yield* Engine.Engine;
      const state = yield* State.State;
      const summary = yield* engine.run(workflow, {}, options);
      const records = yield* state.records({
        collection: "test",
        runId: summary.run.id,
      });
      return { records, summary };
    })
  );

/** Every element is closed in order, and no raw `<`, `>`, `&` appear in text. */
const wellFormed = (xml: string) => {
  const stack: string[] = [];
  const body = xml.replace(/^<\?xml[^>]*\?>/u, "");
  for (const match of body.matchAll(
    /<(?<close>\/?)(?<name>[\w:-]+)(?<attrs>(?:\s+[\w:-]+="[^"<>]*")*)\s*(?<end>\/?)>/gu
  )) {
    const { close, end, name } = match.groups ?? {};
    if (close === "/") {
      if (stack.pop() !== name) {
        return false;
      }
    } else if (end !== "/") {
      stack.push(name ?? "");
    }
  }
  const text = body.replaceAll(
    /<\/?[\w:-]+(?:\s+[\w:-]+="[^"<>]*")*\s*\/?>/gu,
    ""
  );
  return (
    stack.length === 0 && !/[<>]|&(?!(?:amp|lt|gt|quot|apos);)/u.test(text)
  );
};

const statusOf = (summary: Engine.RunSummary, fqn: string) =>
  summary.nodes.find((node) => node.fqn === fqn)?.status;

describe("Assert", () => {
  test("records results and never fails the graph", async () => {
    const { summary, records } = await execute();
    expect(summary.run.status).toBe("succeeded");
    expect(summary.run.result).toEqual({
      big: false,
      medium: false,
      positive: true,
      upstream: false,
    });
    const results = Object.fromEntries(
      records
        .filter((record) => record.kind === "AssertResult")
        .map((record) => [record.fqn, record.value as AssertResult])
    );
    expect(results["asserts/positive"]).toEqual({
      message: "count is 3",
      passed: true,
      severity: "high",
    });
    expect(results["asserts/big"]).toEqual({
      message: "count > 10 & <ok>",
      passed: false,
      severity: "low",
    });
    expect(results["asserts/upstream"]).toEqual({
      message: "assertion input unavailable: asserts/bad has no value",
      passed: false,
      severity: "high",
    });
    expect(statusOf(summary, "asserts/upstream")).toBe("succeeded");
    expect(statusOf(summary, "asserts/never")).toBe("skipped");
    expect(statusOf(summary, "asserts/gated")).toBe("skipped");
  });

  test("failures and exitCode honor failOn thresholds", async () => {
    const { summary, records } = await execute();
    const names = (failOn: "low" | "medium" | "high" | "none") =>
      Assert.failures(records, failOn).map((record) => record.fqn);
    expect(names("low")).toEqual([
      "asserts/big",
      "asserts/medium",
      "asserts/upstream",
    ]);
    expect(names("medium")).toEqual(["asserts/medium", "asserts/upstream"]);
    expect(names("high")).toEqual(["asserts/upstream"]);
    expect(names("none")).toEqual([]);
    expect(Assert.shouldFail(records)).toBe(true);
    expect(Assert.exitCode({ records, run: summary.run }, "none")).toBe(0);
    expect(Assert.exitCode({ records, run: summary.run })).toBe(1);
    expect(Assert.severityRank("low")).toBeLessThan(
      Assert.severityRank("high")
    );
  });

  test("renders escaped JUnit XML as a report", async () => {
    const { summary, records } = await execute();
    const report = records.find((record) => record.kind === "Report")
      ?.value as { readonly content: string; readonly format: string };
    expect(report.format).toBe("junit");
    const xml = Assert.junit({
      nodes: summary.nodes,
      records,
      run: summary.run,
    });
    expect(report.content).toBe(xml);
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain(
      `<testsuite id="${summary.run.id}" name="asserts" errors="0" failures="3" skipped="1" tests="5"`
    );
    expect(xml).toContain(
      '<testcase classname="asserts" name="asserts/big"><failure message="count &gt; 10 &amp; &lt;ok&gt;" type="low">count &gt; 10 &amp; &lt;ok&gt;</failure></testcase>'
    );
    expect(xml).toContain(
      '<testcase classname="asserts" name="asserts/positive"/>'
    );
    expect(xml).toContain('name="asserts/never"><skipped');
    // allowFailure nodes are not errors.
    expect(xml).not.toContain("<error");
    expect(wellFormed(xml)).toBe(true);
  });

  test("escapes XML special and control characters", () => {
    expect(Assert.junit).toBeDefined();
    const xml = Assert.junit({
      nodes: [
        {
          attempt: 1,
          error: { message: `a "quoted" 'x' <y>\u0001`, tag: "Boom" },
          fqn: "w/bad",
          kind: "action",
          runId: "r",
          status: "failed",
          type: "Fail",
          updatedAt: 0,
        },
      ],
      records: [],
      run: {
        collection: "c",
        createdAt: 0,
        id: "r",
        input: {},
        mode: "live",
        plan: {},
        revision: "x",
        scope: "s",
        status: "failed",
        updatedAt: 1000,
        workflow: "w",
      },
    });
    expect(xml).toContain(
      '<error message="a &quot;quoted&quot; &apos;x&apos; &lt;y&gt;" type="Boom">'
    );
    expect(xml).toContain('errors="1"');
    expect(wellFormed(xml)).toBe(true);
  });
});
