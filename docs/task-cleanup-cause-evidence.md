# Task cleanup causes and retry classification

Status: internal correctness fix, verified 2026-11-07. No public API change. Typecheck and formatting/lint pass; the full repository suite passed **525 tests across 135 files, 4,411 assertions**, zero failures (1071.83 seconds). A 361-file source/config manifest captured early in the run remained unchanged through completion. Full output and the manifest/result are in `/tmp/effectory-task-cleanup-probe`. This does not resolve the separate revision-loader diagnostic limitation in [upgrade research](runtime-upgrade-research.md) or the harness validation follow-up below.

## Reproduction

A task declares a retryable `Transient` error and uses a task-local Layer. Its first handler entry fails with `Transient`; the Layer's finalizer also dies. Before the fix, the real persistent host retried the task, its second entry succeeded, and the run ended Succeeded. The cleanup defect was lost. Scratch evidence is in `/tmp/effectory-task-cleanup-probe/{probe.ts,before.log}`; it uses the real revision loader, host and installed persistent engine, with synthetic resources.

SDK probes isolated three boundaries: a handler's own finalizer, a failing Layer acquisition's cleanup, and successful Layer acquisition followed by failing handler/release. `Task.test` lost the defect in the first two cases; the runtime additionally lost it in the third.

The first correction preserved the mixed Cause through SDK validation and interpreter error mapping, but the real host still retried (`after.log`). The installed Effect 4.0.5 `Activity.make` uses `Effect.matchEffect` in `executeEncoded`; that typed-error match discards accompanying defects before persistence. A guard after Activity execution alone is too late.

## Correction

- Boundary error mapping visits each typed failure through ordinary Effect/Cause/Exit operations. It preserves the other reasons, including cleanup defects and interruption, and still validates errors and checks for secret output.
- Task-local Layer error classification retains the complete Cause rather than selecting one typed error.
- After attempt cleanup and secret sanitation, a Cause containing a defect is made entirely fatal: accompanying typed errors become defect diagnostics. Activity cannot encode it as an ordinary domain failure and authorize a retry.
- The retry decision only accepts typed failures without a defect or interruption. Root reconciliation and invocation outcome inspection also give defects precedence over accompanying typed errors.

The corrected persistent-host probe ended Failed, with one handler entry and one release (`after-activity.log`). An ordinary declared failure with successful cleanup still retries. This changes the erroneous successful outcome; it does not add a retry category or change author-declared retry settings.

## Checked-in regressions and limits

- `packages/core/test/task-failure-cause.test.ts`: handler cleanup, acquisition cleanup, release cleanup, plus a mixed secret-bearing declared error/defect. Both causes survive where valid; invalid secret output is refused and the defect text is scrubbed.
- `packages/platform-bun/test/task-cleanup.test.ts`: real host/SQLite execution for all three cleanup locations, no second handler or RetryScheduled event after a cleanup crash, and an ordinary-failure control that succeeds after retry. The test uses an in-process Catalog; the separate scratch probe covers bundling/loading.
- `packages/platform-bun/test/invocation-outcome.test.ts`: persisted mixed failures are reported as defects rather than domain failures.

Initial SDK regression assertions failed for the handler and acquisition cases. Two test-only mistakes were corrected: comparing an Option to its JSON presentation, and expecting an error code inside its pretty message. These were not production failures. Logs are retained in the scratch directory.

This is evidence about task-attempt failure handling, not cross-version compatibility, cancellation after SIGKILL, or a bound on stuck cleanup. The broader runtime lifecycle checks remain necessary. No test deadlines, retry budgets or runtime limits were increased.

## Follow-up found during verification

A separate scratch probe (`/tmp/effectory-task-cleanup-probe/layer-secret.ts`) reads a synthetic vault value while a task-local Layer acquires, then raises a declared error containing that value and a cleanup defect. `Task.test` retains the defect after this correction, but its returned Cause still contains the synthetic value in the declared error. The handler error validator never runs when Layer acquisition fails. The interpreter has a separate declared-error encoding/secret check; this probe tested only the harness and makes no claim about persisted leakage.

The [subsequent correction](task-finalization-boundary-evidence.md) moves validation outside the task-local Layers and covers values/errors that become recognizable as secrets only during finalization. Its focused regressions and separate **531-test full-suite run** pass. This follow-up was discovered after the 525-test run began; no source edits were made during that earlier run to address it.
