# Run status after durable wake

Status: approved for implementation by the user, 2026-11-07. Implementation is complete; required verification is recorded in [the evidence document](runtime-wake-status-evidence.md). This is the next bounded runtime-correctness change in the [V1 plan](runtime-v1-plan.md), separate from execution upgrades and revision retirement.

## Observable behavior

Correct stale `Waiting` after a durable timer or retry wakes, using the existing status values and commands. `Running` means the engine has dispatched work that is progressing or awaiting execution capacity; it does not mean CPU is currently busy.

| Situation | Proposed projection |
| --- | --- |
| Accepted but not dispatched | Queued, as today |
| Dispatched root has no completed/suspended result | Running |
| Root is Suspended and at least one task invocation is acquiring a permit, acquiring a task Layer, executing, or releasing resources | Running |
| Root is Suspended with no such invocation work | Waiting |
| Manual execution uncertainty is held | NeedsAttention, retaining existing precedence |
| Cancellation/deadline fence exists | Existing stop/finalization projection wins; a wake cannot restore Running or Waiting |
| Native completion | Existing quiescence and outcome rules decide the terminal status |

Task permit queues include the global, workflow concurrency and report permits. Count queued work separately from the existing active-body count, so this change does not alter capacity accounting, cancellation completion or recovery reservations. A task inside a durable retry delay has ended its attempt and contributes no invocation work until the next attempt enters. Completed Activities reused by replay contribute no work.

This remains a periodically reconciled view, not an atomic census of user-created fibers. Short transitions may not be observed. The change does not add an "actually awaiting" marker or reinterpret a registered signal as an awaited signal. It does not change timeouts, deadlines, retry budgets, run identities or replay permission.

## Foreground CLI consequence

The existing foreground rule remains: return on a terminal outcome, NeedsAttention, or Waiting with an open approval/input/signal interaction. With corrected statuses, foreground commands stay attached while invocation work is active or queued, including after a sleep/backoff and while cleanup runs—even if a signal or sibling approval is already open.

When that work finishes and the root is still suspended with an open interaction, the command can return exit 4. A signal registered before a durable sleep may still cause exit 4 during that sleep: registration remains an open interaction, not proof of awaiting it. `run watch` continues following nonterminal states as today. Event shapes, flags, error codes, the human display's drain barrier and final status lookup are unchanged. Run get/list/watch and report-run status will show the corrected values through the existing projection/event transaction.

Example: `sleep → long-running task → await previously registered signal` currently remains Waiting during the task and can end foreground observation early with exit 4. Under this proposal it reports Running during the task and its cleanup, then Waiting at the signal wait.

## Internal implementation

1. Add a private per-run count around actual Activity execution, outside all task permit acquisition. Use Effect acquisition/release ownership so interruption while queued and all completion paths release it after the existing cleanup. Keep `ExecutionResources.active` unchanged for its existing execution/terminal guarantees. No new public service, Scope wrapper or durable table is required.
2. In runner reconciliation, derive the nonterminal projection from the native root result and that live-work count. Do not infer quiescence solely from a Suspended root; a child can be running while that result remains stored.
3. Keep the transaction-time checks in `HostStore.project` authoritative for terminal status, stop fences and manual holds. A prior snapshot or counter observation does not authorize resumption. Do not widen this change into a new interruption or terminal-completion policy.
4. Continue using the same projection transaction for RunStatus events and report-record synchronization. Counters are rebuilt from actual invocation entries after restart; never restore a persisted guess about live fibers.

## Evidence before approval

The current real-host probes use the persistent SQLite engine, Runner and actual Task/Workflow definitions. Their repositories are disposable, and gates establish the observed phase before recording three samples, 200 ms apart:

| Probe | Current status | Existing active count | Other evidence |
| --- | --- | --- | --- |
| Timer followed by a gated handler | Waiting | 1 | Prior probe, rerun against the current source |
| Retry wake followed by a gated second attempt | Waiting | 1 | Suspended native root can coexist with executing child work |
| Timer followed by task Layer cleanup held on a Deferred | Waiting in all three samples | 1 | Handler returned; Layer release had not finished |
| Timer followed by a task with all 32 global permits held elsewhere | Waiting in all three samples | 0 | Invocation registered; handler has not started |
| Retry backoff expires while all global permits are held | Waiting in all three samples | 0 | Root remains Suspended; leaf poll is None; first attempt finished, second handler has not entered |

Releasing each lifetime gate lets the run succeed, with one handler entry for the timer cases and exactly two for the retry case, with completed resource release. The retry-permit probe demonstrates why the existing active count alone is insufficient for the proposed queued-work meaning. Source inspection confirms that count is installed inside the permit wrappers.

Probe files and logs: `/tmp/effectory-status-proof/lifetimes.ts`, `lifetimes.log`, `probe.ts`, `wake-current.log`. These establish current behavior, not the proposed fix, HTTP/CLI behavior or restart correctness. The first lifetime probe run completed cleanup but its queue case lacked a Scope in the scratch harness; that harness was corrected with `Effect.scoped` and all three cases ran successfully. No production source was changed.

## Acceptance gates after approval

- Real persistent-host sleep and retry successors remain Running during gated work and cleanup, then settle correctly.
- Global, graph and report permit queues project Running; interruption while queued releases the private count, without changing existing capacity or reservation behavior.
- Parallel sibling wait plus active work stays Running; after the work drains, an open interaction projects Waiting.
- Sleep then approval, early signal registration before/after sleep, no-task timer-only workflows and ordinary input/signal waits retain the stated distinction.
- Restart reconstructs counts from real execution; completed Activity replay does not invent active work or reacquire its task Layers.
- Cancellation, deadline, manual recovery holds and stalled finalization cannot be erased by wake/reconciliation races. Existing stop/cleanup tests remain required.
- Report-run statuses and events agree with the underlying run, with no redundant events for an unchanged projection.
- Actual foreground CLI tests verify the later exit-4 boundary and unchanged final output, machine modes, interruption and watch behavior.
- Required typecheck, formatting/lint and full tests against a stable source snapshot. The preceding 550-test result verifies the previous implementation only.

## Approved decision

The user approved this correction, including Running during queued task work and cleanup, and the resulting later foreground exit when an open interaction coexists with that work. This approval does not authorize the separate runtime upgrade commands or compatibility policy.
