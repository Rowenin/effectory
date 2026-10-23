import {
  Approve,
  Assert,
  Each,
  Output,
  Report,
  Workflow,
} from "@effectory/core";
import { Agent, Shell } from "@effectory/std";
import { Effect, Schema } from "effect";

export const Finding = Schema.Struct({
  file: Schema.String,
  message: Schema.String,
  severity: Schema.Literals(["low", "medium", "high"]),
});

export const Findings = Schema.Struct({ findings: Schema.Array(Finding) });

/** One reviewer's structured findings for a diff. */
export const Review = Agent.structured("Review", Findings, {
  description: "Review a diff through one lens and report findings",
  fake: { findings: [] },
});

export const ReleaseNote = Agent.structured(
  "ReleaseNote",
  Schema.Struct({ summary: Schema.String, title: Schema.String }),
  {
    description: "Draft a release note for a diff",
    fake: { summary: "Fake release note.", title: "Fake change" },
  }
);

const lensPrompt = (lens: string, diff: string) =>
  `Review this diff for ${lens} problems only. Report each problem with the file, a one-sentence message, and a severity (high = must fix before merging). Report no findings when there are none.\n\n${diff}`;

/**
 * Review a branch with one agent per lens, assert there are no high-severity
 * findings, ask for approval when there are, and draft a release note.
 */
export const reviewBranch = Workflow.make(
  "review-branch",
  {
    description:
      "Review a branch with one agent reviewer per lens, gate on findings, and draft a release note.",
    input: Schema.Struct({
      base: Schema.String,
      lenses: Schema.optionalKey(Schema.Array(Schema.String)),
      repo: Schema.String,
    }),
    reports: [Report.summary],
    scope: ({ base, repo }) => `${repo}@${base}`,
  },
  Effect.fn(function* review({ base, lenses, repo }) {
    const diff = yield* Shell("diff", {
      args: ["diff", `${base}...HEAD`],
      command: "git",
      cwd: repo,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    const reviews = yield* Each(
      "review",
      lenses ?? ["correctness", "security"],
      (lens) =>
        Review(lens, {
          access: "read-only",
          cwd: repo,
          prompt: Output.map(diff, (result) => lensPrompt(lens, result.stdout)),
        })
    );
    const findings = Output.map(Output.all(reviews), (values) =>
      values.flatMap((value) => value.value.findings)
    );
    const blocking = Output.map(findings, (values) =>
      values.filter((finding) => finding.severity === "high")
    );
    const clean = yield* Assert("no-blocking-findings", {
      message: Output.map(
        blocking,
        (values) => `${values.length} high-severity finding(s)`
      ),
      severity: "high",
      that: Output.map(blocking, (values) => values.length === 0),
    });
    const accepted = yield* Approve("accept-findings", {
      review: blocking,
      title: "Review found blocking findings; continue anyway?",
      when: Output.map(clean, (passed) => !passed),
    });
    // Waits for the approval; when the review is clean the approval skips
    // itself and the note runs, and a rejection fails it and skips the note.
    const note = yield* ReleaseNote(
      "release-note",
      {
        access: "read-only",
        cwd: repo,
        prompt: Output.map(
          diff,
          (result) =>
            `Write a release note (title and two-sentence summary) for this diff.\n\n${result.stdout}`
        ),
      },
      { dependsOn: [accepted] }
    );
    return { findings, note: Output.map(note, (result) => result.value) };
  })
);
