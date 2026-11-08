# Verification assertions and JUnit — approved contract

Status: **user-approved, implemented and verified**, 2026-11-06. [Source review and a labelled signature probe](workflow-checks-research.md) supported the design; the [implementation evidence](workflow-checks-implementation.md) records tests against the actual SDK, host and CLI. No independent implementation review is claimed.

## Purpose

Tasks should be able to make explicit checks of real systems, retain their results across observation disconnects, and provide a JUnit document to CI. A failed deployment task is not automatically an assertion. Checks execute in ordinary tasks, with their declared Effect dependencies, retry policies, timeouts, vault protection and pinned revisions.

## Authoring surface

Add root exports and package subpaths `Checks` and `AssertionFailed`:

```ts
type Severity = "low" | "medium" | "high";

class AssertionFailed extends Schema.TaggedError<AssertionFailed>()(
  "AssertionFailed",
  { id: Schema.String, message: Schema.String, severity: SeveritySchema }
) {}

class Checks extends Context.Service<
  Checks,
  {
    readonly assert: <E, R>(
      id: string,
      predicate: Effect.Effect<boolean, E, R>,
      options: { readonly message: string; readonly severity?: Severity }
    ) => Effect.Effect<void, E | AssertionFailed | TaskRuntimeError, R>;
  }
>()("@offtree/effectory-sdk/Checks") {}
```

These are the approved signatures. The effect is lazy. Calling assert constructs an Effect and does not evaluate the predicate, validate options, write storage or throw. Boolean means exactly boolean; truthy numbers/strings are invalid. Scope requirements are preserved along with other predicate requirements. The service does not provide missing application dependencies.

Authoring example:

```ts
import { AssertionFailed, Checks, Task } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

const Verify = Task.make(
  {
    id: "deploy/verify",
    version: 1,
    input: Schema.Struct({ actual: Schema.Int, expected: Schema.Int }),
    success: Schema.Boolean,
    error: AssertionFailed,
    replay: "idempotent",
  },
  ({ actual, expected }) =>
    Effect.gen(function* () {
      const checks = yield* Checks;
      yield* checks.assert(
        "instance-count",
        Effect.succeed(actual === expected),
        {
          message: "Instance count must match the deployment target",
          severity: "high",
        }
      );
      return true;
    })
);
```

An external check passes an ordinary Effect, such as `client.healthy`, in place of Effect.succeed. Its error schemas must also be in the task's error schema. The enclosing workflow must accept propagated domain errors just as it does today. `retry.when: ["AssertionFailed"]` is permitted when declared; it repeats the task, not just the check. Multiple checks can be composed with Effect.gen or Effect.all. The first uncaught blocking failure retains ordinary fail-fast behavior; the service does not silently collect all failures.

There is no new graph node, separate check task spec, callback context field, expression language or registry of check definitions. A stable id is unique within one task entry. Fan-out and linked children already give each task a distinct invocation path, so they can reuse the same local check id. Reusing an id within an entry is InvalidBoundary, including a repeated sequential call; use distinct ids for loops. Ids follow the existing 200-character identifier grammar.

### Result and severity rules

- True records Passed and succeeds.
- False records Failed. Severity defaults to high. At or above the run's failOn threshold it fails with declared AssertionFailed; below the threshold it succeeds.
- A typed predicate error records Error, then propagates the same typed error. Predicate defects remain defects and interruption remains interruption. Severity never suppresses evaluation errors or interruption.
- No raw predicate error, Cause rendering, actual value or expected value is stored in a check. Error records use a fixed safe explanation. The caller's error still follows existing task error encoding and vault checks.
- A caller may catch AssertionFailed, as with any Effect error. Its Failed record remains a failed JUnit case. This can make a successful run have a failing XML report, deliberately.

Default threshold is low. Add `--fail-on low|medium|high` to both task run and workflow run, including background submissions. Add `checks?: { failOn?: Severity }` to WorkflowSchedule.make and Task.test options. Omission means low. Schedules validate synchronously and freeze their options. Changing the effective schedule threshold changes its admission behavior and therefore its generation; the same catch-up/reset consequences as other effective schedule changes apply. Explicit low and omission are equivalent.

The effective setting is stored once in the admitted run as `checks: { failOn }`, inherited by all linked children, task attempts and manual re-entries. Report runs inherit their source run's threshold but have their own check records and exports. Manual submission fingerprints include a nondefault threshold; omitted/default low keeps prior fingerprints unchanged. Request-key lookup precedes revision/default loading. Old stored runs read as low. The optional Run output field is absent on older daemons; new server-side reads load the actual stored setting strictly.

## Ownership, persistence and protection

The runner provides Checks inside Task.definition, before task-local Layers are acquired. All runner-owned requirement exclusions must include it, also through provide's RIn. One private binding per entry connects the SDK service to the host, without a public RuntimeContext method. Task.test uses the same binding/ownership path. The SDK module is shared with application and extension bundles.

Checks can execute during task-local Layer acquisition and the handler. They cannot start after invocation close or from Layer release. Handler-local ensuring/onExit remains inside the handler and can perform checks while that invocation is open. Layers that read Checks belong on Task.provide; application-level Layers do not have a run to check. Exported applications retain `satisfies Application.Application<...>` validation of outstanding author services.

The default service wins over an application-level value; an explicit Task.provide fake wins over the default and replaces both production recording and Task.test recording, matching existing invocation-service precedence. This is an intentional test/author override, not a security boundary. Standalone Effects must provide Checks themselves.

Reuse the invocation operation supervisor and its existing Layer-close placement. Register owned predicate evaluation before it can run. Caller interruption interrupts and awaits the owned evaluation. Closing marks the capability closed, rejects new calls with TaskRuntimeError/InvalidBoundary, interrupts and awaits existing evaluations and their cleanup before task-local resources release. No detached evaluation can write after its entry closes. Long finalizers retain the existing task shutdown semantics; no new guaranteed shutdown deadline is promised.

An inner Scope or Layer opened by a supervised predicate must not acquire ownership of the whole invocation. In particular, publishing inside such a Scope must not make its finalizer close and await the predicate itself. Preserve the active-operation ancestry used by the [existing owner correction](invocation-nested-scope-fix.md), including invalidating frames when their operation finishes. This is an internal integration requirement, not an additional author restriction.

Persist a small observation row before evaluating the predicate, keyed by `(runId, invocationPath, attempt, entry, checkId)`. Write the outcome before returning success/failure to the task. Check writes use the current entry/lease/fence checks, including the existing permission for live siblings during manual-recovery holds. No user Effect runs inside SQLite transactions. Record writes and exact entry validation occur on the host connection; native task Activities still own task results.

Running observations become Incomplete when their entry ends without a recorded result, including interruption or a lost owner. Restart reconciliation must not classify a still-owned live entry as Incomplete. A completion write cannot revive a superseded entry or a terminal run. New checks after a terminal fence fail. If a result cannot be persisted during normal completion, assert fails with TaskRuntimeError/Unavailable, taking precedence over a predicate's typed failure; it never reports successful verification with no durable record. Caller interruption remains interruption even if its cleanup cannot persist the final observation. The existing Running row is then reconciled to Incomplete rather than being treated as a successful check.

Check execution is not independently checkpointed. An idempotent task can repeat checks after process death; manual tasks still need recovery authorization. Entry identity distinguishes observations from those executions. Previously recorded Passed results do not suppress a predicate on re-entry, and no check grants permission to repeat external actions.

Use the task's tracker directly to scrub message text before every persistence boundary and before truncation/encoding. Reject a secret-bearing id with the existing SecretInOutput host error rather than rewriting its identity. No raw error text enters records or XML. Prefer static ids and messages. Existing documented vault limits still apply, including transformed values, short secrets, values not read through tracked vault access and values not yet known to the tracker when an earlier observation was written.

### Bounded storage

Limits: 1,000 checks per task entry, 10,000 observation rows and 16 MiB of reserved check-record JSON per run, counting all retries/re-entries; each record reserves at most 8 KiB. The caller message is at most 2,000 UTF-8 bytes. Full invocation paths are retained, so an unusually large path can exceed the record limit even with a short message. Reject before the predicate starts with LimitExceeded. Reserve outcome-field headroom in the transaction; no result is dropped to make room. Invalid options/duplicate ids use InvalidBoundary.

These are durable diagnostic records, not best-effort telemetry. They do not consume the log/progress budget. Store an AssertionFinished event with a bounded row identifier and status; live display resolves no arbitrary result payload. Diagnostic rows, like existing run history, remain until a separately approved run-retention feature exists. There is no repository-wide database quota in this slice.

## Reading and exporting

New capability: `run.checks.v1`. New RPC:

```ts
RunChecks({
  runId: string,
  attempts?: "latest" | "all", // default latest
  cursor?: string,
  limit?: number,               // 1..200, default 50
}) -> {
  items: readonly CheckRecord[],
  cursor: string | null,
  snapshot: number,
}
```

CheckRecord contains `runId`, `nodeId`, `taskId`, `attempt`, `entry`, `id`, `severity`, `message`, `status` (Running, Passed, Failed, Error, Incomplete), `startedAt`, nullable `finishedAt`, nullable nonnegative `durationMillis`, and a numeric insertion `sequence`. No task input/output/error details. Timestamps are canonical ISO strings. Durations use the local monotonic clock while an evaluation is live; an owner-lost Incomplete row has unknown duration, not a fabricated wall-clock interval.

`latest` selects the latest admitted attempt and entry per task invocation, then includes only its checks. It must use the attempt table rather than MAX over check rows: if a new attempt emitted no checks, checks from the prior attempt are not its results. `all` retains prior observations for diagnosis. Pages follow the stored first invocation position, then local insertion sequence. The invocation position stays private inside the storage index and opaque cursor. Pages use indexed seeks, a first-page insertion watermark, 200-row/2 MiB response bounds and principal-bound cursors. Inspect at most 256 candidate rows per page, advancing past excluded earlier entries; an empty page can have a continuation cursor. A row excluded by the response byte bound is revisited on the next page. States remain live while a run runs. Selection of latest entry also remains live; this is not a historical snapshot of a running run's result set. Terminal runs are stable after operation closure/reconciliation. No joins over native result payloads are needed.

Commands:

```sh
effectory run checks RUN_ID [--attempts latest|all] [--cursor CURSOR] [--limit N]
effectory run junit RUN_ID [--output results.xml]
effectory workflow run WORKFLOW_ID --junit [--output results.xml] [--fail-on high]
effectory task run TASK_ID --junit [--output results.xml] [--fail-on high]
```

RunChecks is inspection and keeps normal JSON output conventions. JUnit is an exporter, not another submission or companion report. It works after daemon restart from the stored run and check records. It does not wait for or include companion report runs; export those by their own run id.

Standalone run junit requires a terminal run. Nonterminal runs return Conflict/exit 5 without XML, pointing to run get/watch. Launch --junit retains current foreground behavior: timers/retries stay attached; an outside action or NeedsAttention returns exit 4, accepted run id and re-export instructions, with no XML yet. A terminal outcome exports instead of printing Run JSON. Remote observation failures keep accepted-run/resume hints; local Ctrl-C remains 130 and does not claim an exported document.

`--junit` conflicts with `--json` and `--background`; `--output` on a launch requires --junit. Validate these before admission. No automatic assertion-time admission parameter is inferred from an output flag. New flags/RPCs are capability-gated before submission; an old daemon gets the existing restart guidance and exit 3, not a silently ignored threshold.

### XML and exit semantics

Generate XML 1.0 with a testsuites root and deterministic task-invocation suites ordered by the stored first invocation position. Local check order is insertion sequence. Include exactly the latest attempt/entry observations; previous failed retries remain in run checks --attempts all, not duplicate current testcases. A check never reached is absent, not a fabricated skipped test.

Passed is a successful testcase; Failed is `<failure type="AssertionFailed">`; Error and Incomplete are `<error>` with fixed safe reasons. Record severity and attempt/entry as properties. Running is not permitted in a terminal export: reconciliation must finish first or export fails Unavailable. Include one separate synthetic run-outcome testcase: success for Succeeded, error for Failed/Rejected/TimedOut/Cancelled. This prevents a failed workflow with earlier successful checks from looking green. It is explicitly additional to Swamp's assertion-only output, and counts toward test totals.

All false checks remain failures in XML, including those below failOn or caught by author code. failOn controls task execution; it does not rewrite the truth of a check. CI's JUnit parser may therefore fail a job even when the command exits 0. The normal exit comes from the source run: 0 for Succeeded, 1 for other terminal outcomes. `run junit` follows this same convention. Zero actual checks emits a stderr warning; the XML contains only the run-outcome testcase. Do not silently label arbitrary task outcomes as assertions.

Escape XML metacharacters and replace scalar values forbidden by XML 1.0 with U+FFFD, including lone UTF-16 surrogates. Preserve valid astral Unicode. Encode tab, newline and carriage return in data as numeric character references so attribute normalization does not silently change messages. Make testcase names unambiguous with full invocation identity plus local id. No task data or raw Cause is included in system-out/system-err. XML duration is seconds; unknown duration is omitted. Test with a real XML parser, not substring checks alone.

The CLI fetches bounded pages into a scoped temporary file, verifies a completed document, then emits stdout or installs an output file. A read failure never emits an apparently complete truncated suite. An output file must not already exist: install without overwrite, using the established same-directory link/unlink pattern. Check a known existing destination before submission, but handle an install-time race too. A file-install/export failure preserves the accepted run id and leaves existing content untouched. Local write failures use the current CLI local-error mapping; do not change unrelated stdout behavior. XML is limited to 128 MiB; exceeding it is LimitExceeded/exit 5 without an installed document. No extra HTTP stream endpoint is needed for paged metadata export.

## Testing surface

Task.test automatically provides the service with the same validation, threshold and operation lifetime as production, records the current invocation's checks, and adds `checks` to its successful result. Its default failOn is low. Failure still uses the existing typed Effect error channel; no TestResult union is introduced. Authors can assert failure with Effect.result/exit. An explicitly supplied Checks Layer can capture records for specialized failure-path tests, and replaces default recording as documented above. Test records use deterministic identities/timestamps and do not claim to model crashes, restarts or multiple attempts.

## Required implementation proofs

1. Real exported types preserve predicate E/R (including Scope), reject nonboolean Effects and invalid severity, keep Task.make and task-local Layer errors declared, and remove only Checks from runner-owned requirements. App/extension service identity and ordinary override precedence are tested.
2. Real Task.test and daemon paths agree on true, false, thresholds, caught failures, evaluation errors, defects, duplicate ids, limits and secret scrubbing. Fake overrides are explicit. No environment fallback exists.
3. All predicates are lazy. Caller timeout/cancellation and invocation close interrupt and await owned evaluation before Layer cleanup; detached callers and partial/parallel Layer acquisition failure cannot leak a late writer. Interruption retains its cause and raw defects never enter check storage/XML.
4. Real SQLite/native-engine process kills before insertion, after insertion, after predicate result, after check completion and after native Activity completion. Re-entry never borrows a prior check's success. Manual recovery requires its original authorization. Reconciliation closes lost-owner rows safely.
5. Fan-out, branches, patches, direct task runs and linked child workflows have distinct invocation suites. Retries use latest admitted attempt/entry even when that entry recorded no checks. All-observation inspection still exposes earlier failures.
6. Cancel, deadline, rejection, host/domain failure and report-run cases. The synthetic run testcase prevents a false green XML document; no reporter execution or additional external action occurs during export.
7. Paging at 10,000 observations and 16 MiB; no large native outputs loaded; live-list semantics, principal isolation, cursor validation and deterministic terminal export. Oversized invocation paths fail before evaluating the check. Resource reservations do not grow on duplicate ids.
8. Real CLI launch/re-export, exit codes, approval/NeedsAttention, accepted-run hints, old-daemon preflight, restart and snapshot restore. Threshold fingerprint retry and schedule-generation rules are pinned.
9. Real XML parsing with invalid controls, astral Unicode, lone surrogates and escaping. Count consistency, latest-entry selection, severity/CI distinction and zero-check warning. Broken output, destination races, no overwrite, partial-page failure and temporary-file cleanup.
10. Full repository typecheck, formatting/lint and tests against a stable source manifest. Scratch stand-ins above are not implementation evidence.

## Approved decisions

Approve the service-based shape, declared AssertionFailed, and retained records rather than introducing a graph assertion language; run/schedule/test thresholds; latest-entry XML plus a synthetic run-outcome case; the explicit threshold-versus-CI distinction; completed-run export and file refusal behavior; and the stated storage/export limits. The user approved these choices; implementation is in progress.

Compared with Swamp, this uses Effect instead of CEL, refuses partial XML for suspended runs, preserves attempts separately, adds the run-outcome case and refuses overwriting files. It does not statically enumerate assertions in task describe, synthesize skipped cases for unreachable code, implement flaky-test XML extensions, or checkpoint/retry an individual assertion independently of its task. Those differences are disclosed, not claimed as parity already achieved.
