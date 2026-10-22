import { Artifacts, Automation, Task } from "@effectory/sdk";
import { Effect, Schema } from "effect";

import { HealthInput, observe, Summary } from "../health-check/definition.ts";
import { reportPath, writeReport } from "./action.ts";

const ActionPlan = Schema.Struct({
  action: Schema.Struct({
    kind: Schema.Literal("write-local-health-report"),
    path: Schema.String,
    value: Summary,
  }),
  summary: Summary,
});
const Result = Schema.Struct({ actionPath: Schema.String, summary: Summary });
const publishReport = Task.make({
  error: Schema.String,
  input: ActionPlan.fields.action,
  name: "write-approved-report",
  run: (action) => writeReport(action.path, action.value),
  success: Schema.String,
});

export default Automation.define({
  description:
    "Review the exact health summary and local report action, then approve its idempotent publication.",
  error: Schema.String,
  execute: (input, runId) =>
    Effect.gen(function* implementation() {
      const summary = yield* observe(input);
      const artifacts = yield* Artifacts;
      const plan = {
        action: {
          kind: "write-local-health-report" as const,
          path: reportPath(artifacts.workspace, runId),
          value: summary,
        },
        summary,
      };
      yield* Automation.publish("action-plan", {
        schema: ActionPlan,
        value: plan,
      });
      yield* Automation.approve({
        key: "publish-report",
        review: plan,
        title: "Publish the reviewed health report locally",
      });
      const actionPath = yield* publishReport(plan.action);
      return { actionPath, summary };
    }),
  idempotencyKey: (input) => input.requestId,
  input: HealthInput,
  name: "approved-health-check",
  success: Result,
});
