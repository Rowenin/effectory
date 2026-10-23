import { Approve, Assert, Output, Report, Workflow } from "@effectory/core";
import { Agent, Shell } from "@effectory/std";
import { Effect, Schema } from "effect";

export interface Check {
  readonly name: string;
  readonly exitCode: number;
  readonly output: string;
}

const rules =
  "You can read and edit files but cannot run commands. After you finish, the workflow runs `bun install`, then `bun run test` and `bun run check`. Do not commit. Finish with a short summary of what you changed.";

export const prompt = (request: string, failures: readonly Check[]) =>
  failures.length === 0
    ? `Make this change in the repository. ${rules}\n\n${request}`
    : `You made this change in the repository, but these checks fail. Fix the causes without weakening or skipping tests. ${rules}\n\n${request}\n\nFailing checks:\n${failures
        .map(
          (check) =>
            `## ${check.name} (exit ${check.exitCode})\n${check.output}`
        )
        .join("\n\n")}`;

const bun = (
  cwd: string,
  name: string,
  args: readonly string[],
  after: Output.Output<unknown>
) =>
  Shell(
    name,
    {
      args,
      command: "bun",
      cwd,
      maxOutputBytes: 8 * 1024 * 1024,
      tailChars: 8000,
      timeoutMs: 15 * 60_000,
    },
    { dependsOn: [after] }
  );

const toCheck = (name: string, result: typeof Shell.Result.Type): Check => ({
  exitCode: result.exitCode,
  name,
  output: `${result.stdout}${result.stderr}`,
});

/**
 * Implement a change with a write-capable agent, then install and run tests
 * and lint in parallel. Failing checks go back to the agent for up to
 * `attempts` turns; an attempt runs only when the previous one failed (later
 * attempts are skipped). Checks still failing after the last attempt need an
 * approval to finish.
 */
export const implement = Workflow.make(
  "implement",
  {
    description:
      "Implement a change, run install, tests, and lint, and feed failures back to the agent up to N times. Failing checks need approval.",
    input: Schema.Struct({
      attempts: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 1 }))
      ),
      repo: Schema.String,
      request: Schema.String,
    }),
    reports: [Report.summary],
    scope: ({ repo, request }) => `${repo}:${request.slice(0, 80)}`,
  },
  Effect.fn(function* implementChange({ attempts, repo, request }) {
    const rounds: Output.Output<readonly Check[] | undefined>[] = [];
    let failures: Output.Output<readonly Check[]> = Output.of<readonly Check[]>(
      []
    );
    let needed: Output.Output<boolean> | boolean = true;
    for (let attempt = 1; attempt <= (attempts ?? 3); attempt += 1) {
      const change = yield* Agent.Prompt(
        `implement-${attempt}`,
        {
          access: "workspace-write",
          cwd: repo,
          prompt: Output.map(failures, (previous) => prompt(request, previous)),
          timeoutMs: 60 * 60_000,
        },
        { when: needed }
      );
      const install = yield* bun(
        repo,
        `install-${attempt}`,
        ["install"],
        change
      );
      const test = yield* bun(
        repo,
        `test-${attempt}`,
        ["run", "test"],
        install
      );
      const lint = yield* bun(
        repo,
        `check-${attempt}`,
        ["run", "check"],
        install
      );
      const checks = Output.map(
        Output.all({ install, lint, test }),
        (results): readonly Check[] => [
          toCheck("install", results.install),
          toCheck("test", results.test),
          toCheck("check", results.lint),
        ]
      );
      failures = Output.map(checks, (values) =>
        values.filter((check) => check.exitCode !== 0)
      );
      needed = Output.map(failures, (values) => values.length > 0);
      rounds.push(Output.optional(checks));
    }
    // The last attempt that ran decides the outcome.
    const final = Output.map(Output.all(rounds), (values) =>
      values.findLast((value) => value !== undefined)
    );
    const passed = yield* Assert("checks-pass", {
      message: Output.map(final, (checks) =>
        checks === undefined
          ? "no attempt ran"
          : `failing: ${
              checks
                .filter((check) => check.exitCode !== 0)
                .map((check) => check.name)
                .join(", ") || "none"
            }`
      ),
      severity: "high",
      that: Output.map(
        final,
        (checks) => checks?.every((check) => check.exitCode === 0) ?? false
      ),
    });
    yield* Approve("accept-failing-checks", {
      review: final,
      title: "Checks still fail after the last attempt; accept anyway?",
      when: Output.map(passed, (value) => !value),
    });
    return { checks: final, passed };
  })
);
