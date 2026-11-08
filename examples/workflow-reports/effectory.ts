import { Application, Report, Task, Workflow } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

const Inspect = Task.make(
  {
    error: Schema.Never,
    id: "inspect",
    input: Schema.String,
    replay: "idempotent",
    success: Schema.String,
    version: 1,
  },
  (region) => Effect.succeed(`${region}: healthy`)
);
const Region = Workflow.make(
  {
    error: Schema.Never,
    id: "region",
    input: Schema.String,
    success: Schema.String,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    return yield* graph.task(
      "inspect",
      Inspect,
      yield* graph.input(Schema.String)
    );
  })
);
const Summary = Task.make(
  {
    error: Schema.Never,
    id: "region-summary",
    input: Report.sourceOf(Region),
    replay: "idempotent",
    success: Report.result(Schema.String),
    version: 1,
  },
  () =>
    Effect.gen(function* () {
      const history = yield* Report.History;
      const outcome = yield* history.outcome(Region);
      const text = outcome._tag === "Succeeded" ? outcome.value : outcome._tag;
      return { data: text, markdown: `# Region\n\n${text}\n` };
    })
);
const Deployment = Workflow.make(
  {
    error: Schema.Never,
    id: "deployment",
    input: Schema.String,
    success: Schema.String,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const region = yield* graph.workflow(
      "region",
      Region,
      yield* graph.input(Schema.String)
    );
    yield* graph.approval("review", {
      after: [region],
      prompt: "Review the region report",
      timeout: "1 hour",
    });
    return region;
  })
);
export default Application.make({
  reports: [
    Report.make({
      id: "region-summary",
      scope: "invocation",
      target: Region,
      task: Summary,
    }),
  ],
  tasks: [Inspect, Summary],
  workflows: [Deployment],
}) satisfies Application.Application<never>;
