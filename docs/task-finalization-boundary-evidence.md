# Task validation after Layer finalization

Status: internal correction verified, 2026-11-07. Typecheck and formatting/lint pass; the full suite passed **531 tests across 137 files, 4,454 assertions**, zero failures (1040.90 seconds). The pre-verification 363-file source/config manifest stayed unchanged through completion. No public API change. This addresses the harness gap found during [cleanup cause verification](task-cleanup-cause-evidence.md).

## Failed-before cases

Five checked-in regressions failed before the correction:

1. A task-local Layer reads a synthetic vault secret and fails with a declared error containing it before the handler starts.
2. The same acquisition failure also has a cleanup defect containing the secret.
3. A handler returns a value that is first registered as a secret by its Layer's finalizer.
4. A handler fails with a declared error containing a value first registered by its Layer's finalizer.
5. A Layer acquisition raises a TaskRuntimeError whose message contains the value it just read.

`Task.test` previously exposed the declared errors or result in cases 1–4 and the runtime-error message in case 5. Handler-local validation could not cover setup failure or knowledge acquired later during cleanup. The production interpreter had additional checks after `task.execute`; the harness did not. The earlier scratch acquisition probe is now covered by durable tests.

## Correction and ownership

Validation now belongs to `definition().execute`, after the private handler plus every composed task-local Layer has completed and released. `Task.make` still decodes input before invoking the handler; output/error encoding and secret validation move to the shared outer execution boundary. This also covers implementations and repeated `.provide` composition without adding a service or a Scope.

The attempt tracker closes further reads before validation, but retains its registered values until the owning interpreter or Task.test protection boundary finishes. Validation uses that captured tracker explicitly. Runtime-error messages are scrubbed with the same rule used by the interpreter. Declared errors and successful values are refused with SecretInOutput rather than rewritten. Complete Causes, including cleanup defects, remain intact through validation.

The interpreter retains its existing wire-encoding/persistence checks. Task.test returns the decoded success value as before; codec transformation tests still pass. Publication timing and previously committed outputs are unchanged: this is final result/error validation, not retroactive scanning of earlier publications.

## Evidence and limits

- `packages/core/test/task-finalization-boundary.test.ts`: five failed-before/passed-after cases using synthetic secrets only, plus assertions that failed acquisition never enters the handler and release runs before the final result is observed.
- Focused SDK validation: **22 passing tests, 78 assertions**, including the prior mixed-cause, vault protection and codec-contract cases.
- `packages/platform-bun/test/task-finalization-boundary.test.ts`: real host and persistent engine with an in-process Catalog, four cases covering acquisition plus cleanup defect, finalizer-discovered success/error values, and runtime-error messages. Each run fails without exposing the synthetic value. After host shutdown, SQLite database/WAL/SHM files present in the fixture are checked for the literal canary, covering native stored results as well as Run replies.
- That runtime test plus the existing cleanup/retry regression passed **2 tests, 43 assertions**. Ordinary declared-error retry remains successful; cleanup crashes still do not retry.

Logs and the pre-verification 363-file source/config manifest are in `/tmp/effectory-finalization-boundary`. These proofs do not claim protection for transformed values, binary artifact content, arbitrary external I/O, or secrets read outside attempt ownership. Those existing boundaries remain unchanged.

A separate scratch interruption probe in `probes/interrupt.ts` paused Layer cleanup after a declared handler failure, interrupted the task, then allowed cleanup to read the synthetic secret and finish. The final Cause retained interruption, contained no typed failure and exposed no canary. This is supporting scratch evidence, separate from the checked-in regressions and full-suite count.
