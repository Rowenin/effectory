# Runtime status after durable wake

The user approved `runtime-wake-status-api-draft.md` on 2026-11-07. The correction is implemented and required verification passed.

## Change and ownership

`ExecutionResources` now tracks actual task invocation work separately from active handler bodies. The new acquisition/release counter encloses global, workflow and report permit acquisition, task-local Layers, handler execution and cleanup. It does not run for a cached Activity result or a durable sleep/backoff. The existing active-body count, terminal quiescence rules, manual-entry reservations, permit limits and timeouts are unchanged.

Runner reconciliation projects Running for a dispatched root with no native result, or a suspended root with invocation work; a suspended root without work projects Waiting. `HostStore.project` still checks terminal state, manual holds and stop fences transactionally, and still updates report records and emits status events in the same transaction. No CLI predicate, public status, event shape, command or durable table was added.

This is periodically reconciled status, not an atomic fiber census. Foreground observation stays attached during queued work, execution and cleanup even with an open interaction. A registered signal can still cause exit 4 during a durable sleep before it is awaited. See [live observation](live-run-observation.md).

## Regression evidence

The first two real persistent-host regressions failed against the previous implementation: both timer and retry successors reported Waiting during gated execution. After the production correction they passed. The initial logs are `/tmp/effectory-wake-before.log` and `/tmp/effectory-wake-after.log`.

Repository regression coverage:

- `wake-status.test.ts`: gated sleep/retry successors and Layer cleanup; retry queuing behind all global permits with both completion and cancellation; workflow concurrency queuing with a sibling approval; report permit queuing and synchronized report status; repeated projection without duplicate events; timer-only execution without invented task work.
- `wake-status-cli.test.ts`: actual daemon and foreground CLI, human and JSON modes, signals registered before/after sleep, handler and cleanup gates, later exit 4 with unchanged final JSON, graceful restart at the signal wait, completed Activity reuse without Layer reacquisition, then signal delivery and successful completion.
- `task-stop-ownership.test.ts`: the invocation-work count, existing capacity and repository ownership remain held until cancellation/shutdown Layer cleanup finishes, then return to zero.
- `manual-recovery-lifecycle.test.ts`: explicit reconciliation cannot overwrite a manual hold while finalization retains the entry reservation.
- Existing host-store, operator, live-watch and recovery suites cover deadline/cancel fences, stale projections, ordinary waits, retry timing, remote interruption, Ctrl-C and restart behavior.

Intermediate focused runs passed 27 tests / 258 assertions across the wake, host-store, stop and manual-recovery files, plus two real CLI tests / 24 assertions. Later coverage additions and formatting are checked again in final verification. Test-development failures were a mistaken report-record field name, widened test error literals and lint issues; these did not require production contract changes.

## Required verification

All required commands passed on 2026-11-07:

- `bun run typecheck`: exit 0 (existing Effect advisory diagnostics remain).
- `bun run check`: exit 0; formatting and lint clean.
- `bun test`: **559 passed, 0 failed, 5,156 assertions across 144 files**, 1525.24 seconds reported by the test runner.
- The snapshot of **381 source/configuration/build/asset/test files** stayed byte-identical, with no additions or removals during verification.

Logs, hashes and exit results are in `/tmp/effectory-wake-verification/{typecheck.log,check.log,tests.log,manifest.json,result.json}`. The final documentation-only evidence update was checked afterward. The previous 550-test result belongs to agent setup; this full run verifies the wake correction and all existing regression suites.

This correction does not implement or approve runtime upgrade commands, compatibility migration or revision retirement. Those remain separate V1 work.
