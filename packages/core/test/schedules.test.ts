// @effect-diagnostics missingEffectContext:off floatingEffect:off
import { expect, test } from "bun:test";

import { Context, Effect, Layer, Schema } from "effect";

import { Application, Task, Workflow, WorkflowSchedule } from "../src/index.ts";

const Input = Schema.Struct({ names: Schema.Array(Schema.String) });
const Echo = Workflow.make(
  { error: Schema.Never, id: "echo", input: Input, success: Input, version: 1 },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    return yield* graph.input(Input);
  })
);
const base = {
  cron: "0 * * * *",
  id: "hourly",
  input: { names: ["Ada"] },
  workflow: Echo,
};
const build = (app: Application.Application<never>) =>
  Effect.runPromise(Application.Registry.pipe(Effect.provide(app.layer)));

test("schedule captures strict immutable encoded input and normalizes only cron whitespace", () => {
  const input = { names: ["Ada"] };
  const value = WorkflowSchedule.make({
    ...base,
    cron: "  0   * * * *  ",
    input,
  });
  input.names.push("Grace");
  expect(value.encodedInput).toEqual({ names: ["Ada"] });
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.encodedInput)).toBe(true);
  expect(
    Object.isFrozen(
      Reflect.get(value.encodedInput as { names: readonly string[] }, "names")
    )
  ).toBe(true);
  expect(value.cron).toBe("0 * * * *");
  expect(value.timeZone).toBe("UTC");
  expect(value.catchUp).toBe("skip");
  const excess = { extra: true, names: ["Ada"] };
  expect(() => WorkflowSchedule.make({ ...base, input: excess })).toThrow();
  expect(() =>
    WorkflowSchedule.make({
      ...base,
      input: { names: ["a".repeat(1_048_576)] },
    })
  ).toThrow();
});

test("schedule input uses codec Type and retains its encoded representation", () => {
  const codec = Schema.Struct({ count: Schema.FiniteFromString });
  const workflow = Workflow.make(
    {
      error: Schema.Never,
      id: "count",
      input: codec,
      success: codec,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      return yield* graph.input(codec);
    })
  );
  expect(
    WorkflowSchedule.make({ ...base, input: { count: 42 }, workflow })
      .encodedInput
  ).toEqual({ count: "42" });
});

test("cron rejects unsupported syntax, unsatisfiable dates, offsets and invalid catch-up windows", () => {
  for (const [cron, message] of [
    ["@hourly", "nicknames"],
    ["0 * * * * *", "five fields"],
    ["0 0 L * *", "modifier: L"],
    ["0 0 * * MON#2", "modifier: #"],
    ["0 0 1W * *", "modifier: W"],
    ["0 0 ? * *", "modifier: ?"],
  ]) {
    expect(() => WorkflowSchedule.make({ ...base, cron: cron ?? "" })).toThrow(
      message
    );
  }
  expect(() =>
    WorkflowSchedule.make({ ...base, cron: "0 0 30 2 *" })
  ).toThrow();
  expect(() => WorkflowSchedule.make({ ...base, timeZone: "+05:00" })).toThrow(
    "named IANA"
  );
  expect(() =>
    WorkflowSchedule.make({ ...base, timeZone: "not/a-zone" })
  ).toThrow();
  for (const latestWithin of ["1 second", "32 days", "invalid"]) {
    expect(() =>
      WorkflowSchedule.make({ ...base, catchUp: { latestWithin } })
    ).toThrow();
  }
  expect(
    WorkflowSchedule.make({
      ...base,
      cron: "0 0 */2 JAN MON",
      timeZone: "US/Central",
    }).cron
  ).toBe("0 0 */2 JAN MON");
  expect(
    WorkflowSchedule.make({ ...base, timeZone: "US/Central" }).timeZone
  ).toBe("US/Central");
});

test("application discovers scheduled workflows once and rejects conflicting identities and too many schedules", async () => {
  const schedule = WorkflowSchedule.make(base);
  const registry = await build(
    Application.make({
      schedules: [schedule, WorkflowSchedule.make({ ...base, id: "second" })],
      workflows: [Echo],
    })
  );
  expect(registry.workflows.size).toBe(1);
  expect(registry.schedules.size).toBe(2);
  await expect(
    build(Application.make({ schedules: [schedule, schedule] }))
  ).rejects.toThrow("Duplicate schedule");
  const other = Workflow.make(
    Echo.spec,
    Effect.die("must not build conflicting definition")
  );
  await expect(
    build(Application.make({ schedules: [schedule], workflows: [other] }))
  ).rejects.toThrow("Noncanonical workflow");
  await expect(
    build(
      Application.make({
        schedules: Array.from({ length: 129 }, (_, index) =>
          WorkflowSchedule.make({ ...base, id: `schedule-${index}` })
        ),
      })
    )
  ).rejects.toThrow("128 declared");
});

class Service extends Context.Service<Service, { readonly value: string }>()(
  "schedule-test/Service"
) {}
const NeedsService = Task.make(
  {
    error: Schema.Never,
    id: "needs-service",
    input: Input,
    replay: "idempotent",
    success: Schema.String,
    version: 1,
  },
  () => Effect.map(Service, (service) => service.value)
);
const WithTask = Workflow.make(
  { ...Echo.spec, id: "with-task", success: Schema.String },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    return yield* graph.task("value", NeedsService, { names: [] });
  })
);
const TaskSchedule = WorkflowSchedule.make({ ...base, workflow: WithTask });
test("scheduled graphs still require their canonical tasks", async () => {
  await expect(
    build(Application.make({ schedules: [TaskSchedule] }))
  ).rejects.toThrow("Missing or noncanonical task");
  const registry = await build(
    Application.make({
      schedules: [TaskSchedule],
      tasks: [NeedsService],
    }).provide(Layer.succeed(Service, { value: "ready" }))
  );
  expect(registry.workflows.has("with-task")).toBe(true);
});
export function scheduleTypeFixtures() {
  // @ts-expect-error NoInfer prevents input from widening the workflow contract.
  WorkflowSchedule.make({ ...base, input: { names: [12] } });
  const { input: _input, ...withoutInput } = base;
  // @ts-expect-error Fixed input must be supplied explicitly.
  WorkflowSchedule.make(withoutInput);
  Effect.runPromise(
    // @ts-expect-error Application services cannot disappear through scheduling.
    Effect.scoped(
      Layer.build(
        Application.make({ schedules: [TaskSchedule], tasks: [NeedsService] })
          .layer
      )
    )
  );
}
