import { Application, Report, Tag, Task } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

const Category = Tag.make("category", Schema.Literals(["summary", "audit"]));

const Inspect = Task.make(
  {
    error: Schema.Never,
    id: "inspect",
    input: Schema.Struct({ repository: Schema.String }),
    replay: "idempotent",
    success: Schema.Struct({
      healthy: Schema.Boolean,
      repository: Schema.String,
    }),
    version: 1,
  },
  ({ repository }) => Effect.succeed({ healthy: true, repository })
);

const Summarize = Task.make(
  {
    error: Schema.Never,
    id: "summarize",
    input: Report.sourceOf(Inspect),
    replay: "idempotent",
    success: Report.result(Schema.Struct({ healthy: Schema.Boolean })),
    version: 1,
  },
  () =>
    Effect.gen(function* () {
      const history = yield* Report.History;
      const outcome = yield* history.outcome(Inspect);
      const healthy = outcome._tag === "Succeeded" && outcome.value.healthy;
      return {
        data: { healthy },
        markdown: `# Repository check\n\nHealthy: ${healthy}\n`,
      };
    })
);

export default Application.make({
  reports: [
    Report.make({
      id: "inspection-summary",
      scope: "run",
      tags: [Category("summary")],
      target: Inspect,
      task: Summarize,
    }),
  ],
  tasks: [Inspect, Summarize],
}) satisfies Application.Application<never>;
