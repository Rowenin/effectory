import { Agent, Process } from "@effectory/activities";
import { Task } from "@effectory/sdk";
import { Effect, Schema } from "effect";

export const Severity = Schema.Literals(["low", "medium", "high", "critical"]);
const severities = Severity.literals;

// Optional fields are NullOr: Codex requires every property to be present.
export const Finding = Schema.Struct({
  description: Schema.String,
  file: Schema.String,
  line: Schema.NullOr(Schema.Int),
  severity: Severity,
  suggestion: Schema.NullOr(Schema.String),
});
const Findings = Schema.Struct({ findings: Schema.Array(Finding) });

export const Review = Schema.Struct({
  findings: Schema.Array(Finding),
  highestSeverity: Schema.Literals(["none", ...severities]),
  verdict: Schema.Literals(["pass", "fail"]),
});

export const ReleaseNote = Schema.Struct({
  breaking: Schema.Boolean,
  headline: Schema.String,
  migration: Schema.NullOr(Schema.String),
});

/** The branch's changes against its merge base. */
export const diff = Task.make({
  error: Process.Failure,
  input: Schema.Struct({ base: Schema.String, repo: Schema.String }),
  name: "git.diff",
  run: ({ base, repo }) =>
    Process.exec({
      args: ["diff", `${base}...HEAD`],
      command: "git",
      cwd: repo,
      maxOutputBytes: 512 * 1024,
    }).pipe(Effect.map((result) => result.stdout)),
  success: Schema.String,
});

/** One reviewer looking through one lens. */
export const reviewAs = Task.make({
  error: Agent.Failure,
  input: Schema.Struct({ diff: Schema.String, lens: Schema.String }),
  name: "review-as",
  run: ({ diff: changes, lens }) =>
    Agent.generate({
      prompt: `Review this change for ${lens} problems only. Report each finding with its severity, file, and line when known.\n\n${changes}`,
      schema: Findings,
    }).pipe(Effect.map((result) => result.value.findings)),
  success: Schema.Array(Finding),
});

const rank = (severity: typeof Severity.Type) => severities.indexOf(severity);

/** Merge each reviewer's findings and judge them against `failOn`. Pure. */
export const decide = ({
  failOn,
  reviews,
}: {
  readonly failOn: typeof Severity.Type;
  readonly reviews: readonly (readonly (typeof Finding.Type)[])[];
}): typeof Review.Type => {
  const findings = reviews.flat();
  const [highest] = findings
    .map((finding) => finding.severity)
    .toSorted((a, b) => rank(b) - rank(a));
  return {
    findings,
    highestSeverity: highest ?? "none",
    verdict:
      highest !== undefined && rank(highest) >= rank(failOn) ? "fail" : "pass",
  };
};

export const releaseNote = Task.make({
  error: Agent.Failure,
  input: Schema.Struct({ diff: Schema.String }),
  name: "release-note",
  run: ({ diff: changes }) =>
    Agent.generate({
      prompt: `Write a release note for this change.\n\n${changes}`,
      schema: ReleaseNote,
    }).pipe(Effect.map((result) => result.value)),
  success: ReleaseNote,
});
