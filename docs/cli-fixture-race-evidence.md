# CLI crash-fixture synchronization

Date: 2026-11-07. Test-only corrections discovered during V1 runtime verification. No production admission, timeout, recovery or SQLite policy changed.

The preceding full suite finished with 531 passes and two failures across 138 files (4,453 assertions, 1148.38 seconds). Its 365-file source/config/fixture snapshot was unchanged. Logs and the hash comparison are under `/tmp/effectory-check-paging-investigation/`.

## Report materialization fixture

`workflow-reports-cli.test.ts` killed its first daemon, restarted it, then installed a SQLite trigger to stop report materialization. The trigger creation raced the running daemon's writes and failed with `SQLITE_BUSY`. This happened before releasing the child approval, so the intended recovery assertions did not run.

The trigger is now installed after the first daemon exits and before its replacement starts. The remaining trigger changes already happen while the daemon is stopped. The fixture still kills at the same native-completion/materialization/admission boundaries and retains its search, source identity and retry assertions. No busy timeout or test timeout was raised.

## Check completion fixture

`checks-daemon.test.ts` used three-second sleeps to hold an observation open, hold a handler after a completed observation, and hold a manual observation before killing the daemon. The full run observed the first check Running, but the subsequent `run junit` returned success instead of the expected unfinished-run refusal. The sleep did not guarantee that the task was still running when the separate CLI process inspected it.

Each window now waits on a disposable fixture file. The parent opens the idempotent gates only after the old process has exited, so re-entry can complete but the original handler cannot finish before the kill. The manual gate opens after the restarted run has been observed in NeedsAttention and immediately before explicit authorization. A new assertion also requires the completed observation to have been seen before that case kills its daemon. The tests retain their Incomplete/Passed entry-history and XML assertions; polling deadlines remain bounded and unchanged.

These gates control application test effects, not engine tables or production state. They make the crash preconditions explicit without claiming that arbitrary production work can be paused this way.

## Verification

The two corrected real-process tests passed together: **2 passed, 0 failed, 45 assertions** (84.15 seconds). The report case took 27.25 seconds; the checks case took 56.73 seconds. Typecheck and repository formatting/lint also passed. Logs are `/tmp/effectory-cli-fixture-verification/focused.log`, `typecheck.log` and `check.log`.

The subsequent required full suite passed: **533 tests, 0 failures, 4,476 assertions across 138 files** (1301.41 seconds). Both corrected fixtures passed in that run. The 365-file source/config/fixture manifest remained unchanged, with no added or removed files. The final log, manifest and comparison are `/tmp/effectory-cli-fixture-verification/full-tests.log`, `verification-manifest.json` and `verification-result.json`. The earlier failed run remains part of the evidence rather than being relabeled as green.
