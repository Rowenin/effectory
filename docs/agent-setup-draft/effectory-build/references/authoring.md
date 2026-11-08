# A task, a dependency, and a durable workflow

This example uses the current SDK. Its greeting service is stateless and is supplied at application scope; resources that need a fresh invocation lifetime belong on `Task.provide` instead. The task is idempotent because this example only computes a string.

Create `effectory.ts`:

```ts
import { Application, Task, Workflow } from "@offtree/effectory-sdk";
import { Context, Effect, Layer, Schema } from "effect";

export class GreetingClient extends Context.Service<
  GreetingClient,
  {
    readonly greet: (name: string) => Effect.Effect<string>;
  }
>()("example/GreetingClient") {}

const Input = Schema.Struct({ name: Schema.String });
export const Greet = Task.make(
  {
    id: "hello/greet",
    version: 1,
    input: Input,
    success: Schema.String,
    error: Schema.Never,
    replay: "idempotent",
  },
  ({ name }) =>
    Effect.gen(function* () {
      const client = yield* GreetingClient;
      return yield* client.greet(name);
    })
);
export const Hello = Workflow.make(
  {
    id: "hello/run",
    version: 1,
    input: Input,
    success: Schema.String,
    error: Schema.Never,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const input = yield* graph.input(Input);
    return yield* graph.task("greet", Greet, input);
  })
);
const GreetingLive = Layer.succeed(GreetingClient, {
  greet: (name) => Effect.succeed(`Hello, ${name}`),
});
export default Application.make({ tasks: [Greet], workflows: [Hello] }).provide(
  GreetingLive
) satisfies Application.Application<never>;
```

Create `effectory.test.ts`:

```ts
import { expect, test } from "bun:test";

import { Task } from "@offtree/effectory-sdk";
import { Effect, Layer } from "effect";

import { Greet, GreetingClient, Hello } from "./effectory.ts";
test("the task uses its supplied service", async () => {
  const result = await Effect.runPromise(
    Task.test(Greet, { input: { name: "Ada" } }).pipe(
      Effect.provide(
        Layer.succeed(GreetingClient, {
          greet: (name) => Effect.succeed(`Test hello, ${name}`),
        })
      )
    )
  );
  expect(result.value).toBe("Test hello, Ada");
});
test("the workflow binds its input without running the task", async () => {
  const graph = await Effect.runPromise(Hello.build);
  expect(graph.nodes).toHaveLength(1);
  expect(graph.nodes[0]?.dependencies).toEqual(["$input"]);
});
```

Start a new project with the existing CLI and install the dependencies it pins, using the project's package manager. These commands are for a disposable example project:

```sh
effectory init ./hello
cd hello
bun install
# Add the application and test above; install TypeScript/Bun types if the project does not already provide them.
bun test
# Run the project's configured typecheck as well.
effectory daemon start
effectory workflow run hello/run --input '{"name":"Ada"}' --request-key greeting-1 --json
effectory daemon stop
```

The expected final run status is `Succeeded`, with result `Hello, Ada`. Reusing `greeting-1` repeats the same submission, so choose a new key for a deliberately new run. The test's supplied Layer returns `Test hello, Ada`, proving that the handler uses dependency injection.

The exported application uses `satisfies Application.Application<never>` to check that its ordinary service requirements are supplied. Projects using a host-provided service such as `Vault.LocalStore` must use their appropriate application requirement type rather than falsely asserting `never`.

The task test exercises the handler. The graph test checks construction; neither proves daemon persistence. The draft example was also run through the real CLI and daemon in a disposable repository, with workspace dependencies linked locally. This is not proof that a published SDK can be installed from a registry, nor a real agent-authoring evaluation.
