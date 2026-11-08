# Task stop and cleanup ownership

Date: 2026-11-07. Regression coverage for the runtime-correctness priority. No production behavior or public API changed.

## Boundary checked

The interpreter places the task's scoped body, including task-local Layer finalizers and the attempt reservation, inside `ExecutionResources.track` and the global execution semaphore. Repository ownership surrounds the host Layer. A stop must not release these owners merely because the handler has been interrupted: its finalizers can still be using resources.

Existing operator tests check prompt finalization on deadlines and a handler that refuses interruption. The new [task stop ownership test](../packages/platform-bun/test/task-stop-ownership.test.ts) specifically pauses a task-local Layer finalizer during cancellation and during graceful host Layer shutdown. It uses the actual host, SQLite cluster engine, task execution and OS-backed repository ownership; only application resources and the in-process catalog are fixtures.

Each case waits for the handler to enter before stopping it, and for the finalizer to enter before checking ownership. Deferred gates provide those observations; an arbitrary sleep is not used to infer acquisition or cleanup.

While cleanup is held:

- The handler has run once, and the resource has not been released.
- The run retains one active execution count; acquiring all 32 global permits fails immediately.
- The host fiber has not finished.
- A separate ownership Layer cannot acquire the repository lock.
- Cancellation has not projected a terminal status.

After allowing cleanup:

- The resource release completes exactly once, with no second handler entry.
- Cancellation reaches Cancelled.
- Graceful host shutdown completes.
- The active count is zero, all 32 permits are available, and repository ownership can be reacquired.

The tests pass on the existing implementation. This is supporting evidence for retaining Effect's current Scope and semaphore structure, not a newly fixed defect or proof of future revision eviction.

## Verification

Focused run: 2 passed, 0 failed, 19 assertions. Typecheck and formatting/lint passed after test-only typing/style corrections. The first full required suite finished with **532 passes, 1 failure, 4,473 assertions across 138 files** (1047.09 seconds). Both ownership regressions passed. The only failure was the existing `10,000 observations remain pageable without loading native task outputs` check-store test (9187.02 ms against its unchanged 5000 ms limit). The 365-file source/config/fixture manifest stayed unchanged. See [paging investigation](check-paging-evidence.md) for the phase measurements, test-only fixture correction and subsequent verification; this first run is not green.

After the paging correction and two subsequent CLI fixture corrections, full verification passed **533 tests, 0 failures, 4,476 assertions across 138 files** (1301.41 seconds). Both stop-ownership regressions passed. Typecheck and formatting/lint passed, and the 365-file source/config/fixture snapshot stayed unchanged. See [CLI fixture evidence](cli-fixture-race-evidence.md) for the intervening 531-pass/2-failure run and exact test-only corrections.

Initial logs: `/tmp/effectory-stop-ownership-focused.log`, `/tmp/effectory-stop-ownership-typecheck.log`, `/tmp/effectory-stop-ownership-check.log`, and `/tmp/effectory-stop-ownership/full-tests.log`. Final full-suite log and source comparison: `/tmp/effectory-cli-fixture-verification/full-tests.log` and `verification-result.json`.

Limits: one task and one gated Layer finalizer per case, in one host process. This does not prove cleanup after SIGKILL, completion of an indefinitely blocked finalizer, the daemon's forced-stop policy, all binary stream ownership, cross-build compatibility or concurrent revision eviction. Those have distinct contracts and proof gates.
