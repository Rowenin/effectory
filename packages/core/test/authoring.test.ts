// @effect-diagnostics missingEffectContext:off floatingEffect:off
// Negative type fixtures below intentionally violate context/usage rules.
import { describe, expect, test } from "bun:test";

import { Context, Effect, Layer, Schema } from "effect";

import { Application, Artifact, Ref, Task, Workflow } from "../src/index.ts";

class GreetingClient extends Context.Service<
  GreetingClient,
  {
    readonly greet: (name: string) => Effect.Effect<string>;
  }
>()("test/GreetingClient") {}

const Greeting = Artifact.make({
  id: "greeting",
  schema: Schema.String,
  version: 1,
});
const Input = Schema.Struct({ name: Schema.String });
const Greet = Task.make(
  {
    error: Schema.Never,
    id: "greet",
    input: Input,
    outputs: { greeting: Greeting },
    replay: "idempotent",
    success: Schema.String,
    version: 1,
  },
  (input, context) =>
    Effect.gen(function* () {
      const client = yield* GreetingClient;
      const result = yield* client.greet(input.name);
      yield* context.publish("greeting", result, { key: "result" });
      yield* context.publish("greeting", result, { key: "result" });
      return result;
    })
);

const ClientLive = Layer.succeed(GreetingClient, {
  greet: (name) => Effect.succeed(`Hello, ${name}`),
});

// Keep construction independent of Workflow.make to prove explicit input binding.
const construction = Effect.gen(function* () {
  const graph = yield* Workflow.Builder;
  const input = yield* graph.input(Input);
  return yield* graph.task("greeting", Greet, {
    name: Ref.field(input, "name"),
  });
});
const Welcome = Workflow.make(
  {
    error: Schema.Never,
    id: "welcome",
    input: Input,
    success: Schema.String,
    version: 1,
  },
  construction
);

describe("authoring boundaries", () => {
  test("inferred handler services are supplied through a Layer; publication deduplicates", async () => {
    const result = await Effect.runPromise(
      Task.test(Greet, { input: { name: "Ada" } }).pipe(
        Effect.provide(ClientLive)
      )
    );
    expect(result.value).toBe("Hello, Ada");
    expect(result.publications).toHaveLength(1);
    expect(result.publications[0]?.reference.schemaId).toBe("greeting");
  });

  test("builds dependencies without executing handlers", async () => {
    const graph = await Effect.runPromise(Welcome.build);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.dependencies).toEqual(["$input"]);
  });

  test("rejects an assignable but different input codec", async () => {
    const workflow = Workflow.make(
      {
        error: Schema.Never,
        id: "wrong-input",
        input: Input,
        success: Schema.String,
        version: 1,
      },
      Effect.gen(function* () {
        const graph = yield* Workflow.Builder;
        const input = yield* graph.input(
          Schema.Struct({ name: Schema.String })
        );
        return Ref.field(input, "name");
      })
    );
    await expect(Effect.runPromise(workflow.build)).rejects.toThrow(
      "Input codec does not match"
    );
  });

  test("rejects duplicate node identities", async () => {
    const workflow = Workflow.make(
      {
        error: Schema.Never,
        id: "duplicate",
        input: Input,
        success: Schema.String,
        version: 1,
      },
      Effect.gen(function* () {
        const graph = yield* Workflow.Builder;
        yield* graph.task("same", Greet, { name: "Ada" });
        return yield* graph.task("same", Greet, { name: "Grace" });
      })
    );
    await expect(Effect.runPromise(workflow.build)).rejects.toThrow(
      "Duplicate node"
    );
  });

  test("rejects a missing task provider", async () => {
    const app = Application.make({ tasks: [], workflows: [Welcome] });
    await expect(
      Effect.runPromise(Effect.scoped(Layer.build(app.layer)))
    ).rejects.toThrow("Missing or noncanonical");
  });

  test("application registers definitions with provided services", async () => {
    const app = Application.make({
      tasks: [Greet],
      workflows: [Welcome],
    }).provide(ClientLive);
    const registry = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Application.Registry;
      }).pipe(Effect.provide(app.layer))
    );
    expect(registry.tasks.has("greet")).toBe(true);
    expect(registry.workflows.has("welcome")).toBe(true);
  });
});

// Compile-only negative fixtures. These functions are deliberately never called.
export function typeFixtures() {
  // @ts-expect-error Service requirement cannot disappear before provision.
  Effect.runPromise(Task.test(Greet, { input: { name: "Ada" } }));
  // @ts-expect-error Required input field has the wrong type.
  Task.test(Greet, { input: { name: 123 } });
  Effect.runPromise(
    // @ts-expect-error Application still requires GreetingClient.
    Effect.scoped(Layer.build(Application.make({ tasks: [Greet] }).layer))
  );
  Task.make(
    {
      error: Schema.Never,
      id: "bad-return",
      input: Input,
      replay: "manual",
      success: Schema.String,
      version: 1,
    },
    // @ts-expect-error Spec fixes success; handler cannot widen it.
    () => Effect.succeed(123)
  );
  Task.make(
    {
      error: Schema.Never,
      id: "bad-output",
      input: Input,
      outputs: { greeting: Greeting },
      replay: "manual",
      success: Schema.String,
      version: 1,
    },
    (_input, context) =>
      Effect.gen(function* () {
        // @ts-expect-error Undeclared output name.
        yield* context.publish("other", "hello", { key: "result" });
        // @ts-expect-error Publication codec requires a string.
        yield* context.publish("greeting", 123, { key: "result" });
        return "hello";
      })
  );
  return Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    // @ts-expect-error Task input type must be inferred from the task contract.
    yield* graph.task("bad", Greet, { name: 1 });
    const input = yield* graph.input(Input);
    // @ts-expect-error Ref field selection is type checked.
    Ref.field(input, "unknown");
  });
}
