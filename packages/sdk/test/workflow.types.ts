import { Effectory, Expr, Task, Workflow } from "@effectory/sdk";
import { Context, Effect, Layer, Schema } from "effect";

// Compile-time checks for declarative plans; this file is typechecked, not run.
// The Effect plugin repeats TypeScript's missing-service error under its own
// rule, which @ts-expect-error cannot cover; TypeScript's error is asserted.
// @effect-diagnostics missingLayerContext:off

class Clock extends Context.Service<Clock, { readonly now: number }>()(
  "test/Clock"
) {}

const fetchCount = Task.make({
  error: Schema.Never,
  input: Schema.Struct({ url: Schema.String }),
  name: "fetch-count",
  run: () => Effect.succeed(3),
  success: Schema.Finite,
});
const stamp = Task.make({
  error: Schema.Never,
  input: Schema.Struct({
    count: Schema.Finite,
    level: Schema.Literals(["low", "high"]),
  }),
  name: "stamp",
  run: ({ count }) =>
    Effect.gen(function* stampCount() {
      const clock = yield* Clock;
      return clock.now + count;
    }),
  success: Schema.Finite,
});

const base = Workflow.make("typed", {
  description: "Type checks",
  input: Schema.Struct({ requestId: Schema.String, url: Schema.String }),
  key: ($) => $.input.requestId,
});

export const valid = base.pipe(
  Workflow.step("count", fetchCount, ($) => ({ url: $.input.url })),
  Workflow.each("stamps", ["low", "high"] as const, stamp, ($, level) => ({
    count: $.steps.count,
    level,
  })),
  Workflow.compute(
    "total",
    (args: { readonly stamps: readonly number[] }) =>
      args.stamps.reduce((sum, value) => sum + value, 0),
    ($) => ({
      stamps: $.steps.stamps,
    })
  ),
  Workflow.approve("check", {
    review: ($) => $.steps.total,
    title: "Check total",
    when: ($) => Expr.eq($.steps.count, 3),
  }),
  Workflow.returns(Schema.Finite, ($) => $.steps.total)
);

// Services the plan's Tasks need flow to the root.
export const configured = Effectory.make({
  services: Layer.succeed(Clock, { now: 0 }),
  workflows: [valid],
});
Effectory.make({
  services: Layer.empty,
  // @ts-expect-error the stamp Task needs Clock, which the root does not provide
  workflows: [valid],
});

export const unknownStep = base.pipe(
  // @ts-expect-error a step can only reference steps that come before it
  Workflow.step("count", fetchCount, ($) => ({ url: $.steps.missing }))
);
export const wrongType = base.pipe(
  Workflow.step("count", fetchCount, ($) => ({ url: $.input.url })),
  // @ts-expect-error a binding must match the Task's input type
  Workflow.step("again", fetchCount, ($) => ({ url: $.steps.count }))
);
export const wrongLiteral = base.pipe(
  Workflow.step("count", fetchCount, ($) => ({ url: $.input.url })),
  Workflow.step("stamp", stamp, ($) => ({
    count: $.steps.count,
    // @ts-expect-error literals are checked against the Task's input schema
    level: "medium",
  }))
);
export const wrongResult = base.pipe(
  Workflow.step("count", fetchCount, ($) => ({ url: $.input.url })),
  // @ts-expect-error the result must match the declared output schema
  Workflow.returns(Schema.String, ($) => $.steps.count)
);

// A called workflow's result is a step output; its services reach the root.
const parent = Workflow.make("parent", {
  description: "Calls valid",
  input: Schema.Struct({ id: Schema.String, site: Schema.String }),
  key: ($) => $.input.id,
});
export const composed = parent.pipe(
  Workflow.call("child", valid, ($) => ({
    requestId: $.input.id,
    url: $.input.site,
  })),
  Workflow.returns(Schema.Finite, ($) => $.steps.child)
);
export const composedConfigured = Effectory.make({
  services: Layer.succeed(Clock, { now: 0 }),
  workflows: [composed],
});
Effectory.make({
  services: Layer.empty,
  // @ts-expect-error the called workflow's stamp Task needs Clock
  workflows: [composed],
});
export const wrongCallInput = parent.pipe(
  // @ts-expect-error a call's binding must match the workflow's input
  Workflow.call("child", valid, ($) => ({ requestId: $.input.id }))
);
export const wrongCallResult = parent.pipe(
  Workflow.call("child", valid, ($) => ({
    requestId: $.input.id,
    url: $.input.site,
  })),
  // @ts-expect-error a call's output has the workflow's success type
  Workflow.returns(Schema.String, ($) => $.steps.child)
);
