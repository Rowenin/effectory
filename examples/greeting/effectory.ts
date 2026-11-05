import { Application, Artifact, Ref, Task, Workflow } from "@effectory/core";
import { Effect, Schema } from "effect";

const Input = Schema.Struct({ name: Schema.String });
const Greeting = Artifact.make({
  fields: [["greeting"]],
  id: "example/greeting",
  schema: Schema.Struct({ greeting: Schema.String }),
  version: 1,
});
const greet = Task.make(
  {
    error: Schema.Never,
    id: "example/greet",
    input: Input,
    replay: "idempotent",
    success: Schema.String,
    version: 1,
  },
  ({ name }) => Effect.succeed(`Hello ${name}`)
);
const publish = Task.make(
  {
    error: Schema.Never,
    id: "example/publish",
    input: Schema.String,
    outputs: { greeting: Greeting },
    replay: "idempotent",
    success: Greeting.refSchema,
    version: 1,
  },
  (greeting, context) =>
    context.publish(
      "greeting",
      { greeting },
      { key: "main", tags: { source: "example" } }
    )
);
const welcome = Workflow.make(
  {
    error: Schema.Never,
    id: "example/welcome",
    input: Input,
    success: Greeting.refSchema,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const input = yield* graph.input(Input);
    const greeting = yield* graph.task("greet", greet, {
      name: Ref.field(input, "name"),
    });
    const approval = yield* graph.approval("review", {
      after: [greeting],
      context: { greeting },
      prompt: "Publish this greeting?",
      timeout: "1 hour",
    });
    return yield* graph.task("publish", publish, greeting, {
      after: [approval],
    });
  })
);

export default Application.make({
  tasks: [greet, publish],
  workflows: [welcome],
});
