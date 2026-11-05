// @effect-diagnostics floatingEffect:off
import { expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";

import { Application, Ref, Task, Workflow } from "../src/index.ts";
import { ReleaseTools } from "./fixtures/contracts.ts";
import { InspectReleaseLive } from "./fixtures/implementation.ts";

const Inspect = ReleaseTools.tasks.InspectRelease;
const Flow = Workflow.make(
  {
    error: Inspect.errorSchema,
    id: "consumer",
    input: Inspect.inputSchema,
    success: Inspect.successSchema,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    return yield* graph.task(
      "inspect",
      Inspect,
      yield* graph.input(Inspect.inputSchema)
    );
  })
);

test("a separately imported contract resolves its canonical implementation", async () => {
  const app = Application.make({
    tasks: [InspectReleaseLive],
    workflows: [Flow],
  });
  const registry = await Effect.runPromise(
    Application.Registry.pipe(Effect.provide(app.layer))
  );
  expect(registry.workflows.has("consumer")).toBe(true);
  expect(InspectReleaseLive.spec).toBe(Inspect.spec);
});

test("structurally equal replacement contracts are rejected", async () => {
  const other = Task.make({ ...Inspect.spec }, () =>
    Effect.succeed({ notes: "x", version: "x" })
  );
  const app = Application.make({ tasks: [other], workflows: [Flow] });
  await expect(
    Effect.runPromise(Effect.scoped(Layer.build(app.layer)))
  ).rejects.toThrow("noncanonical");
});

const MixedInput = Schema.Struct({
  mode: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("remote"), url: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("local"), path: Schema.String }),
  ]),
  optional: Schema.optionalKey(Schema.String),
  values: Schema.Array(Schema.String),
});
const Mixed = Task.make(
  {
    error: Schema.Never,
    id: "mixed",
    input: MixedInput,
    replay: "manual",
    success: Schema.String,
    version: 1,
  },
  () => Effect.succeed("ok")
);

export const inputTypeFixtures = Effect.gen(function* () {
  const graph = yield* Workflow.Builder;
  const release = yield* graph.task("release", Inspect, { repository: "a/b" });
  const version = Ref.field(release, "version");
  yield* graph.task("valid", Mixed, {
    mode: { kind: "remote", url: version },
    values: [version, "literal"],
  });
  yield* graph.task("bad-union", Mixed, {
    // @ts-expect-error The remote branch cannot contain a local-only field.
    mode: { kind: "remote", path: "x" },
    values: [],
  });
  yield* graph.task("bad-optional", Mixed, {
    mode: { kind: "local", path: "x" },
    // @ts-expect-error Optional does not mean untyped.
    optional: 1,
    values: [],
  });
  yield* graph.task("bad-array", Mixed, {
    mode: { kind: "local", path: "x" },
    // @ts-expect-error Arrays preserve their element type.
    values: [1],
  });
  yield* graph.map(
    "bad-map",
    { input: release, success: Schema.String },
    // @ts-expect-error Map output is fixed by its declared codec.
    () => 123
  );
});

test("codec transformations preserve decoded handler values and wire values", async () => {
  const TaskWithCodec = Task.make(
    {
      error: Schema.Never,
      id: "codec",
      input: Schema.FiniteFromString,
      replay: "manual",
      success: Schema.FiniteFromString,
      version: 1,
    },
    (value) => Effect.succeed(value + 1)
  );
  const result = await Effect.runPromise(
    Task.test(TaskWithCodec, { input: 41 })
  );
  expect(result.value).toBe(42);
  expect(Schema.encodeSync(TaskWithCodec.successSchema)(result.value)).toBe(
    "42"
  );
});
