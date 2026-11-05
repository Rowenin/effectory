import { Application, Task, Workflow, WorkflowSchedule } from "@effectory/core";
import { Effect, Schema } from "effect";

const Input = Schema.Struct({ name: Schema.String });
const Greeting = Schema.Struct({
  message: Schema.String,
  occurrence: Schema.NullOr(WorkflowSchedule.Occurrence),
});
const Greet = Task.make(
  {
    error: Schema.Never,
    id: "scheduled/greet",
    input: Input,
    replay: "idempotent",
    success: Greeting,
    version: 1,
  },
  ({ name }, context) =>
    Effect.succeed({
      message: `Hello ${name}`,
      occurrence: context.occurrence ?? null,
    })
);
const Welcome = Workflow.make(
  {
    error: Schema.Never,
    id: "scheduled/welcome",
    input: Input,
    success: Greeting,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const input = yield* graph.input(Input);
    const greeting = yield* graph.task("greet", Greet, input);
    const review = yield* graph.approval("review", {
      after: [greeting],
      context: { greeting },
      prompt: "Accept this scheduled greeting?",
      timeout: "1 hour",
    });
    // The same occurrence is available after a durable wait or daemon restart.
    return yield* graph.task("confirmed", Greet, input, { after: [review] });
  })
);
const EveryMinute = WorkflowSchedule.make({
  catchUp: "skip",
  cron: "* * * * *",
  id: "minute-greeting",
  input: { name: "Ada" },
  timeZone: "UTC",
  workflow: Welcome,
});
export default Application.make({ schedules: [EveryMinute], tasks: [Greet] });
