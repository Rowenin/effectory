import { describe, expect, test } from "bun:test";

import { Data, Effect, Layer, Schema } from "effect";

import * as Action from "../src/action.ts";
import * as Engine from "../src/engine.ts";
import * as Node from "../src/node.ts";
import * as Report from "../src/report.ts";
import * as State from "../src/state.ts";
import * as Workflow from "../src/workflow.ts";

const options = { collection: "test", revision: "r1" };
const layer = Engine.layer.pipe(Layer.provideMerge(State.memory));
const run = <A, E>(effect: Effect.Effect<A, E, Engine.Engine | State.State>) =>
  Effect.runPromise(Effect.provide(effect, layer));

class Boom extends Data.TaggedError("Boom")<{ readonly message: string }> {}

const Step = Action.make("Step", {
  input: Schema.Struct({ fail: Schema.Boolean }),
  output: Schema.String,
  run: ({ fail }) =>
    fail
      ? Effect.fail(new Boom({ message: "a | b\nc" }))
      : Effect.succeed("ok"),
});

/** Stands in for `Assert`, which writes `AssertResult` records. */
const assertResult = (name: string, passed: boolean) =>
  Node.register<boolean>({
    execute: () =>
      Effect.succeed(
        Node.succeeded({
          message: passed ? `${name} held` : `${name} broke`,
          passed,
          severity: "high",
        })
      ),
    input: {},
    kind: "assert",
    name,
    record: true,
    reuse: "record",
    type: "AssertResult",
  });

const custom = Report.make({
  format: "text",
  name: "count",
  render: ({ nodes, records }) =>
    Effect.succeed(`${nodes.length} nodes, ${records.length} records`),
});

const broken = Report.make({
  name: "broken",
  render: () => Effect.fail(new Boom({ message: "render failed" })),
});

const workflow = Workflow.make(
  "reported",
  {
    description: "",
    input: Schema.Struct({ fail: Schema.Boolean }),
    reports: [Report.summary, custom, broken],
    scope: ({ fail }) => (fail ? "failing" : "passing"),
  },
  Effect.fn(function* reported({ fail }) {
    yield* Step("step", { fail });
    yield* assertResult("works", true);
    yield* assertResult("fast", false);
  })
);

const read = (runId: string) =>
  Effect.all({
    broken: Report.latest(runId, "broken"),
    count: Report.latest(runId, "count"),
    missing: Effect.result(Report.latest(runId, "missing")),
    summary: Report.latest(runId, "summary"),
    // The record FQN that `run inspect` used to list resolves too.
    summaryByFqn: Report.latest(runId, "reported/report/summary"),
  });

describe("Report", () => {
  test("make validates names and defaults to markdown", () => {
    expect(Report.summary.format).toBe("markdown");
    expect(custom.format).toBe("text");
    expect(() =>
      Report.make({ name: "a/b", render: () => Effect.succeed("") })
    ).toThrow("Invalid report name");
  });

  test("reports are recorded after a run, including failed runs", async () => {
    const { failed, passed } = await run(
      Effect.gen(function* reportRuns() {
        const engine = yield* Engine.Engine;
        const ok = yield* engine.run(workflow, { fail: false }, options);
        const bad = yield* engine.run(workflow, { fail: true }, options);
        return {
          failed: { reports: yield* read(bad.run.id), run: bad.run },
          passed: { reports: yield* read(ok.run.id), run: ok.run },
        };
      })
    );
    expect(passed.run.status).toBe("succeeded");
    expect(failed.run.status).toBe("failed");

    // Every report sees the run's records as they were before any report rendered.
    expect(passed.reports.count).toEqual({
      content: "3 nodes, 3 records",
      format: "text",
    });
    expect(passed.reports.broken).toEqual({
      error: "render failed",
      format: "markdown",
    });
    expect(passed.reports.missing).toMatchObject({
      failure: { _tag: "ReportNotFound", report: "missing" },
    });

    const summary = passed.reports.summary as { content: string };
    expect(summary.content).toContain("# reported: succeeded");
    expect(passed.reports.summaryByFqn).toEqual(passed.reports.summary);
    expect(Report.nameOf("reported", "reported/report/summary")).toBe(
      "summary"
    );
    expect(summary.content).toContain("- Scope: `passing`");
    expect(summary.content).toContain(
      "| `reported/step` | Step | succeeded | 1 |  |"
    );
    expect(summary.content).toContain("1/2 passed");
    expect(summary.content).toContain(
      "| FAIL | `reported/fast` | high | fast broke |"
    );
    expect(summary.content).toContain(
      "| pass | `reported/works` | high | works held |"
    );

    const failedSummary = failed.reports.summary as { content: string };
    expect(failedSummary.content).toContain("# reported: failed");
    expect(failedSummary.content).toContain(
      "| `reported/step` | Step | failed | 1 | Boom: a \\| b c |"
    );
  });

  test("latest fails for an unknown run", async () => {
    const result = await run(Effect.result(Report.latest("nope", "summary")));
    expect(result).toMatchObject({
      failure: { _tag: "ReportNotFound", message: "Unknown run nope" },
    });
  });
});
