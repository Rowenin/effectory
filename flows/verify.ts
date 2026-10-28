/**
 * Verify this repository with its own tools: typecheck, lint and tests run as
 * separate nodes, at most two at a time, each with a timeout. Tests get one
 * retry, since they spawn processes and can be flaky.
 */
import { Flow } from "@effectory/flow";
import { Data, Effect, Schema } from "effect";

import { Shell } from "./tools.ts";

export const CheckName = Schema.Literals(["typecheck", "lint", "test"]);

const commands = {
  lint: ["bun", ["run", "check"]],
  test: ["bun", ["test"]],
  typecheck: ["bun", ["run", "typecheck"]],
} as const satisfies Record<
  Schema.Schema.Type<typeof CheckName>,
  readonly [string, readonly string[]]
>;

export const CheckResult = Schema.Struct({
  exitCode: Schema.Finite,
  name: CheckName,
  passed: Schema.Boolean,
  /** The last lines of output, for the report. */
  tail: Schema.String,
});

/** Tests failed; failing (rather than reporting) lets the retry run them again. */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{
  readonly check: Schema.Schema.Type<typeof CheckName>;
  readonly tail: string;
}> {}

const tailOf = (output: string, lines = 15) =>
  output.trimEnd().split("\n").slice(-lines).join("\n");

export const Check = Flow.Task(
  "Check",
  {
    concurrency: 2,
    description: "Runs one of the repository's checks.",
    input: CheckName,
    labels: ["tools"],
    output: CheckResult,
    retry: { delay: "1 second", times: 1 },
    timeout: "5 minutes",
  },
  (name) =>
    Effect.succeed({
      run: Effect.gen(function* check() {
        const shell = yield* Shell;
        const [command, args] = commands[name];
        const { exitCode, output } = yield* shell.run(command, args);
        if (exitCode !== 0 && name === "test") {
          // Fail so the retry runs it again.
          return yield* new CheckFailed({ check: name, tail: tailOf(output) });
        }
        return { exitCode, name, passed: exitCode === 0, tail: tailOf(output) };
      }),
    })
);

export const Verify = Flow.Task(
  "Verify",
  {
    description:
      "Runs the given checks (typecheck, lint, test) and reports each result.",
    input: Schema.Array(CheckName),
    labels: ["tools", "entry"],
    output: Schema.Struct({
      checks: Schema.Array(CheckResult),
      passed: Schema.Boolean,
    }),
  },
  (names) =>
    Effect.gen(function* verify() {
      const checks = yield* Effect.forEach(names, (name) =>
        Flow.After(Check, name)
      );
      return {
        run: Effect.map(
          Effect.forEach(checks, (check) => check.output),
          (results) => ({
            checks: results,
            passed: results.every((result) => result.passed),
          })
        ),
      };
    })
);
