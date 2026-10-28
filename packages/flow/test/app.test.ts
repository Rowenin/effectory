import { describe, expect, test } from "bun:test";

import { Context, Effect, Layer, Option, Schema } from "effect";

import { Flow } from "../src/index.ts";

class Greeter extends Context.Service<
  Greeter,
  { readonly greet: (name: string) => string }
>()("test/Greeter") {}

const GreeterLive = Layer.succeed(Greeter)({
  greet: (name) => `hello ${name}`,
});

const Confirm = Flow.Input("Confirm", {
  description: "A person confirms the greeting.",
  input: Schema.String,
  labels: ["human"],
  output: Schema.Boolean,
});

const Greet = Flow.Task(
  "Greet",
  {
    description: "Greets someone by name.",
    input: Schema.String,
    labels: ["demo"],
    output: Schema.String,
  },
  (name) =>
    Effect.succeed({
      run: Effect.map(Greeter, (greeter) => greeter.greet(name)),
    })
);

const Announce = Flow.Task(
  "Announce",
  {
    description: "Greets, then announces once confirmed.",
    input: Schema.String,
    output: Schema.String,
  },
  (name) =>
    Effect.gen(function* announce() {
      const greeting = yield* Flow.After(Greet, name);
      const confirm = yield* Flow.Calls(Confirm);
      return {
        run: Effect.gen(function* announceRun() {
          const text = yield* greeting.output;
          return (yield* confirm(text)) ? `${text}!` : text;
        }),
      };
    })
);

const app = Flow.make({
  layer: GreeterLive,
  tasks: [Announce, Greet, Confirm],
});

const run = <A, E>(program: Effect.Effect<A, E, Flow.RunStore>) =>
  Effect.runPromise(program.pipe(Effect.provide(Flow.memoryStore)));

describe("Flow.make", () => {
  test("finds Tasks by name and searches names, descriptions and labels", () => {
    expect(app.tasks.map((task) => task.name)).toEqual([
      "Announce",
      "Greet",
      "Confirm",
    ]);
    expect(Option.map(app.get("Greet"), (task) => task.name)).toEqual(
      Option.some("Greet")
    );
    expect(app.get("Nope")).toEqual(Option.none());
    const names = (query: string) => app.search(query).map((task) => task.name);
    expect(names("greets")).toEqual(["Announce", "Greet"]);
    expect(names("PERSON")).toEqual(["Confirm"]);
    expect(names("human")).toEqual(["Confirm"]);
    expect(names("")).toEqual(["Announce", "Greet", "Confirm"]);
  });

  test("rejects two Tasks with the same name", () => {
    const Other = Flow.Task(
      "Greet",
      { input: Schema.String, output: Schema.String },
      (name) => Effect.succeed({ run: Effect.succeed(name) })
    );
    expect(() =>
      Flow.make({ layer: GreeterLive, tasks: [Greet, Other] })
    ).toThrow("Two Tasks are named Greet");
    // Listing the same Task twice is fine.
    expect(
      Flow.make({ layer: GreeterLive, tasks: [Greet, Greet] }).tasks
    ).toHaveLength(1);
  });

  test("the layer must provide every service the Tasks need", () => {
    // @ts-expect-error Greeter, needed by Greet through Announce, isn't provided
    Flow.make({ tasks: [Announce] });
    Flow.make({ layer: GreeterLive, tasks: [Announce] });
  });

  test("starts and resumes by name with JSON input, providing the layer", async () => {
    const result = await run(
      Effect.gen(function* program() {
        const first = yield* app.start("Announce", "dana");
        expect(first).toMatchObject({
          _tag: "Suspended",
          pending: [{ key: 'Confirm("hello dana")' }],
        });
        const second = yield* app.resume(first.runId, {
          'Confirm("hello dana")': true,
        });
        const runs = yield* app.runs;
        return { runs, second };
      })
    );
    expect(result.second).toMatchObject({
      _tag: "Succeeded",
      output: "hello dana!",
    });
    expect(result.runs.map((record) => [record.task, record.status])).toEqual([
      ["Announce", "succeeded"],
    ]);
  });

  test("plans by name and reports unknown Tasks and invalid input", async () => {
    const planned = await Effect.runPromise(app.plan("Announce", "dana"));
    expect(planned.root).toBe('Announce("dana")');

    const unknown = await Effect.runPromise(
      Effect.flip(app.plan("Nope", null))
    );
    expect(unknown).toMatchObject({ _tag: "AppError", reason: "unknown-task" });
    const invalid = await Effect.runPromise(Effect.flip(app.plan("Greet", 42)));
    expect(invalid).toMatchObject({
      _tag: "AppError",
      message: "Invalid input for Greet: Expected string",
      reason: "invalid-input",
    });
  });

  test("isApp recognises apps", () => {
    expect(Flow.isApp(app)).toBe(true);
    expect(Flow.isApp({ tasks: [] })).toBe(false);
  });
});
