import {
  Assert,
  Each,
  Lifetime,
  Node,
  Output,
  Report,
  Workflow,
} from "@effectory/core";
import { GitHub, Shell, Worktree } from "@effectory/std";
import { Effect, Schema } from "effect";

export const Severity = Schema.Literals(["low", "medium", "high"]);

/** A check to run in the checkout: a command with literal arguments. */
export const Check = Schema.Struct({
  args: Schema.Array(Schema.String),
  command: Schema.String,
  name: Schema.String,
  severity: Schema.optionalKey(Severity),
});

export const Repository = Schema.Struct({
  checks: Schema.Array(Check),
  /** A local clone whose `origin` serves `pull/<n>/head`. */
  clone: Schema.String,
  name: Schema.String,
  owner: Schema.String,
});

type CheckResult = typeof Shell.Result.Type & { readonly name: string };

export const renderSummary = (pr: number, results: readonly CheckResult[]) =>
  [
    `### Effectory checks for #${pr}`,
    "",
    "| Check | Result | Duration |",
    "| --- | --- | --- |",
    ...results.map(
      (result) =>
        `| ${result.name} | ${result.exitCode === 0 ? "passed" : `failed (exit ${result.exitCode})`} | ${Math.round(result.durationMs)} ms |`
    ),
  ].join("\n");

/**
 * Check out a pull request into a temporary worktree, run the repository's
 * checks, assert that each passed, and keep one summary comment on the PR up
 * to date.
 */
export const verifyPr = Workflow.make(
  "verify-pr",
  {
    description:
      "Check out a PR, run its checks, assert they pass, and post or update a summary comment.",
    input: Schema.Struct({
      comment: Schema.optionalKey(Schema.Boolean),
      pr: Schema.Int,
      repo: Repository,
    }),
    reports: [Report.summary, Assert.junitReport],
    scope: ({ pr, repo }) => `${repo.owner}/${repo.name}#${pr}`,
  },
  Effect.fn(function* verify({ comment, pr, repo }) {
    const checkout = yield* Worktree("checkout", {
      fetch: { remote: "origin" },
      ref: `pull/${pr}/head`,
      repo: repo.clone,
    }).pipe(Lifetime.run);
    const results = yield* Each("check", repo.checks, (check) =>
      Shell(check.name, {
        args: check.args,
        command: check.command,
        cwd: checkout.path,
        maxOutputBytes: 8 * 1024 * 1024,
        tailChars: 4000,
        timeoutMs: 30 * 60_000,
      })
    );
    yield* Each("passes", repo.checks, (check, index) =>
      Assert(check.name, {
        message: Output.map(
          results[index],
          (result) => `${check.name} exited ${result?.exitCode}`
        ),
        severity: check.severity ?? "high",
        that: Output.map(results[index], (result) => result?.exitCode === 0),
      })
    );
    const named = Output.map(Output.all(results), (values) =>
      values.map((value, index) => ({
        ...value,
        name: repo.checks[index]?.name ?? String(index),
      }))
    );
    yield* GitHub.PullRequestComment("summary", {
      body: Output.map(named, (values) => renderSummary(pr, values)),
      number: pr,
      owner: repo.owner,
      repo: repo.name,
    }).pipe(Node.when(comment ?? true));
    return { checks: named };
  })
);
