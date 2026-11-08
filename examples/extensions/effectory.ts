import { Application, Extension, Task, Workflow } from "@offtree/effectory-sdk";
import { Effect, Layer, Schema } from "effect";

import { Publish } from "./contracts.ts";
import { ReleaseTools } from "./effectory.extensions.ts";

const PublishDefault = Task.make(Publish.spec, (value) =>
  Effect.succeed(`default:${value}`)
);
const Release = Workflow.make(
  {
    error: Schema.Never,
    id: "example/release",
    input: ReleaseTools.tasks.Inspect.inputSchema,
    success: Schema.String,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const input = yield* graph.input(ReleaseTools.tasks.Inspect.inputSchema);
    const release = yield* graph.task(
      "inspect",
      ReleaseTools.tasks.Inspect,
      input
    );
    return yield* graph.task("publish", Publish, release);
  })
);

export default Application.make({
  extensions: [
    Extension.use(ReleaseTools, {
      implementations: ["example/release-tools/publish"],
      patches: [
        {
          at: ["publish"],
          id: "release-review",
          use: "example/release-tools/review",
          workflow: { id: Release.id, version: 1 },
        },
      ],
    }),
  ],
  tasks: [PublishDefault],
  workflows: [Release],
}).provide(
  Layer.succeed(ReleaseTools.exports.ReleaseClient, { prefix: "release" })
);
