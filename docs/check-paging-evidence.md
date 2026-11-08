# Check paging fixture verification

Date: 2026-11-07. Test-only correction found while verifying task stop ownership. No production query, index, admission limit, or timeout changed.

The full suite finished with 532 passes and one failure across 138 files (4,473 assertions, 1047.09 seconds). The only failure was `10,000 observations remain pageable without loading native task outputs`: 9187.02 ms exceeded its existing five-second test timeout. The 365-file source/config/fixture manifest was unchanged throughout that run. Its log remains `/tmp/effectory-stop-ownership/full-tests.log`; an isolated success does not make that run green.

## Measured work

A scratch probe copied the test's real HostStore fixture and operations, measuring record creation separately from paging, after the full suite had exited. It created all 10,000 observations through `checkStart` and `checkFinish`, read all 50 pages, and checked that another start failed with LimitExceeded.

- Creating records: 2611.52 ms, including 1322.58 ms in start calls and 1275.27 ms in finish calls.
- Reading all pages: 292.98 ms; maximum observed page time 58.00 ms.
- Total: 2908.20 ms.

EXPLAIN on the actual page query used `host_checks_invocation_order`; its latest-attempt subquery used the host-attempt primary-key index. No missing index was demonstrated. These are one-machine observations on an isolated process, not a latency guarantee or a precise attribution of the earlier full-run slowdown.

## Correction

The paging test now creates and completes the first observation in each of ten entries through the real APIs, then copies its valid persisted shape for the middle 998 observations inside a transaction. It updates the fixture's reserved byte/row accounting using the existing reservation function. The last observation in every entry is again admitted and completed through the real APIs, including the run's 10,000th observation.

The test still reads 10,000 rows, enforces each page's 200-item and 2 MiB bounds, and rejects an additional observation in a new entry. It additionally checks 10,000 unique sequences and the stored row budget. Separate existing tests continue to exercise duplicate IDs, live-entry ownership, entry/byte limits, failed-completion rollback and incomplete-observation reconciliation. This is a read-scale fixture, not a benchmark or replacement for those write-path tests; synthetic middle rows do not emit completion events.

Focused validation with the ownership regressions passed: 10 tests, 165 assertions, zero failures. The paging case took 434.43 ms. Typecheck and lint also passed. The new full suite passed this case in 600.13 ms and finished with **531 passes, 2 failures, 4,453 assertions across 138 files** (1148.38 seconds). Its 365-file source/config/fixture snapshot stayed unchanged, with no added or removed files.

Both failures were in CLI fixtures: a report fault-injection trigger encountered `SQLITE_BUSY` after daemon restart, and the checks test's three-second window elapsed before its unfinished-run inspection. See [CLI fixture evidence](cli-fixture-race-evidence.md) for the corrections and subsequent verification. This full run is not green. The five-second paging timeout and production budgets are unchanged.

After correcting those CLI fixtures, full verification passed **533 tests, 0 failures, 4,476 assertions across 138 files** (1301.41 seconds). The paging test passed in 668.74 ms in that run. Its 365-file source/config/fixture snapshot remained unchanged, with no additions or removals. This later success does not erase the two earlier failed runs.

Scratch reproduction and logs: `/tmp/effectory-check-paging-investigation/profile.ts`, `profile.log`, and `focused-after.log`. The probe is research evidence outside the checkout; the corrected paging regression is in `packages/platform-bun/test/check-store.test.ts`.
