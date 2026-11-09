import { BunServices } from "@effect/platform-bun";
import { Application, Extension, Workflow } from "@offtree/effectory-sdk";
import { Layer, Effect, Schema } from "effect";

import {
  layer,
  makeTask,
  RunSession,
} from "../../extensions/agent-runner/src/contracts.ts";
import type { Options } from "../../extensions/agent-runner/src/contracts.ts";
import Agents from "../../extensions/agent-runner/src/extension.ts";

export const CodingSession = Workflow.make(
  {
    error: RunSession.errorSchema,
    id: "coding-session",
    input: RunSession.inputSchema,
    success: RunSession.successSchema,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const input = yield* graph.input(RunSession.inputSchema);
    return yield* graph.task("agent", RunSession, input);
  })
);

export const Review = makeTask({
  id: "code-review",
  output: Schema.Struct({
    approved: Schema.Boolean,
    findings: Schema.Array(Schema.String),
  }),
  version: 1,
});

/** Supply installed binary versions, explicit environments, and native policies. */
export function makeApplication<R = never, E = never>(options: Options<R, E>) {
  return Application.make({
    extensions: [Extension.use(Agents)],
    tasks: [Review],
    workflows: [CodingSession],
  }).provide(layer(options).pipe(Layer.provide(BunServices.layer)));
}
