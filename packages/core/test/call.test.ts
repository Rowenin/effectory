import { describe, expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";

import * as Action from "../src/action.ts";
import { Call } from "../src/call.ts";
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

const Ten = Action.make("Ten", {
  input: Schema.Struct({}),
  output: Schema.Finite,
  run: () => Effect.succeed(10),
});

const callee = Workflow.make(
  "double",
  { description: "", input: Schema.Struct({ n: Schema.Finite }) },
  Effect.fn(function* body({ n }) {
    const once = yield* Add("once", { a: n, b: n });
    const twice = yield* Add("twice", { a: once, b: once });
    return { twice };
  })
);

const fqns = (summary: Engine.RunSummary) =>
  summary.nodes.map((node) => node.fqn).toSorted();

describe("Call", () => {
  test("a plan-time input inlines the callee under name/", async () => {
    const caller = Workflow.make(
      "caller",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* body() {
        const result = yield* Call("quad", callee, { n: 3 });
        return yield* Add("after", { a: result.twice, b: 1 });
      })
    );
    const { plan, summary } = await run(
      Effect.gen(function* test1() {
        const engine = yield* Engine.Engine;
        return {
          plan: yield* engine.plan(caller, {}, options),
          summary: yield* engine.run(caller, {}, options),
        };
      })
    );
    expect(plan.entries.map((entry) => entry.fqn)).toEqual([
      "caller/quad/once",
      "caller/quad/twice",
      "caller/after",
    ]);
    expect(summary.run.status).toBe("succeeded");
    expect(summary.run.result).toBe(13);
  });

  test("an Output input expands one Call node at execution", async () => {
    const caller = Workflow.make(
      "caller-dynamic",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* body() {
        const ten = yield* Ten("ten", {});
        const result = yield* Call("quad", callee, { n: ten });
        return Output.map(result, (value) => value.twice);
      })
    );
    const { plan, summary } = await run(
      Effect.gen(function* test2() {
        const engine = yield* Engine.Engine;
        return {
          plan: yield* engine.plan(caller, {}, options),
          summary: yield* engine.run(caller, {}, options),
        };
      })
    );
    expect(
      plan.entries.map((entry) => [entry.fqn, entry.type, entry.change.action])
    ).toEqual([
      ["caller-dynamic/ten", "Ten", "run"],
      ["caller-dynamic/quad", "Call:double", "expand"],
    ]);
    expect(summary.run.status).toBe("succeeded");
    expect(summary.run.result).toBe(40);
    expect(fqns(summary)).toEqual([
      "caller-dynamic/quad",
      "caller-dynamic/quad/once",
      "caller-dynamic/quad/twice",
      "caller-dynamic/ten",
    ]);
  });

  test("invalid plan-time input fails the plan", async () => {
    const caller = Workflow.make(
      "caller-invalid",
      { description: "", input: Schema.Struct({}) },
      () => Call("quad", callee, { n: "three" as unknown as number })
    );
    const error = await run(
      Effect.flip(
        Effect.flatMap(Engine.Engine, (engine) =>
          engine.plan(caller, {}, options)
        )
      )
    );
    expect(error._tag).toBe("PlanError");
    expect(error.message).toContain("invalid input for double");
  });

  test("invalid execution-time input fails the Call node", async () => {
    const Word = Action.make("Word", {
      input: Schema.Struct({}),
      output: Schema.String,
      run: () => Effect.succeed("three"),
    });
    const caller = Workflow.make(
      "caller-invalid-dynamic",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* body() {
        const word = yield* Word("word", {});
        yield* Call("quad", callee, {
          n: word as unknown as Output.Output<number>,
        });
      })
    );
    const summary = await run(
      Effect.flatMap(Engine.Engine, (engine) => engine.run(caller, {}, options))
    );
    expect(summary.run.status).toBe("failed");
    expect(
      summary.nodes.find((node) => node.fqn === "caller-invalid-dynamic/quad")
        ?.error?.tag
    ).toBe("InvalidCallInput");
  });

  test("node options on a plan-time Call apply to every callee node", async () => {
    const caller = Workflow.make(
      "caller-when",
      { description: "", input: Schema.Struct({}) },
      () => Call("quad", callee, { n: 1 }, { when: false })
    );
    const summary = await run(
      Effect.flatMap(Engine.Engine, (engine) => engine.run(caller, {}, options))
    );
    expect(summary.nodes.map((node) => node.status)).toEqual([
      "skipped",
      "skipped",
    ]);
  });
});
