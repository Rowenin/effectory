import { Application, Tag, Task, Workflow } from "@offtree/effectory-sdk";
import { Effect, Option, Schema } from "effect";

const Team = Tag.make("team", Schema.NonEmptyString);
const Build = Tag.make("build", Schema.Int);
const Report = Task.make(
  {
    error: Schema.Never,
    id: "report",
    input: Schema.Null,
    replay: "idempotent",
    success: Schema.String,
    version: 1,
  },
  () =>
    Effect.gen(function* () {
      const team = Option.getOrElse(yield* Team.value(), () => "unassigned");
      const build = Option.getOrElse(yield* Build.value(), () => 0);
      return `${team}: build ${build}`;
    })
);
const Reporting = Workflow.make(
  {
    error: Schema.Never,
    id: "reporting",
    input: Schema.Null,
    success: Schema.String,
    tags: [Team("platform"), Build],
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    return yield* graph.task("report", Report, null);
  })
);
export default Application.make({
  tasks: [Report],
  workflows: [Reporting],
}) satisfies Application.Application<never>;
