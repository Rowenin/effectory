// @effect-diagnostics missingLayerContext:off missingEffectError:off missingEffectContext:off provideLayerSucceedToProvideService:off
import type { AutomationError } from "@effectory/sdk";
import { Activity, Automation, Effectory } from "@effectory/sdk";
import { Context, Effect, Layer, Schema } from "effect";
import type { WorkflowEngine } from "effect/workflow/WorkflowEngine";

/* oxlint-disable unicorn/no-array-method-this-argument -- Effect.map is not Array.map. */
class Missing extends Context.Service<Missing, { readonly value: string }>()(
  "test/AuthoringMissing"
) {}

// Compiled by the repository typecheck; never executed as runtime tests.
export const checkAuthoringTypes = () => {
  const activity = Activity.define({
    error: Schema.String,
    execute: (input) => Effect.succeed(String(input.count)),
    input: Schema.Struct({ count: Schema.Finite }),
    name: "typed",
    success: Schema.String,
  });
  const validInput = activity({ count: 1 });
  // @ts-expect-error activity arguments follow their input schema
  const invalidInput = activity({ count: "wrong" });
  Activity.define({
    error: Schema.Never,
    // @ts-expect-error result must match the declared schema
    execute: () => Effect.succeed(42),
    input: Schema.String,
    name: "wrong-result",
    success: Schema.String,
  });
  Activity.define({
    error: Schema.String,
    // @ts-expect-error errors must match the declared schema
    execute: () => Effect.fail(42),
    input: Schema.String,
    name: "wrong-error",
    success: Schema.String,
  });
  const dependent = Activity.define({
    error: Schema.Never,
    execute: () => Effect.map(Missing, (service) => service.value),
    input: Schema.String,
    name: "dependent",
    success: Schema.String,
  });
  const definition = {
    description: "Typed workflow",
    error: Schema.String,
    idempotencyKey: (input: { readonly count: number }) => String(input.count),
    input: Schema.Struct({ count: Schema.Finite }),
    name: "typed",
    success: Schema.String,
  };
  const automation = Automation.define({
    ...definition,
    execute: (input) => activity({ count: input.count }),
  });
  const result: Effect.Effect<string, string | AutomationError, unknown> =
    automation.workflow.execute({ count: 1 });
  // @ts-expect-error native escape hatch retains payload typing
  const invalidWorkflowInput = automation.workflow.execute({ count: "wrong" });
  Automation.define({
    ...definition,
    // @ts-expect-error workflow success must match the declared schema
    execute: () => Effect.succeed(42),
  });
  Automation.define({
    ...definition,
    // @ts-expect-error workflow errors must match the declared schema
    execute: () => Effect.fail(42),
  });
  const configuredAutomation = Automation.define({
    ...definition,
    execute: () => dependent("hello"),
  });
  const requirements: Layer.Layer<never, never, Missing | WorkflowEngine> =
    configuredAutomation.implementation;
  void requirements;
  Effectory.make({
    services: Layer.succeed(Missing, { value: "configured" }),
    workflows: [configuredAutomation],
  });
  Effectory.make({
    // @ts-expect-error configuration must supply its non-platform dependencies
    services: Layer.effect(
      Missing,
      Effect.map(Missing, (service) => service)
    ),
  });
  Automation.define({
    ...definition,
    execute: () =>
      dependent("hello").pipe(
        Effect.provide(Layer.succeed(Missing, { value: "provided" }))
      ),
  });
  Effectory.make({
    services: Layer.empty,
    // @ts-expect-error explicitly registered workflows require their application services
    workflows: [configuredAutomation],
  });
  const invalidOutput = Automation.publish("bad", {
    schema: Schema.String,
    // @ts-expect-error published values must match their schema
    value: 42,
  });
  return {
    invalidInput,
    invalidOutput,
    invalidWorkflowInput,
    result,
    validInput,
  };
};
