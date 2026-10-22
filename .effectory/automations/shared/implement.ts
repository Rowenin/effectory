import { Agent, Process } from "@effectory/activities";
import { Task } from "@effectory/sdk";
import { Effect, Schema } from "effect";

export const Check = Schema.Struct({
  exitCode: Schema.Int,
  output: Schema.String,
  passed: Schema.Boolean,
  script: Schema.String,
});

export const Attempt = Schema.Struct({
  checks: Schema.Array(Check),
  summary: Schema.String,
});

export const Implementation = Schema.Struct({
  attempts: Schema.Array(Attempt),
  passed: Schema.Boolean,
});

const outputLimit = 8000;

/** Run bun in the repository. A nonzero exit is a result, not an error. */
const bun = (repo: string, args: readonly string[], script: string) =>
  Process.exec({
    args,
    command: "bun",
    cwd: repo,
    maxOutputBytes: 4 * 1024 * 1024,
    timeoutMs: 15 * 60_000,
  }).pipe(
    Effect.map((result) => ({ ...result, passed: true })),
    Effect.catchIf(
      (failure): failure is Process.ProcessError =>
        failure._tag === "ProcessError" && failure.reason === "non-zero-exit",
      (failure) =>
        Effect.succeed({
          exitCode: failure.exitCode ?? 1,
          passed: false,
          stderr: failure.stderr,
          stdout: failure.stdout,
        })
    ),
    Effect.map((result) => ({
      exitCode: result.exitCode,
      output: `${result.stdout}${result.stderr}`.slice(-outputLimit),
      passed: result.passed,
      script,
    }))
  );

/** Run a package script. */
export const runScript = Task.make({
  error: Process.Failure,
  input: Schema.Struct({ repo: Schema.String, script: Schema.String }),
  name: "run-script",
  run: ({ repo, script }) => bun(repo, ["run", script], script),
  success: Check,
});

/** Install dependencies, updating the lockfile after removals. */
export const install = Task.make({
  error: Process.Failure,
  input: Schema.Struct({ repo: Schema.String }),
  name: "install",
  run: ({ repo }) => bun(repo, ["install"], "install"),
  success: Check,
});

const rules =
  "You can read and edit files but cannot run commands. After you finish, the workflow runs `bun install`, then `bun run test` and `bun run check`. Do not commit. Finish with a short summary of what you changed.";

/** One implementation turn; `failures` carries the previous attempt's checks. */
export const implement = Task.make({
  error: Agent.Failure,
  input: Schema.Struct({
    failures: Schema.Array(Check),
    instructions: Schema.String,
    repo: Schema.String,
  }),
  name: "implement",
  run: ({ failures, instructions, repo }) =>
    Agent.run({
      access: "workspace-write",
      cwd: repo,
      prompt:
        failures.length === 0
          ? `Make this change in the repository. ${rules}\n\n${instructions}`
          : `You made this change in the repository, but these checks fail. Fix the causes without weakening or skipping tests. ${rules}\n\n${instructions}\n\nFailing checks:\n${failures.map((check) => `## bun ${check.script} (exit ${check.exitCode})\n${check.output}`).join("\n\n")}`,
      timeoutMs: 60 * 60_000,
    }).pipe(Effect.map((result) => result.output)),
  success: Schema.String,
});

/**
 * Implement, install, then run tests and lint in parallel. Feed failing
 * checks back to the agent for up to `attempts` turns. Composite: child keys
 * come from the attempt number.
 */
export const implementUntilGreen = Task.make({
  error: Schema.Union([Agent.Failure, Process.Failure]),
  input: Schema.Struct({
    attempts: Schema.Int,
    instructions: Schema.String,
    repo: Schema.String,
  }),
  name: "implement-until-green",
  run: ({ attempts, instructions, repo }) =>
    Effect.gen(function* implementLoop() {
      const history: (typeof Attempt.Type)[] = [];
      let failures: readonly (typeof Check.Type)[] = [];
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const key = String(attempt);
        const summary = yield* implement(
          { failures, instructions, repo },
          { key }
        );
        const installed = yield* install({ repo }, { key });
        const checks = installed.passed
          ? [
              installed,
              ...(yield* Effect.forEach(
                ["test", "check"],
                (script) =>
                  runScript({ repo, script }, { key: `${script}/${key}` }),
                { concurrency: "unbounded" }
              )),
            ]
          : [installed];
        history.push({ checks, summary });
        failures = checks.filter((check) => !check.passed);
        if (failures.length === 0) {
          return { attempts: history, passed: true };
        }
      }
      return { attempts: history, passed: false };
    }),
  success: Implementation,
});
