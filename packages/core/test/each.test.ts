/* oxlint-disable max-classes-per-file -- a tagged error and a test service. */
import { describe, expect, test } from "bun:test";

import { Context, Data, Effect, Fiber, Layer, Schema } from "effect";

import * as Action from "../src/action.ts";
import { Approve } from "../src/approve.ts";
import { Each } from "../src/each.ts";
import * as Engine from "../src/engine.ts";
import * as Output from "../src/output.ts";
import * as State from "../src/state.ts";
import * as Workflow from "../src/workflow.ts";

const options = { collection: "test", revision: "r1" };
const layer = Engine.layer.pipe(Layer.provideMerge(State.memory));
const run = <A, E>(effect: Effect.Effect<A, E, Engine.Engine | State.State>) =>
  Effect.runPromise(Effect.provide(effect, layer));

const Add = Action.make("Add", {
  input: Schema.Struct({ a: Schema.Finite, b: Schema.Finite }),
  output: Schema.Finite,
  run: ({ a, b }) => Effect.succeed(a + b),
});

const Items = Action.make("Items", {
  input: Schema.Struct({}),
  output: Schema.Array(Schema.Finite),
  run: () => Effect.succeed([1, 2, 3]),
});

class Boom extends Data.TaggedError("Boom")<{ readonly message: string }> {}

const statusOf = (summary: Engine.RunSummary, fqn: string) =>
  summary.nodes.find((node) => node.fqn === fqn)?.status;

const runWorkflow = (workflow: Workflow.Any, concurrency?: number) =>
  run(
    Effect.flatMap(Engine.Engine, (engine) =>
      engine.run(workflow, {}, { ...options, concurrency: concurrency ?? 8 })
    )
  );

describe("Each over a literal list", () => {
  const workflow = Workflow.make(
    "static",
    { description: "", input: Schema.Struct({}) },
    Effect.fn(function* body() {
      const sums = yield* Each("sum", [3, 1, 2], (n, index) =>
        Add(`n${n}`, { a: n, b: index * 10 })
      );
      return { sums };
    })
  );

  test("shows every child in the plan", async () => {
    const plan = await run(
      Effect.flatMap(Engine.Engine, (engine) =>
        engine.plan(workflow, {}, options)
      )
    );
    expect(plan.entries.map((entry) => [entry.fqn, entry.type])).toEqual([
      ["static/sum/n3", "Add"],
      ["static/sum/n1", "Add"],
      ["static/sum/n2", "Add"],
    ]);
  });

  test("returns results in item order", async () => {
    const summary = await runWorkflow(workflow);
    expect(summary.run.status).toBe("succeeded");
    expect(summary.run.result).toEqual({ sums: [3, 11, 22] });
  });

  test("applies node options to every child", async () => {
    const skipped = Workflow.make(
      "static-when",
      { description: "", input: Schema.Struct({}) },
      () =>
        Each("sum", [1, 2], (n) => Add(`n${n}`, { a: n, b: n }), {
          when: false,
        })
    );
    const summary = await runWorkflow(skipped);
    expect(statusOf(summary, "static-when/sum/n1")).toBe("skipped");
    expect(statusOf(summary, "static-when/sum/n2")).toBe("skipped");
  });

  test("limits children to { concurrency }", async () => {
    let active = 0;
    let peak = 0;
    const Slow = Action.make("Slow", {
      input: Schema.Struct({ n: Schema.Finite }),
      output: Schema.Finite,
      run: ({ n }) =>
        Effect.gen(function* slow() {
          active += 1;
          peak = Math.max(peak, active);
          yield* Effect.sleep(15);
          active -= 1;
          return n;
        }),
    });
    const limited = Workflow.make(
      "limited",
      { description: "", input: Schema.Struct({}) },
      () =>
        Each("slow", [1, 2, 3, 4, 5, 6], (n) => Slow(`s${n}`, { n }), {
          concurrency: 2,
        })
    );
    const summary = await runWorkflow(limited);
    expect(summary.run.status).toBe("succeeded");
    expect(summary.run.result).toEqual([1, 2, 3, 4, 5, 6]);
    expect(peak).toBe(2);
  });
});

describe("Each over an Output", () => {
  const workflow = Workflow.make(
    "dynamic",
    { description: "", input: Schema.Struct({}) },
    Effect.fn(function* body() {
      const items = yield* Items("items", {});
      const sums = yield* Each("sum", items, (n) =>
        Add(`n${n}`, { a: n, b: 100 })
      );
      return {
        sums,
        total: Output.map(sums, (values) => values.reduce((a, b) => a + b, 0)),
      };
    })
  );

  test("plans one expand node", async () => {
    const plan = await run(
      Effect.flatMap(Engine.Engine, (engine) =>
        engine.plan(workflow, {}, options)
      )
    );
    expect(
      plan.entries.map((entry) => [entry.fqn, entry.type, entry.change.action])
    ).toEqual([
      ["dynamic/items", "Items", "run"],
      ["dynamic/sum", "Each", "expand"],
    ]);
  });

  test("expands at execution and records children", async () => {
    const { summary, records } = await run(
      Effect.gen(function* test1() {
        const engine = yield* Engine.Engine;
        const state = yield* State.State;
        const ran = yield* engine.run(workflow, {}, options);
        const written = yield* state.records({
          collection: "test",
          runId: ran.run.id,
        });
        return { records: written, summary: ran };
      })
    );
    expect(summary.run.status).toBe("succeeded");
    expect(summary.run.result).toEqual({ sums: [101, 102, 103], total: 306 });
    expect(summary.nodes.map((node) => node.fqn).toSorted()).toEqual([
      "dynamic/items",
      "dynamic/sum",
      "dynamic/sum/n1",
      "dynamic/sum/n2",
      "dynamic/sum/n3",
    ]);
    expect(
      records.map((record) => record.fqn).filter((fqn) => fqn.includes("/n"))
    ).toHaveLength(3);
  });

  test("limits dynamic children to { concurrency }", async () => {
    let active = 0;
    let peak = 0;
    const Slow = Action.make("Slow", {
      input: Schema.Struct({ n: Schema.Finite }),
      output: Schema.Finite,
      run: ({ n }) =>
        Effect.gen(function* slow() {
          active += 1;
          peak = Math.max(peak, active);
          yield* Effect.sleep(15);
          active -= 1;
          return n;
        }),
    });
    const limited = Workflow.make(
      "dynamic-limited",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* body() {
        const items = yield* Items("items", {});
        return yield* Each("slow", items, (n) => Slow(`s${n}`, { n }), {
          concurrency: 1,
        });
      })
    );
    const summary = await runWorkflow(limited);
    expect(summary.run.result).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
  });

  test("a failed child fails the Each node", async () => {
    const Odd = Action.make("Odd", {
      input: Schema.Struct({ n: Schema.Finite }),
      output: Schema.Finite,
      run: ({ n }) =>
        n === 2
          ? Effect.fail(new Boom({ message: "even" }))
          : Effect.succeed(n),
    });
    const failing = Workflow.make(
      "dynamic-fail",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* body() {
        const items = yield* Items("items", {});
        const odd = yield* Each("odd", items, (n) => Odd(`n${n}`, { n }));
        yield* Add("after", { a: Output.map(odd, (v) => v.length), b: 0 });
      })
    );
    const summary = await runWorkflow(failing);
    expect(summary.run.status).toBe("failed");
    expect(statusOf(summary, "dynamic-fail/odd/n2")).toBe("failed");
    expect(statusOf(summary, "dynamic-fail/odd/n1")).toBe("succeeded");
    expect(statusOf(summary, "dynamic-fail/odd")).toBe("failed");
    expect(
      summary.nodes.find((node) => node.fqn === "dynamic-fail/odd")?.error?.tag
    ).toBe("ChildFailed");
    expect(statusOf(summary, "dynamic-fail/after")).toBe("skipped");
  });

  test("resume reuses succeeded children", async () => {
    const calls: number[] = [];
    let block = true;
    const Step = Action.make("Step", {
      input: Schema.Struct({ n: Schema.Finite }),
      output: Schema.Finite,
      run: ({ n }) =>
        Effect.suspend(() => {
          calls.push(n);
          return n === 3 && block ? Effect.never : Effect.succeed(n * 2);
        }),
    });
    const resumable = Workflow.make(
      "dynamic-resume",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* body() {
        const items = yield* Items("items", {});
        return yield* Each("step", items, (n) => Step(`n${n}`, { n }));
      })
    );
    const summary = await run(
      Effect.gen(function* resume() {
        const engine = yield* Engine.Engine;
        const state = yield* State.State;
        const fiber = yield* Effect.forkChild(
          engine.run(resumable, {}, options)
        );
        yield* Effect.sleep(30);
        yield* Fiber.interrupt(fiber);
        const [crashed] = yield* state.listRuns({
          collection: "test",
          workflow: resumable.name,
        });
        expect(crashed?.status).toBe("running");
        block = false;
        return yield* engine.resume(
          resumable,
          (crashed as State.RunRow).id,
          options
        );
      })
    );
    expect(summary.run.status).toBe("succeeded");
    expect(summary.run.result).toEqual([2, 4, 6]);
    expect(calls.toSorted()).toEqual([1, 2, 3, 3]);
    expect(
      summary.nodes.find((node) => node.fqn === "dynamic-resume/step/n1")
        ?.attempt
    ).toBe(1);
  });

  test("passes the caller's services to children", async () => {
    class Offset extends Context.Service<Offset, { readonly value: number }>()(
      "test/Offset"
    ) {}
    const Plus = Action.make("Plus", {
      input: Schema.Struct({ n: Schema.Finite }),
      output: Schema.Finite,
      run: ({ n }) => Effect.map(Offset, ({ value }) => n + value),
    });
    const services = Workflow.make(
      "dynamic-ctx",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* body() {
        const items = yield* Items("items", {});
        return yield* Each("plus", items, (n) => Plus(`n${n}`, { n }));
      })
    );
    const summary = await run(
      Effect.flatMap(Engine.Engine, (engine) =>
        engine
          .run(services, {}, options)
          .pipe(Effect.provideService(Offset, { value: 1000 }))
      )
    );
    expect(summary.run.status).toBe("succeeded");
    expect(summary.run.result).toEqual([1001, 1002, 1003]);
  });

  test("a suspended child suspends the Each node until resumed", async () => {
    const approvals = Workflow.make(
      "dynamic-approve",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* body() {
        const items = yield* Items("items", {});
        const decisions = yield* Each("ok", items, (n) =>
          Approve(`n${n}`, { title: `Ship ${n}?` })
        );
        return Output.map(decisions, (all) => all.length);
      })
    );
    const { first, second } = await run(
      Effect.gen(function* approveAll() {
        const engine = yield* Engine.Engine;
        const state = yield* State.State;
        const suspended = yield* engine.run(approvals, {}, options);
        for (const approval of yield* state.listApprovals({
          runId: suspended.run.id,
        })) {
          yield* Approve.decide(approval.id, { approved: true });
        }
        const resumed = yield* engine.resume(
          approvals,
          suspended.run.id,
          options
        );
        return { first: suspended, second: resumed };
      })
    );
    expect(first.run.status).toBe("suspended");
    expect(statusOf(first, "dynamic-approve/ok")).toBe("suspended");
    expect(statusOf(first, "dynamic-approve/ok/n2")).toBe("suspended");
    expect(second.run.status).toBe("succeeded");
    expect(second.run.result).toBe(3);
  });
});
