import { describe, expect, test } from "bun:test";

import { Data, Deferred, Effect, Fiber, Layer, Schema } from "effect";

import * as Action from "../src/action.ts";
import * as Engine from "../src/engine.ts";
import * as Node from "../src/node.ts";
import * as Output from "../src/output.ts";
import * as Plan from "../src/plan.ts";
import * as State from "../src/state.ts";
import * as Workflow from "../src/workflow.ts";

const options = { collection: "test", revision: "r1" };
const layer = Engine.layer.pipe(Layer.provideMerge(State.memory));
const run = <A, E>(effect: Effect.Effect<A, E, Engine.Engine | State.State>) =>
  Effect.runPromise(Effect.provide(effect, layer));

const Add = Action.make("Add", {
  input: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  output: Schema.Number,
  run: ({ a, b }) => Effect.succeed(a + b),
});

class Boom extends Data.TaggedError("Boom")<{ readonly message: string }> {}

const Fail = Action.make("Fail", {
  input: Schema.Struct({}),
  output: Schema.Number,
  run: () => Effect.fail(new Boom({ message: "boom" })),
});

const counter = () => {
  let count = 0;
  const action = Action.make("Count", {
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.String,
    rerun: "on-change",
    run: ({ value }) =>
      Effect.sync(() => {
        count += 1;
        return value;
      }),
  });
  return { action, count: () => count };
};

const statusOf = (summary: Engine.RunSummary, fqn: string) =>
  summary.nodes.find((node) => node.fqn === fqn)?.status;

describe("engine", () => {
  test("wires Outputs between Actions and records results", async () => {
    const workflow = Workflow.make(
      "sum",
      {
        description: "add twice",
        input: Schema.Struct({ x: Schema.Number }),
        scope: ({ x }) => `x=${x}`,
      },
      Effect.fn(function* workflow({ x }) {
        const first = yield* Add("first", { a: x, b: 1 });
        const second = yield* Add("second", { a: first, b: 10 });
        return { doubled: Output.map(second, (value) => value * 2) };
      })
    );
    const { summary, records } = await run(
      Effect.gen(function* test1() {
        const engine = yield* Engine.Engine;
        const state = yield* State.State;
        const ran = yield* engine.run(workflow, { x: 1 }, options);
        const written = yield* state.records({ collection: "test" });
        return { records: written, summary: ran };
      })
    );
    expect(summary.run.status).toBe("succeeded");
    expect(summary.run.result).toEqual({ doubled: 24 });
    expect(summary.run.scope).toBe("x=1");
    expect(records.map((record) => [record.fqn, record.value])).toEqual([
      ["sum/second", 12],
      ["sum/first", 2],
    ]);
  });

  test("runs independent nodes concurrently", async () => {
    const both = await run(
      Effect.gen(function* both() {
        const gate = yield* Deferred.make<string>();
        const Wait = Action.make("Wait", {
          input: Schema.Struct({}),
          output: Schema.String,
          run: () => Deferred.await(gate).pipe(Effect.as("waited")),
        });
        const Open = Action.make("Open", {
          input: Schema.Struct({}),
          output: Schema.String,
          run: () => Deferred.succeed(gate, "open").pipe(Effect.as("opened")),
        });
        const workflow = Workflow.make(
          "parallel",
          { description: "", input: Schema.Struct({}) },
          () =>
            Effect.all([Wait("wait", {}), Open("open", {})]).pipe(
              Effect.map(([wait, open]) => ({ open, wait }))
            )
        );
        const engine = yield* Engine.Engine;
        return yield* engine.run(workflow, {}, options);
      })
    );
    expect(both.run.result).toEqual({ open: "opened", wait: "waited" });
  });

  test("skips downstream of failures unless runIf allows; allowFailure keeps the run green", async () => {
    const workflow = Workflow.make(
      "failing",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* workflow() {
        const bad = yield* Fail("bad", {}, { allowFailure: true });
        yield* Add("after", { a: bad, b: 1 });
        yield* Add("cleanup", { a: 1, b: 1 }).pipe(
          Node.runIf("completed"),
          Node.dependsOn(bad)
        );
        yield* Add(
          "on-failure",
          { a: 0, b: 0 },
          { dependsOn: [bad], runIf: "failed" }
        );
        yield* Add("never", { a: 0, b: 0 }, { when: false });
      })
    );
    const summary = await run(
      Effect.flatMap(Engine.Engine, (engine) =>
        engine.run(workflow, {}, options)
      )
    );
    expect(statusOf(summary, "failing/bad")).toBe("failed");
    expect(
      summary.nodes.find((node) => node.fqn === "failing/bad")?.error
    ).toEqual({
      message: "boom",
      tag: "Boom",
    });
    expect(statusOf(summary, "failing/after")).toBe("skipped");
    expect(statusOf(summary, "failing/cleanup")).toBe("succeeded");
    expect(statusOf(summary, "failing/on-failure")).toBe("succeeded");
    expect(statusOf(summary, "failing/never")).toBe("skipped");
    expect(summary.run.status).toBe("succeeded");
  });

  test("skips propagate through ordering and data dependencies", async () => {
    const workflow = Workflow.make(
      "gated",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* workflow() {
        const optional = yield* Add(
          "optional",
          { a: 1, b: 1 },
          { when: false }
        );
        yield* Add("ordered", { a: 0, b: 0 }, { dependsOn: [optional] });
        yield* Add("consumer", { a: optional, b: 1 });
        const bad = yield* Fail("bad", {}, { allowFailure: true });
        const blocked = yield* Add("blocked", { a: bad, b: 1 });
        yield* Add("after-blocked", { a: 0, b: 0 }, { dependsOn: [blocked] });
      })
    );
    const summary = await run(
      Effect.flatMap(Engine.Engine, (engine) =>
        engine.run(workflow, {}, options)
      )
    );
    expect(statusOf(summary, "gated/optional")).toBe("skipped");
    // Only an approval skipped by its own `when` counts as an open gate.
    expect(statusOf(summary, "gated/ordered")).toBe("skipped");
    // A data dependency on a skipped node has no value to consume.
    expect(statusOf(summary, "gated/consumer")).toBe("skipped");
    // A node skipped because its upstream failed still blocks what follows it.
    expect(statusOf(summary, "gated/blocked")).toBe("skipped");
    expect(statusOf(summary, "gated/after-blocked")).toBe("skipped");
  });

  test("a failed node without allowFailure fails the run", async () => {
    const workflow = Workflow.make(
      "fails",
      { description: "", input: Schema.Struct({}) },
      () => Fail("bad", {})
    );
    const summary = await run(
      Effect.flatMap(Engine.Engine, (engine) =>
        engine.run(workflow, {}, options)
      )
    );
    expect(summary.run.status).toBe("failed");
  });

  test("rerun on-change skips when the input digest matches the latest record", async () => {
    const { action, count } = counter();
    const workflow = Workflow.make(
      "cached",
      {
        description: "",
        input: Schema.Struct({ value: Schema.String }),
        scope: () => "same",
      },
      ({ value }) => action("count", { value })
    );
    const plans = await run(
      Effect.gen(function* plans() {
        const engine = yield* Engine.Engine;
        yield* engine.run(workflow, { value: "a" }, options);
        yield* engine.run(workflow, { value: "a" }, options);
        const planned = yield* engine.plan(workflow, { value: "a" }, options);
        yield* engine.run(workflow, { value: "b" }, options);
        return planned;
      })
    );
    expect(count()).toBe(2);
    expect(plans.entries[0]?.change.action).toBe("cached");
  });

  test("refuses a second unfinished run for the same scope", async () => {
    const error = await run(
      Effect.gen(function* error() {
        const gate = yield* Deferred.make<string>();
        const Block = Action.make("Block", {
          input: Schema.Struct({}),
          output: Schema.String,
          run: () => Deferred.await(gate).pipe(Effect.as("done")),
        });
        const workflow = Workflow.make(
          "busy",
          { description: "", input: Schema.Struct({}) },
          () => Block("block", {})
        );
        const engine = yield* Engine.Engine;
        const first = yield* Effect.forkChild(
          engine.run(workflow, {}, options)
        );
        yield* Effect.sleep(20);
        const second = yield* Effect.flip(engine.run(workflow, {}, options));
        yield* Deferred.succeed(gate, "open");
        yield* Fiber.join(first);
        return second;
      })
    );
    expect(error._tag).toBe("RunError");
    expect((error as Engine.RunError).reason).toBe("scope-busy");
  });
});

const interruptible = (retry: "auto" | "never") => {
  let attempts = 0;
  let block = true;
  const Step = Action.make("Step", {
    input: Schema.Struct({}),
    output: Schema.String,
    retry,
    run: () =>
      Effect.suspend(() => {
        attempts += 1;
        return block ? Effect.never : Effect.succeed("done");
      }),
  });
  const workflow = Workflow.make(
    `resume-${retry}`,
    { description: "", input: Schema.Struct({}) },
    Effect.fn(function* workflow() {
      const first = yield* Add("first", { a: 1, b: 1 });
      const step = yield* Step("step", {}, { dependsOn: [first] });
      return { step };
    })
  );
  return {
    attempts: () => attempts,
    unblock: () => {
      block = false;
    },
    workflow,
  };
};

const crashRun = (workflow: Workflow.Any) =>
  Effect.gen(function* crash() {
    const engine = yield* Engine.Engine;
    const state = yield* State.State;
    const fiber = yield* Effect.forkChild(engine.run(workflow, {}, options));
    yield* Effect.sleep(30);
    yield* Fiber.interrupt(fiber);
    const [latest] = yield* state.listRuns({
      collection: "test",
      workflow: workflow.name,
    });
    return latest as State.RunRow;
  });

describe("resume", () => {
  test("reruns an interrupted Action and reuses succeeded nodes", async () => {
    const subject = interruptible("auto");
    const summary = await run(
      Effect.gen(function* summary() {
        const crashed = yield* crashRun(subject.workflow);
        expect(crashed.status).toBe("running");
        subject.unblock();
        const engine = yield* Engine.Engine;
        return yield* engine.resume(subject.workflow, crashed.id, options);
      })
    );
    expect(subject.attempts()).toBe(2);
    expect(summary.run.status).toBe("succeeded");
    expect(summary.run.result).toEqual({ step: "done" });
    expect(
      summary.nodes.find((node) => node.fqn.endsWith("/step"))?.attempt
    ).toBe(2);
    expect(
      summary.nodes.find((node) => node.fqn.endsWith("/first"))?.attempt
    ).toBe(1);
  });

  test("retry never fails with OutcomeUnknown until the retry is approved", async () => {
    const subject = interruptible("never");
    const { blocked, approved } = await run(
      Effect.gen(function* test2() {
        const crashed = yield* crashRun(subject.workflow);
        subject.unblock();
        const engine = yield* Engine.Engine;
        const state = yield* State.State;
        const first = yield* engine.resume(
          subject.workflow,
          crashed.id,
          options
        );
        const [approval] = yield* state.listApprovals({
          runId: crashed.id,
          status: "pending",
        });
        yield* state.putApproval({
          ...(approval as State.ApprovalRow),
          decidedAt: Date.now(),
          status: "approved",
        });
        const second = yield* engine.resume(
          subject.workflow,
          crashed.id,
          options
        );
        return { approved: second, blocked: first };
      })
    );
    expect(blocked.run.status).toBe("failed");
    expect(
      blocked.nodes.find((node) => node.fqn.endsWith("/step"))?.error?.tag
    ).toBe("OutcomeUnknown");
    expect(subject.attempts()).toBe(2);
    expect(approved.run.status).toBe("succeeded");
  });

  test("refuses to resume under a different revision", async () => {
    const subject = interruptible("auto");
    const error = await run(
      Effect.gen(function* error() {
        const crashed = yield* crashRun(subject.workflow);
        const engine = yield* Engine.Engine;
        return yield* Effect.flip(
          engine.resume(subject.workflow, crashed.id, { revision: "r2" })
        );
      })
    );
    expect(error._tag).toBe("RunError");
    expect((error as Engine.RunError).reason).toBe("revision-mismatch");
  });
});

describe("plan", () => {
  test("lists nodes in topological order and renders Mermaid", async () => {
    const workflow = Workflow.make(
      "planned",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* workflow() {
        const a = yield* Add("a", { a: 1, b: 2 });
        yield* Add("b", { a, b: 1 });
      })
    );
    const result = await run(
      Effect.flatMap(Engine.Engine, (engine) =>
        engine.plan(workflow, {}, options)
      )
    );
    expect(
      result.entries.map((entry) => [entry.fqn, entry.change.action])
    ).toEqual([
      ["planned/a", "run"],
      ["planned/b", "run"],
    ]);
    const mermaid = Plan.renderMermaid(result.built.graph);
    expect(mermaid).toContain("  0 --> 1");
    expect(mermaid).not.toContain("null");
    expect(Plan.renderText(result.entries)).toContain(
      "planned/b (Add)  <- planned/a"
    );
  });

  test("rejects duplicate node names", async () => {
    const workflow = Workflow.make(
      "dupes",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* workflow() {
        yield* Add("a", { a: 1, b: 2 });
        yield* Add("a", { a: 1, b: 2 });
      })
    );
    const error = await run(
      Effect.flip(
        Effect.flatMap(Engine.Engine, (engine) =>
          engine.plan(workflow, {}, options)
        )
      )
    );
    expect(error._tag).toBe("PlanError");
  });

  test("rejects invalid input", async () => {
    const workflow = Workflow.make(
      "typed",
      { description: "", input: Schema.Struct({ n: Schema.Number }) },
      () => Effect.void
    );
    const error = await run(
      Effect.flip(
        Effect.flatMap(Engine.Engine, (engine) =>
          engine.run(workflow, { n: "x" }, options)
        )
      )
    );
    expect((error as Engine.RunError).reason).toBe("invalid-input");
  });
});

const Items = Action.make("Items", {
  input: Schema.Struct({}),
  output: Schema.Array(Schema.Number),
  run: () => Effect.succeed([1, 2, 3]),
});
// A minimal dynamic fan-out node built directly on the engine contract.
const fanOut = (name: string, items: Output.Output<readonly number[]>) =>
  Node.register<readonly number[]>({
    execute: (ctx) =>
      Effect.gen(function* execute() {
        const values = ctx.input as readonly number[];
        const children = yield* ctx.expand(
          Effect.forEach(values, (value, index) =>
            Add(String(index), { a: value, b: 100 })
          )
        );
        return Node.succeeded(yield* ctx.await(children));
      }),
    input: items,
    kind: "each",
    name,
    permit: false,
    reuse: "record",
    type: "Each",
  });

describe("dynamic expansion", () => {
  test("nodes registered at execution time run and resolve", async () => {
    const workflow = Workflow.make(
      "dynamic",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* workflow() {
        const items = yield* Items("items", {});
        const sums = yield* fanOut("sums", items);
        return {
          total: Output.map(sums, (values) =>
            values.reduce((a, b) => a + b, 0)
          ),
        };
      })
    );
    const summary = await run(
      Effect.flatMap(Engine.Engine, (engine) =>
        engine.run(workflow, {}, { ...options, concurrency: 1 })
      )
    );
    expect(summary.run.status).toBe("succeeded");
    expect(summary.run.result).toEqual({ total: 306 });
    expect(summary.nodes.map((node) => node.fqn).toSorted()).toEqual([
      "dynamic/items",
      "dynamic/sums",
      "dynamic/sums/0",
      "dynamic/sums/1",
      "dynamic/sums/2",
    ]);
  });
});
