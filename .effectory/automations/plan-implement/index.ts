import { Workflow } from "@effectory/sdk";
import { Schema } from "effect";

import implement from "../implement/index.ts";
import { Implementation } from "../shared/implement.ts";
import { ReviewedPlan, instructions, refinePlan, remove } from "./tasks.ts";

export default Workflow.make("plan-implement", {
  description:
    "Plan a change, have a second agent review the plan up to three times, wait for approval, then run the implement workflow.",
  input: Schema.Struct({
    repo: Schema.String,
    request: Schema.String,
    requestId: Schema.String,
  }),
  key: ($) => $.input.requestId,
}).pipe(
  Workflow.step("plan", refinePlan, ($) => ({
    repo: $.input.repo,
    request: $.input.request,
    rounds: 3,
  })),
  Workflow.publish("plan", ReviewedPlan, ($) => $.steps.plan),
  Workflow.approve("approve-plan", {
    review: ($) => $.steps.plan,
    title: "Implement this plan?",
  }),
  Workflow.step("remove", remove, ($) => ({
    paths: $.steps.plan.plan.deletions,
    repo: $.input.repo,
  })),
  Workflow.compute("instructions", instructions, ($) => ({
    plan: $.steps.plan.plan,
    request: $.input.request,
  })),
  Workflow.call("implement", implement, ($) => ({
    repo: $.input.repo,
    request: $.steps.instructions,
    requestId: $.input.requestId,
  })),
  Workflow.returns(
    Schema.Struct({ implementation: Implementation, plan: ReviewedPlan }),
    ($) => ({ implementation: $.steps.implement, plan: $.steps.plan })
  )
);
