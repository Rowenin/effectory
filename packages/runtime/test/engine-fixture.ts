import { appendFileSync, existsSync } from "node:fs";
import nodePath from "node:path";

import { openEngine } from "@effectory/runtime/engine";
import type { RegisteredTask } from "@effectory/runtime/task";
import { Approval, Artifacts } from "@effectory/sdk";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";

import { writeReport } from "../../../.effectory/automations/approved-health-check/action.ts";

export const fixtureTask = (workspace: string): RegisteredTask => {
  const workflow = Workflow.make("EffectoryEngineProof", {
    error: Schema.String,
    idempotencyKey: () => "ignored-by-admission",
    payload: { approval: Schema.Boolean, hold: Schema.Boolean },
    success: Schema.String,
  });
  const implementation = workflow.toLayer((input, runId) =>
    Effect.gen(function* executeProof() {
      const first = yield* Activity.make({
        execute: Effect.sync(() => {
          appendFileSync(nodePath.join(workspace, "first.log"), `${runId}\n`);
          return "committed";
        }),
        name: "first",
        success: Schema.String,
      });
      // Reaching this activity proves the first Activity's engine reply has committed.
      yield* Activity.make({
        execute: Effect.gen(function* execute() {
          yield* Effect.sync(() =>
            appendFileSync(
              nodePath.join(workspace, "barrier.log"),
              `${runId}\n`
            )
          );
          while (
            input.hold &&
            !existsSync(nodePath.join(workspace, "release"))
          ) {
            yield* Effect.sleep("50 millis");
          }
        }),
        name: "barrier",
        success: Schema.Void,
      });
      const artifacts = yield* Artifacts;
      yield* artifacts
        .publish({ name: "plan", value: { first, runId } })
        .pipe(Effect.mapError(String));
      if (input.approval) {
        const approval = yield* Approval;
        const decision = yield* approval
          .request({
            key: "write",
            review: { first, runId },
            title: "Write local plan",
          })
          .pipe(Effect.mapError(String));
        if (decision.outcome !== "approved") {
          return yield* Effect.fail("Rejected");
        }
      }
      yield* Activity.make({
        error: Schema.String,
        execute: Effect.gen(function* execute() {
          const path = yield* writeReport(
            nodePath.join(workspace, `${runId}.json`),
            { first, runId }
          ).pipe(Effect.mapError(String));
          if (process.env.EFFECTORY_ENGINE_PROOF_HOLD_ACTION) {
            yield* Effect.sync(() =>
              appendFileSync(
                nodePath.join(workspace, "action.log"),
                `${runId}\n`
              )
            );
            return yield* Effect.never;
          }
          return path;
        }),
        name: "action",
        success: Schema.String,
      });
      return first;
    })
  );
  return {
    description: "Local persistent proof",
    directory: workspace,
    entrypoint: import.meta.path,
    fingerprint: { digest: "proof-v1", files: [] },
    implementation,
    inputSchema: Schema.toJsonSchemaDocument(workflow.payloadSchema),
    name: "proof",
    workflow: workflow as unknown as RegisteredTask["workflow"],
  };
};

if (import.meta.main) {
  const workspace = process.argv.at(2);
  if (!workspace) {
    throw new Error("Workspace argument required");
  }
  const engine = await openEngine({
    tasks: [fixtureTask(workspace)],
    workspace,
  });
  const run = await engine.submit({
    input: {
      approval: false,
      hold: !process.env.EFFECTORY_ENGINE_PROOF_HOLD_ACTION,
    },
    requestKey: "crash-proof",
    task: "proof",
  });
  console.log(JSON.stringify(run));
  setInterval(() => Date.now(), 1000);
}
