import { Agent, Process } from "@effectory/activities";
import { Task } from "@effectory/sdk";
import { Effect, Schema } from "effect";

export const Plan = Schema.Struct({
  // Repository-relative paths the workflow removes before implementation.
  deletions: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
  steps: Schema.Array(Schema.String),
  summary: Schema.String,
});

export const Critique = Schema.Struct({
  issues: Schema.Array(Schema.String),
  verdict: Schema.Literals(["approve", "revise"]),
});

export const ReviewedPlan = Schema.Struct({
  approved: Schema.Boolean,
  plan: Plan,
  reviews: Schema.Array(Critique),
});

const Request = Schema.Struct({ repo: Schema.String, request: Schema.String });

// How the workflow carries out a plan, so plans fit what can actually run.
const execution = [
  "How the plan is carried out:",
  "1. The workflow runs `git rm -r` on every path in `deletions`.",
  "2. An agent makes the steps. It can read and edit files but cannot run commands, so steps must not depend on running anything.",
  "3. The workflow runs `bun install`, then `bun run test` and `bun run check`, and gives failures back to the agent to fix.",
  "Changes stay uncommitted for a person to review: never plan commits, tags, or pushes.",
  "Where the request is ambiguous, choose the reading most consistent with it and record the choice in `risks`; do not leave decisions open.",
].join("\n");

const render = (plan: typeof Plan.Type) =>
  [
    plan.summary,
    "",
    "Deletions:",
    ...plan.deletions.map((path) => `- ${path}`),
    "",
    "Steps:",
    ...plan.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Risks:",
    ...plan.risks.map((risk) => `- ${risk}`),
  ].join("\n");

export const draftPlan = Task.make({
  error: Agent.Failure,
  input: Request,
  name: "draft-plan",
  run: ({ repo, request }) =>
    Agent.generate({
      cwd: repo,
      prompt: `Read this repository and write an implementation plan for the request below. Give a short summary, the paths to delete, ordered concrete steps naming the files to edit, and the risks.\n\n${execution}\n\nRequest:\n${request}`,
      schema: Plan,
    }).pipe(Effect.map((result) => result.value)),
  success: Plan,
});

export const reviewPlan = Task.make({
  error: Agent.Failure,
  input: Schema.Struct({ ...Request.fields, plan: Plan }),
  name: "review-plan",
  run: ({ plan, repo, request }) =>
    Agent.generate({
      cwd: repo,
      prompt: `You are reviewing another engineer's implementation plan against this repository. Check that it fully addresses the request, fits the existing code, names its tests, and can be carried out as described below. Approve it, or ask for a revision with each issue stated concretely.\n\n${execution}\n\nRequest:\n${request}\n\nPlan:\n${render(plan)}`,
      schema: Critique,
    }).pipe(Effect.map((result) => result.value)),
  success: Critique,
});

export const revisePlan = Task.make({
  error: Agent.Failure,
  input: Schema.Struct({
    ...Request.fields,
    issues: Schema.Array(Schema.String),
    plan: Plan,
  }),
  name: "revise-plan",
  run: ({ issues, plan, repo, request }) =>
    Agent.generate({
      cwd: repo,
      prompt: `Revise this implementation plan to resolve every review issue.\n\n${execution}\n\nRequest:\n${request}\n\nPlan:\n${render(plan)}\n\nIssues:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
      schema: Plan,
    }).pipe(Effect.map((result) => result.value)),
  success: Plan,
});

/**
 * Draft a plan, then review it up to `rounds` times, revising after each
 * review that asks for changes. The last review is never followed by an
 * unreviewed revision. Composite: child keys come from the round number.
 */
export const refinePlan = Task.make({
  error: Agent.Failure,
  input: Schema.Struct({ ...Request.fields, rounds: Schema.Int }),
  name: "refine-plan",
  run: ({ repo, request, rounds }) =>
    Effect.gen(function* refine() {
      let plan = yield* draftPlan({ repo, request });
      const reviews: (typeof Critique.Type)[] = [];
      for (let round = 1; round <= rounds; round += 1) {
        const review = yield* reviewPlan(
          { plan, repo, request },
          { key: String(round) }
        );
        reviews.push(review);
        if (review.verdict === "approve") {
          return { approved: true, plan, reviews };
        }
        if (round < rounds) {
          plan = yield* revisePlan(
            { issues: review.issues, plan, repo, request },
            { key: String(round) }
          );
        }
      }
      return { approved: false, plan, reviews };
    }),
  success: ReviewedPlan,
});

/** Remove the plan's deletions from the working tree and the index. */
export const remove = Task.make({
  error: Process.Failure,
  input: Schema.Struct({
    paths: Schema.Array(Schema.String),
    repo: Schema.String,
  }),
  name: "remove-paths",
  run: ({ paths, repo }) =>
    paths.length === 0
      ? Effect.succeed(paths)
      : Process.exec({
          args: ["rm", "-r", "--quiet", "--", ...paths],
          command: "git",
          cwd: repo,
        }).pipe(Effect.as(paths)),
  success: Schema.Array(Schema.String),
});

/** The implementer's instructions for an approved plan. Pure. */
export const instructions = ({
  plan,
  request,
}: {
  readonly plan: typeof Plan.Type;
  readonly request: string;
}) =>
  `Implement this approved plan. Its deletions are already done. Follow its steps in order and add the tests it names.\n\nRequest:\n${request}\n\nPlan:\n${render(plan)}`;
