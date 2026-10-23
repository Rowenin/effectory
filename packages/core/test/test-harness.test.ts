import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import * as Action from "../src/action.ts";
import * as Provider from "../src/provider.ts";
import * as Resource from "../src/resource.ts";
import * as Test from "../src/test.ts";
import * as Workflow from "../src/workflow.ts";

const Box = Resource.make("Test.Box", {
  attributes: Schema.Struct({ id: Schema.String, label: Schema.String }),
  props: Schema.Struct({ label: Schema.String, size: Schema.Int }),
});
type BoxProps = (typeof Box.props)["Type"];
type BoxAttributes = (typeof Box.attributes)["Type"];

const memoryBox = () =>
  Provider.memory(Box, {
    attributes: (props, fqn) => ({
      id: `${fqn}:${props.size}`,
      label: props.label,
    }),
    diff: ({ news, olds }) =>
      Effect.succeed(
        news.size === olds.size ? undefined : { action: "replace" }
      ),
  });

/** Stands in for `Assert`: an Action whose records have kind `AssertResult`. */
const Check = Action.make("AssertResult", {
  input: Schema.Struct({ passed: Schema.Boolean }),
  output: Schema.Struct({
    message: Schema.String,
    passed: Schema.Boolean,
    severity: Schema.String,
  }),
  run: ({ passed }) =>
    Effect.succeed({ message: "checked", passed, severity: "high" }),
});

const workflow = Workflow.make(
  "boxes",
  {
    description: "",
    input: Schema.Struct({ label: Schema.String }),
    scope: ({ label }) => label,
  },
  Effect.fn(function* boxes({ label }) {
    const box = yield* Box("box", { label, size: 1 });
    yield* Check("labelled", { passed: true }, { dependsOn: [box] });
    return { id: box.id };
  })
);

describe("Test.run", () => {
  test("fake mode runs against the fake provider and returns records and asserts", async () => {
    const live = memoryBox();
    const fake = memoryBox();
    const result = await Effect.runPromise(
      Test.run(workflow, { label: "a" }).pipe(
        Effect.provide(
          Provider.dual(Box, {
            fake: Effect.succeed(fake),
            live: Effect.succeed(live),
          })
        )
      )
    );
    expect(result.run.status).toBe("succeeded");
    expect(result.run.mode).toBe("fake");
    expect(result.run.result).toEqual({ id: "boxes/box:1" });
    expect(result.records.map((record) => record.fqn)).toEqual([
      "boxes/box",
      "boxes/labelled",
    ]);
    expect(result.asserts).toEqual([
      { message: "checked", passed: true, severity: "high" },
    ]);
    expect(result.resources.map((row) => row.fqn)).toEqual(["boxes/box"]);
    expect(fake.store.all()).toHaveLength(1);
    expect(live.store.all()).toHaveLength(0);
  });

  test("live mode runs in a scratch scope and deletes its resources", async () => {
    const live = memoryBox();
    const result = await Effect.runPromise(
      Test.run(workflow, { label: "a" }, { mode: "live" }).pipe(
        Effect.provide(Provider.succeed(Box, live))
      )
    );
    expect(result.run.status).toBe("succeeded");
    expect(result.run.scope).toStartWith("test-");
    expect(result.resources).toEqual([]);
    expect(live.store.calls.creates).toBe(1);
    expect(live.store.all()).toHaveLength(0);
  });

  test("live mode cleans up after a failed run", async () => {
    const live = memoryBox();
    const Fail = Action.make("Fail", {
      input: Schema.Struct({}),
      output: Schema.Finite,
      run: () => Effect.die(new Error("boom")),
    });
    const failing = Workflow.make(
      "failing",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* failingBody() {
        const box = yield* Box("box", { label: "a", size: 1 });
        yield* Fail("fail", {}, { dependsOn: [box] });
      })
    );
    const result = await Effect.runPromise(
      Test.run(failing, {}, { mode: "live" }).pipe(
        Effect.provide(Provider.succeed(Box, live))
      )
    );
    expect(result.run.status).toBe("failed");
    expect(live.store.all()).toHaveLength(0);
  });
});

describe("Test.provider", () => {
  const cases = {
    create: { label: "a", size: 1 },
    replace: { label: "b", size: 2 },
    update: { label: "b", size: 1 },
  };

  test("passes on a correct provider", async () => {
    const box = memoryBox();
    const report = await Effect.runPromise(
      Test.provider(Box, { cases, layer: Provider.succeed(Box, box) })
    );
    expect(report.steps.map((step) => step.name)).toEqual([
      "create",
      "noop",
      "update",
      "replace",
      "delete",
      "recover",
    ]);
    expect(box.store.all()).toHaveLength(0);
  });

  test("reports a provider whose read cannot find what it created", async () => {
    const box = memoryBox();
    const broken: Provider.ProviderService<BoxProps, BoxAttributes> = {
      ...box,
      read: (input) =>
        input.output === undefined ? Provider.absent : box.read(input),
    };
    const error = await Effect.runPromise(
      Effect.flip(
        Test.provider(Box, { cases, layer: Provider.succeed(Box, broken) })
      )
    );
    expect(error._tag).toBe("ProviderTestFailed");
    expect(error.step).toBe("recover");
    expect(error.message).toContain("duplicate");
    expect(error.report.steps.map((step) => step.name)).toEqual([
      "create",
      "noop",
      "update",
      "replace",
      "delete",
    ]);
  });

  test("reports a provider that never converges", async () => {
    const box = memoryBox();
    const broken: Provider.ProviderService<BoxProps, BoxAttributes> = {
      ...box,
      diff: () => Effect.succeed({ action: "update" }),
    };
    const error = await Effect.runPromise(
      Effect.flip(
        Test.provider(Box, {
          cases: { create: cases.create },
          layer: Provider.succeed(Box, broken),
        })
      )
    );
    expect(error.step).toBe("noop");
  });
});
