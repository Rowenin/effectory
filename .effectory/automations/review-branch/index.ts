import { Expr, Workflow } from "@effectory/sdk";
import { Schema } from "effect";

import {
  ReleaseNote,
  Review,
  decide,
  diff,
  releaseNote,
  reviewAs,
} from "./tasks.ts";

export default Workflow.make("review-branch", {
  description:
    "Review a branch with one agent reviewer per lens, gate on findings, and draft a release note.",
  input: Schema.Struct({
    base: Schema.String,
    repo: Schema.String,
    requestId: Schema.String,
  }),
  key: ($) => $.input.requestId,
}).pipe(
  Workflow.step("diff", diff, ($) => ({
    base: $.input.base,
    repo: $.input.repo,
  })),
  Workflow.each("review", ["correctness", "security"], reviewAs, ($, lens) => ({
    diff: $.steps.diff,
    lens,
  })),
  Workflow.compute("verdict", decide, ($) => ({
    failOn: "high",
    reviews: $.steps.review,
  })),
  Workflow.publish("review", Review, ($) => $.steps.verdict),
  Workflow.approve("accept-findings", {
    review: ($) => $.steps.verdict.findings,
    title: "Review found blocking findings; continue?",
    when: ($) => Expr.eq($.steps.verdict.verdict, "fail"),
  }),
  Workflow.step("release-note", releaseNote, ($) => ({
    diff: $.steps.diff,
  })),
  Workflow.returns(
    Schema.Struct({
      note: ReleaseNote,
      verdict: Schema.Literals(["pass", "fail"]),
    }),
    ($) => ({ note: $.steps["release-note"], verdict: $.steps.verdict.verdict })
  )
);
