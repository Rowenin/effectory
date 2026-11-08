import {
  Extension,
  Task,
  Workflow,
  WorkflowPatch,
} from "@offtree/effectory-sdk";
import { Effect } from "effect";

import {
  Inspect,
  Publish,
  ReleaseClient,
  ReleaseContracts,
} from "./contracts.ts";

const InspectLive = Task.make(Inspect.spec, ({ repository }) =>
  Effect.map(ReleaseClient, (client) => `${client.prefix}/${repository}`)
);
const PublishLive = Task.implementation(
  { id: "example/release-tools/publish", target: Publish },
  (value) => Effect.succeed(`published:${value}`)
);
const Review = WorkflowPatch.make(
  { id: "example/release-tools/review", target: Publish },
  (input) =>
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      yield* graph.approval("review", {
        context: input,
        prompt: "Publish this release?",
        timeout: "1 hour",
      });
    })
);
export const ReleaseTools = Extension.make({
  id: ReleaseContracts.id,
  implementations: [PublishLive],
  patches: [Review],
  tasks: { Inspect: InspectLive },
  version: ReleaseContracts.version,
});
