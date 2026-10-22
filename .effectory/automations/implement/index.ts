import { Expr, Workflow } from "@effectory/sdk";
import { Schema } from "effect";

import { Implementation, implementUntilGreen } from "../shared/implement.ts";

export default Workflow.make("implement", {
  description:
    "Implement a change, then run tests and lint in parallel, feeding failures back to the agent up to three times. Failing checks need approval to finish.",
  input: Schema.Struct({
    repo: Schema.String,
    request: Schema.String,
    requestId: Schema.String,
  }),
  key: ($) => $.input.requestId,
}).pipe(
  Workflow.step("implement", implementUntilGreen, ($) => ({
    attempts: 3,
    instructions: $.input.request,
    repo: $.input.repo,
  })),
  Workflow.publish("implementation", Implementation, ($) => $.steps.implement),
  Workflow.approve("accept-failing-checks", {
    review: ($) => $.steps.implement,
    title: "Checks still fail after three attempts; accept anyway?",
    when: ($) => Expr.eq($.steps.implement.passed, false),
  }),
  Workflow.returns(Implementation, ($) => $.steps.implement)
);
