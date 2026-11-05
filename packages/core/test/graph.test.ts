// @effect-diagnostics missingEffectContext:off floatingEffect:off
import { expect, test } from "bun:test";

import { Effect, Exit, Schema } from "effect";

import { Application, Ref, Task, Workflow } from "../src/index.ts";

const Input = Schema.Struct({
  choice: Schema.Boolean,
  items: Schema.Array(Schema.Struct({ id: Schema.String })),
});
const echo = Task.make(
  {
    error: Schema.Never,
    id: "echo",
    input: Schema.String,
    replay: "idempotent",
    success: Schema.String,
    version: 1,
  },
  (value) => Effect.succeed(value)
);
const spec = {
  error: Schema.Never,
  id: "flow",
  input: Input,
  success: Schema.String,
  version: 1,
} as const;

test.each(["missing", "duplicate", "escaped"] as const)(
  "signal handles reject a %s await consumer",
  async (mode) => {
    const flow = Workflow.make(
      spec,
      Effect.gen(function* () {
        const graph = yield* Workflow.Builder;
        const receiver = yield* graph.registerSignal("completion", {
          schema: Schema.String,
          timeout: "1 minute",
        });
        if (mode === "duplicate") {
          yield* graph.awaitSignal("first", receiver);
          yield* graph.awaitSignal("second", receiver);
        }
        if (mode === "escaped") {
          const input = yield* graph.input(Input);
          yield* graph.branch("child", Ref.field(input, "choice"), {
            onFalse: Effect.succeed("no"),
            onTrue: Effect.gen(function* () {
              const child = yield* Workflow.Builder;
              return yield* child.awaitSignal("escaped", receiver);
            }),
            success: Schema.String,
          });
        }
        return "result";
      })
    );
    expect(Exit.isFailure(await Effect.runPromiseExit(flow.build))).toBe(true);
  }
);

test("branch graphs capture parent references while keeping sibling scopes separate", async () => {
  const workflow = Workflow.make(
    spec,
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      const input = yield* graph.input(Input);
      const value = yield* graph.task("parent", echo, "parent-value");
      return yield* graph.branch("choose", Ref.field(input, "choice"), {
        onFalse: Effect.gen(function* () {
          const branch = yield* Workflow.Builder;
          return yield* branch.task("same-name", echo, "false");
        }),
        onTrue: Effect.gen(function* () {
          const branch = yield* Workflow.Builder;
          return yield* branch.task("same-name", echo, value);
        }),
        success: Schema.String,
      });
    })
  );
  const graph = await Effect.runPromise(workflow.build);
  const node = graph.nodes.at(-1);
  expect(node?.kind).toBe("Branch");
  if (node?.kind === "Branch") {
    expect(node.onTrue.scope).not.toBe(node.onFalse.scope);
    expect(node.onTrue.captures.map((ref) => ref.nodeId)).toEqual(["parent"]);
  }
});

test("references escaping a branch are rejected even when their TypeScript types agree", async () => {
  let escaped: Ref.Ref<string> | undefined;
  const workflow = Workflow.make(
    spec,
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      const input = yield* graph.input(Input);
      yield* graph.branch("branch", Ref.field(input, "choice"), {
        onFalse: Effect.succeed("other"),
        onTrue: Effect.gen(function* () {
          const branch = yield* Workflow.Builder;
          escaped = yield* branch.task("child", echo, "child");
          return escaped;
        }),
        success: Schema.String,
      });
      if (!escaped) {
        return "unexpected";
      }
      return yield* graph.task("leaked", echo, escaped);
    })
  );
  expect(
    Exit.isFailure(await Effect.runPromise(Effect.exit(workflow.build)))
  ).toBe(true);
});

test("linked workflows are discovered and noncanonical task providers inside branches are rejected", async () => {
  const child = Workflow.make(
    { ...spec, id: "child", input: Schema.String },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      const input = yield* graph.input(Schema.String);
      return yield* graph.task("echo", echo, input);
    })
  );
  const parent = Workflow.make(
    spec,
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      return yield* graph.workflow("child", child, "value");
    })
  );
  const registry = await Effect.runPromise(
    Application.Registry.pipe(
      Effect.provide(
        Application.make({ tasks: [echo], workflows: [parent] }).layer
      )
    )
  );
  expect(registry.workflows.has("child")).toBe(true);
  const missing = Workflow.make(
    spec,
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      const input = yield* graph.input(Input);
      return yield* graph.branch("branch", Ref.field(input, "choice"), {
        onFalse: Effect.succeed("none"),
        onTrue: Effect.gen(function* () {
          const branch = yield* Workflow.Builder;
          return yield* branch.task("echo", echo, "value");
        }),
        success: Schema.String,
      });
    })
  );
  expect(
    Exit.isFailure(
      await Effect.runPromise(
        Effect.exit(
          Application.Registry.pipe(
            Effect.provide(
              Application.make({ tasks: [], workflows: [missing] }).layer
            )
          )
        )
      )
    )
  ).toBe(true);
});

export const graphTypeFixtures = Effect.gen(function* () {
  const graph = yield* Workflow.Builder;
  const input = yield* graph.input(Input);
  const retryTask = Task.make(
    {
      error: Schema.TaggedStruct("RateLimited", {}),
      id: "typed-retry",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.String,
      version: 1,
    },
    () => Effect.succeed("done")
  );
  yield* graph.task("invalid-retry-tag", retryTask, null, {
    retry: {
      attempts: 2,
      delay: "1 second",
      // @ts-expect-error Retry selection retains the task's declared domain error tags.
      when: ["UnknownError"],
    },
  });
  const receiver = yield* graph.registerSignal("typed-signal", {
    schema: Schema.Int,
    timeout: "1 minute",
  });
  const received = yield* graph.awaitSignal("typed-await", receiver);
  // @ts-expect-error Signal payload type is retained through the opaque handle.
  yield* graph.task("wrong-signal-type", echo, received);
  yield* graph.branch("invalid-result", Ref.field(input, "choice"), {
    onFalse: Effect.succeed("valid"),
    // @ts-expect-error Branch results must satisfy the explicitly selected success codec.
    onTrue: Effect.succeed(123),
    success: Schema.String,
  });
  // oxlint-disable-next-line unicorn/no-array-for-each -- This declares a durable graph operator.
  yield* graph.forEach(
    "items",
    Ref.field(input, "items"),
    {
      concurrency: 2,
      item: Schema.Struct({ id: Schema.String }),
      key: (item) => item.id,
      maxItems: 10,
      success: Schema.String,
    },
    (item) =>
      Effect.gen(function* () {
        const child = yield* Workflow.Builder;
        // @ts-expect-error Item reference retains its field types.
        yield* child.task("invalid", echo, { value: Ref.field(item, "id") });
        return yield* child.task("valid", echo, Ref.field(item, "id"));
      })
  );
});
