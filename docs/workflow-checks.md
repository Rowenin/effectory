# Task checks and JUnit

A task can yield `Checks` to record explicit assertions about a system. The predicate is an ordinary Effect: its services, typed errors, Scope and interruption behavior remain visible to the caller.

```ts
import { AssertionFailed, Checks, Task } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

const Verify = Task.make(
  {
    id: "verify",
    version: 1,
    input: Schema.Struct({ actual: Schema.Int, expected: Schema.Int }),
    success: Schema.Boolean,
    error: AssertionFailed,
    replay: "idempotent",
  },
  ({ actual, expected }) =>
    Effect.gen(function* () {
      yield* (yield* Checks).assert(
        "instance-count",
        Effect.succeed(actual === expected),
        { message: "Instance count must match the deployment target" }
      );
      return true;
    })
);
```

`assert(id, predicate, { message, severity? })` is lazy. A true result records `Passed`; false records `Failed`. Severity defaults to `high`. The run's `failOn` threshold defaults to `low`, so every false assertion fails by default. Declare `AssertionFailed` in the task's error schema and in workflows that propagate it. Declare the predicate's other errors too. Catching an assertion error does not erase the failed observation.

Use an id that is unique within the task entry and follows the SDK's identifier grammar. Linked children and fan-out tasks have their own invocation identities. Duplicate ids fail with `InvalidBoundary`; use different ids in loops.

```sh
effectory task run verify --input '{"actual":2,"expected":3}' --fail-on high
effectory workflow run deploy --input-file deployment.json --junit --output results.xml
effectory run checks RUN_ID --attempts all
effectory run junit RUN_ID --output results.xml
```

Set a lower-severity diagnostic with `{ message: "…", severity: "low" }`. With `--fail-on high`, that false check records a failure but lets the task continue. The setting is captured in the admitted run, inherited by child tasks and report runs, and kept through retries and restart. Explicit `low` and omission are equivalent for request-key deduplication. Changing a schedule's effective threshold changes its generation, with the same catch-up reset as other schedule-definition changes:

```ts
WorkflowSchedule.make({
  id: "hourly-verification",
  workflow: VerifyWorkflow,
  input: {},
  cron: "0 * * * *",
  checks: { failOn: "high" },
});
```

A predicate's typed failure records `Error` and propagates that error. Defects remain defects; interruptions record `Incomplete`. Raw predicate causes are never copied into check records. Vault protection scrubs messages using the attempt's known secret values and rejects secret-bearing ids. Prefer static ids and messages; the existing vault protection limits still apply.

## Ownership and storage

The runner supplies Checks during task-local Layer setup and the handler. Handler-local cleanup can make checks; task Layer finalizers and captured services used after invocation close cannot. Detached evaluations are interrupted and awaited before task resources release. A nested Scope inside a predicate does not close its enclosing invocation.

Check storage uses the exact task attempt, entry and current lease. A completion that cannot be persisted fails the assertion with `TaskRuntimeError/Unavailable`; interruption stays interrupted. Restart marks abandoned Running records Incomplete. A new task entry evaluates its predicate again; an earlier Passed record is not a checkpoint. Manual replay still requires recovery authorization.

Limits are 1,000 checks per entry, 10,000 observations and 16 MiB of reserved record JSON per run, 8 KiB per reserved record, and 2,000 UTF-8 bytes per caller message. Retries and re-entries count toward the run budget. Limits fail before evaluation. Check records do not consume the telemetry budget and have no separate automatic retention policy.

## Inspection and CI

`run checks` returns bounded JSON pages. `--attempts latest` is the default and selects the latest admitted entry, even if it emitted no checks. `--attempts all` retains prior observations. Empty pages can have a continuation cursor; continue until the cursor is null. Pages follow stored invocation order, with local checks ordered by insertion `sequence`. Invocation positions remain internal. A running run's statuses and latest-entry selection remain live.

JUnit export requires a terminal run. It includes the latest entry's checks, grouped by task invocation, plus one synthetic run-outcome case. An unfinished run refuses standalone export with exit 5. A foreground `--junit` launch that reaches an approval or NeedsAttention returns exit 4, prints the accepted run id to stderr, and produces no XML. Export later with `run junit`.

Every false check produces a JUnit `<failure>`, even below `failOn` or when its error was caught. `Error` and `Incomplete` produce `<error>`. The synthetic outcome fails for Failed, Rejected, TimedOut and Cancelled runs, preventing a failed workflow from looking green because its earlier assertions passed. The command's exit code comes from the run: 0 for Succeeded, 1 for another terminal outcome. Consequently, CI can reject a JUnit report even when the command exited 0.

`--junit` conflicts with `--json` and `--background`; a launch's `--output` requires `--junit`. New features require the `run.checks.v1` capability before submission. Restart an older daemon before using them.

Without `--output`, XML replaces Run JSON on stdout; progress and warnings remain on stderr. With `--output`, the file must not exist. The CLI fetches every bounded page and completes a temporary document before emitting XML or installing the file without overwriting. Read/format failures leave no partial output document. The XML cap is 128 MiB. Invalid XML scalars are replaced; valid Unicode and whitespace are preserved. A zero-check run gets a stderr warning and its run-outcome case only.

Report runs have separate checks and exports; exporting their source does not run or wait for reporters.

## Tests and dependency injection

```ts
const verification = Effect.gen(function* () {
  const result = yield* Task.test(Verify, {
    input: { actual: 3, expected: 3 },
    checks: { failOn: "high" },
  });
  expect(result.checks[0]?.status).toBe("Passed");
});
```

The harness uses the production assertion and ownership path with deterministic record metadata. Failures keep Task.test's typed error channel; inspect them with `Effect.exit` or `Effect.result`. A `Checks` fake supplied through `Task.provide` replaces the recorder, as it replaces production storage. Application-level services do not override the runner's invocation service. A standalone Effect must provide Checks explicitly.

The [approved contract](workflow-checks-api-draft.md) and [verification record](workflow-checks-implementation.md) describe the boundaries and evidence in more detail.
