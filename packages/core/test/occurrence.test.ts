/* oxlint-disable unicorn/no-await-expression-member, no-await-in-loop -- Sequential evaluations assert lazy fixture capture and handler call counts. */
// @effect-diagnostics missingEffectContext:off floatingEffect:off
import { expect, test } from "bun:test";

import { Context, Effect, Layer, Schema } from "effect";

import { Artifact, Task, WorkflowSchedule } from "../src/index.ts";

const fixture = {
  catchUp: false,
  generation: 7,
  scheduleId: "hourly-report",
  scheduledFor: "2026-11-05T10:00:00.000Z",
};
const spec = {
  error: Schema.Never,
  id: "read-occurrence",
  input: Schema.Null,
  replay: "idempotent" as const,
  success: Schema.NullOr(WorkflowSchedule.Occurrence),
  version: 1,
};

test("occurrence fixtures are lazy, strictly decoded and omitted by default", async () => {
  let calls = 0;
  const task = Task.make(spec, (_, context) =>
    Effect.sync(() => {
      calls += 1;
      if (context.occurrence === undefined) {
        expect(context).not.toHaveProperty("occurrence");
      }
      return context.occurrence ?? null;
    })
  );
  expect(
    (await Effect.runPromise(Task.test(task, { input: null }))).value
  ).toBeNull();
  for (const [occurrence, field] of [
    [undefined, "occurrence"],
    [null, "occurrence"],
    [{ ...fixture, generation: 0 }, "generation"],
    [{ ...fixture, extra: true }, "extra"],
    [{ ...fixture, scheduledFor: "2026-11-05T10:00:00Z" }, "scheduledFor"],
  ] as const) {
    // Exercise callers at an untyped JS boundary, including an explicitly present undefined.
    const program = Task.test(task, { input: null, occurrence } as Parameters<
      typeof Task.test<typeof spec, never>
    >[1]);
    expect(calls).toBe(1);
    const error = await Effect.runPromise(Effect.flip(program));
    expect(error.code).toBe("InvalidBoundary");
    expect(error.message).toContain("occurrence");
    expect(error.message).toContain(field);
    if (field === "scheduledFor") {
      expect(error.message).toContain("Date#toISOString");
      expect(error.message).toContain("2026-11-05T10:00:00.000Z");
    }
    expect(error.message.length).toBeLessThan(1900);
  }
  expect(calls).toBe(1);
});

test("each evaluation captures a new frozen copy without freezing or retaining the caller fixture", async () => {
  const snapshots: (typeof WorkflowSchedule.Occurrence.Type)[] = [];
  const input = { ...fixture };
  const task = Task.make(spec, (_, context) =>
    Effect.sync(() => {
      const { occurrence } = context;
      if (!occurrence) {
        throw new Error("missing fixture");
      }
      snapshots.push(occurrence);
      expect(Object.isFrozen(occurrence)).toBe(true);
      expect(Reflect.set(occurrence, "generation", 99)).toBe(false);
      input.generation += 1;
      return occurrence;
    })
  );
  const program = Task.test(task, { input: null, occurrence: input });
  expect(input.generation).toBe(7);
  expect((await Effect.runPromise(program)).value?.generation).toBe(7);
  expect((await Effect.runPromise(program)).value?.generation).toBe(8);
  expect(snapshots[0]).not.toBe(snapshots[1]);
  expect(Object.isFrozen(input)).toBe(false);
});

test("canonical instants include extended years and export useful JSON Schema constraints", () => {
  const decode = Schema.decodeUnknownSync(WorkflowSchedule.Occurrence);
  for (const scheduledFor of [
    fixture.scheduledFor,
    "+275760-09-13T00:00:00.000Z",
    "-000001-01-01T00:00:00.000Z",
  ]) {
    expect(decode({ ...fixture, scheduledFor }).scheduledFor).toBe(
      scheduledFor
    );
  }
  for (const scheduledFor of [
    "2026-02-30T00:00:00.000Z",
    "2026-11-05T10:00:00Z",
    "2026-11-05T10:00:00.000+00:00",
    "+002026-11-05T10:00:00.000Z",
    "-000000-01-01T00:00:00.000Z",
  ]) {
    expect(() => decode({ ...fixture, scheduledFor })).toThrow();
  }
  for (const generation of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    expect(() => decode({ ...fixture, generation })).toThrow();
  }
  for (const scheduleId of ["", "bad:id", "a".repeat(201)]) {
    expect(() => decode({ ...fixture, scheduleId })).toThrow();
  }
  expect(
    Schema.toJsonSchemaDocument(WorkflowSchedule.Occurrence).schema
  ).toMatchObject({
    properties: {
      generation: { minimum: 1 },
      scheduleId: { pattern: "^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$" },
      scheduledFor: {
        pattern:
          "^(?:[0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$",
      },
    },
  });
});

test("slot labels are accepted by task keys and publication keys", async () => {
  const Report = Artifact.make({
    id: "report",
    schema: WorkflowSchedule.Occurrence,
    version: 1,
  });
  const task = Task.make(
    { ...spec, outputs: { report: Report } },
    (_, context) =>
      Effect.gen(function* () {
        const { occurrence } = context;
        if (!occurrence) {
          return null;
        }
        const key = `slot-${Date.parse(occurrence.scheduledFor)}`;
        expect(context.key(key)).toContain(key);
        yield* context.publish("report", occurrence, { key });
        return occurrence;
      })
  );
  const result = await Effect.runPromise(
    Task.test(task, { input: null, occurrence: fixture })
  );
  expect(result.value).toEqual(fixture);
  expect(result.publications[0]?.value).toEqual(fixture);
});

class Service extends Context.Service<Service, { readonly value: string }>()(
  "occurrence/Service"
) {}
const needsService = Task.make(spec, (_, context) =>
  Effect.as(Service, context.occurrence ?? null)
);
test("occurrence fixtures preserve service requirements and provision", async () => {
  expect(
    (
      await Effect.runPromise(
        Task.test(
          needsService.provide(Layer.succeed(Service, { value: "ok" })),
          { input: null, occurrence: fixture }
        )
      )
    ).value
  ).toEqual(fixture);
});
export function occurrenceTypeFixtures(
  context: Task.TaskContext<Record<never, never>>
) {
  // @ts-expect-error Occurrence is readonly.
  context.occurrence = fixture;
  if (context.occurrence) {
    // @ts-expect-error Individual fields are readonly.
    context.occurrence.generation = 3;
  }
  // @ts-expect-error Explicit undefined is not omission.
  Task.test(needsService, { input: null, occurrence: undefined });
  Task.test(needsService, {
    input: null,
    // @ts-expect-error Extra fixture fields are rejected.
    occurrence: { ...fixture, extra: true },
  });
  // @ts-expect-error Task input inference stays intact.
  Task.test(needsService, { input: "bad", occurrence: fixture });
  Effect.runPromise(
    // @ts-expect-error Missing service remains visible.
    Task.test(needsService, { input: null, occurrence: fixture })
  );
}
