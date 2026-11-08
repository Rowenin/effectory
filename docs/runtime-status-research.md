# Run status after durable wake and stop

Date: 2026-11-07. This follows the runtime correctness priority. The stop-fence correction below preserves the existing cancellation contract. The broader wake projection is reproduced but not changed: foreground observation consumes the status, so its behavioral change needs discussion.

## Durable wake reproduction

The scratch script `/tmp/effectory-status-proof/probe.ts` uses the real host Layers, persistent SQLite engine, Runner and authored workflows. Each workflow enters a task whose body remains blocked on an Effect Deferred, allowing observation after wake without relying on a very short handler. A separate Deferred confirms actual task entry. The script observes the run after another 400 milliseconds, releases the task, then verifies successful completion. It uses disposable stores and closes them after each case.

Results in `/tmp/effectory-status-proof/results.log`:

| Workflow | Stored run status during handler | Active task bodies | Root engine poll |
| --- | --- | --- | --- |
| Durable sleep of 800 ms, then task | Waiting | 1 | None |
| First attempt fails, 800 ms durable backoff, second attempt | Waiting | 1 | Suspended |

Both tasks were executing ordinary code, not waiting on another durable interaction. None means the root has no stored result at that instant; a Suspended root can coexist with an executing child attempt. Therefore simply treating every Suspended root as a wholly idle run is insufficient, and fixing only the None branch misses retry wake.

These are host-layer probes, not HTTP/CLI observation tests. They do not establish every possible concurrent graph state or fix the earlier distinction between signal registration and actually awaiting a signal.

## Stop-fence race: corrected internally

`HostStore.project` already prevented transient projections from erasing manual-recovery holds and prevented rewrites of terminal results. It did not check a stop fence. Consequently an approval continuation or reconciliation using an older snapshot could project Running/Waiting/Queued/Retrying after cancellation or a deadline had fenced the run. This is a projection error, not evidence that handler admission bypassed the existing fence.

The correction checks for a durable fence inside the same transaction as the run update. Such stale live projections return the unchanged current run and do not append misleading status events. This also preserves NeedsAttention when stop finalization has stalled. Terminal outcomes remain allowed through the existing reconciliation path. No RPC, status enum, retry rule or CLI exit mapping is added.

Two regressions in `packages/platform-bun/test/host-store.test.ts` failed before the fix:

1. Cancellation followed by each stale live status rewrote Cancelling; the same risk applies to stalled-finalization NeedsAttention.
2. A timeout fence followed by a stale Running projection rewrote the run and appended a status event before terminal reconciliation.

After the fix, the host-store and manual-recovery suites passed together: 26 tests, 265 assertions, zero failures. This includes the existing manual-hold projection proof.

Required verification on 2026-11-07: typecheck and formatting/lint passed. The full suite ran 519 tests across 133 files in 1170.78 seconds: 517 passed and two failed (4,358 assertions). The failures were the existing 100,000-row indexed lake query exceeding its 250 ms production budget, and the existing lake-budget test exceeding its 5-second test deadline. The indexed-query file then passed alone (4 tests, 78 assertions, 5.45 seconds), and the lake-budget file passed alone (1 test, 6 assertions, 3.32 seconds). No query budget, assertion or test timeout was changed. This is combined full-run and targeted-rerun evidence, not an all-green full-suite claim or proof of the timing failures' root cause.

All 359 recorded source/config files remained unchanged during verification. Logs and the SHA-256 manifest are under `/tmp/effectory-status-proof/`: `typecheck.log`, `check.log`, `full-tests.log`, `fence-before.log`, `fence-after.log`, `query-rerun.log`, `budget-rerun.log` and `source-manifest.json`. These findings leave a test timing/performance follow-up; they do not justify relaxing the public query budget.

## Wake policy to discuss

Recommended correction using existing status values:

- Terminal outcomes, durable stop fences and manual uncertainty holds retain priority.
- A root with no completed/suspended result is Running once dispatched.
- A Suspended root with an executing task attempt is Running; a Suspended root without one is Waiting.
- Reconciliation must consult current guards, not use a stale run snapshot as authority to resume.

This remains an asynchronous projection, not an exact census of every user-created fiber or a new durable "awaited" marker. Resource cleanup and queued task permits need explicit cases in the final contract and tests before implementation. No new Scope or service is justified just to expose a status.

The public consequence is that foreground commands would stay attached while a task runs after a timer/backoff, even if a signal was registered earlier. When the run becomes Waiting with an open interaction, the existing outside-action exit rule would still apply. Signal registration is not proof of actually awaiting it; this proposal does not change that contract or introduce new wait events.

Required regressions for the eventual wake correction: sleep and retry with long-running successors; concurrent sibling wait and active task; permit queueing; cleanup; sleep then approval; signal registration before and after a sleep; restart; cancellation/deadline races; manual recovery holds; report-source status synchronization; and real foreground CLI behavior.

## Current lifecycle follow-up

The 2026-11-07 follow-up `/tmp/effectory-status-proof/lifetimes.ts` adds real persistent-host cleanup and global-permit cases. Three gated observations per case retained Waiting: cleanup had `active = 1` after the handler returned; a capacity-blocked invocation had `active = 0` and had not entered its handler. Releasing the gate produced Succeeded with exactly one handler entry in each case. The scratch harness's initial queued case lacked a Scope; after adding `Effect.scoped`, both cases completed successfully. Results are in `lifetimes.log`.

This changes the implementation recommendation: queued invocation work needs its own private count outside permit acquisition, while the existing active-body count keeps its capacity and terminal-completion role. The concrete public behavior and required implementation tests are now in [the wake-status proposal](runtime-wake-status-api-draft.md). No production status code changed; these probes do not prove the proposed correction or foreground CLI behavior.

A third case holds all global permits after the first attempt fails and waits beyond its 400 ms backoff. Across three observations, the root remains Suspended while the leaf poll is None, the active count is zero and the handler count remains one. After releasing capacity, the second attempt runs once and the workflow succeeds. This establishes the queued retry case that cannot be distinguished from an idle suspended root by the existing active count alone. The script and latest log include all three lifetime cases.
