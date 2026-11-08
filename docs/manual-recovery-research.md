# Manual recovery after uncertain execution

Status: research and candidate contract, 2026-11-06. Not user-approved; no production implementation. ArtifactReader is complete. This is the next proposed Swamp parity feature.

## Consumer problem and source evidence

A manual task can complete an external action and lose the daemon before the engine saves its result. Effectory correctly holds the run, but the operator can currently inspect or cancel it, not authorize another execution of the uncertain task inside the original run. Starting another run loses the original continuation and changes operation identities.

Swamp's `vendor/swamp/src/cli/commands/workflow_recover.ts:124` exposes assessment and preparation for recovery. `--assess-only` reports eligibility; unguarded unknown steps require `--acknowledge-unknown`; a definition fingerprint mismatch refuses recovery. The mutation withdraws settled step starts, resets unknown steps to pending, saves the run and prints a separate `workflow resume` command (around lines 218–263). These are source observations, not executed Swamp tests.

Effectory source observations:

- `packages/platform-bun/src/host-store.ts:764–850`: attempt admission checks terminal state, fences, NeedsAttention and original deadlines. An existing manual attempt causes NeedsAttention without invoking task code. Attempt identity is run/node/activityAttempt; entries count repeated entry, and startedAt is preserved.
- `packages/platform-bun/src/interpreter.ts:180–235`: each leaf uses its pinned revision and suspends its native workflow when admission needs attention. It does not fabricate an outcome.
- `packages/platform-bun/src/runner.ts:65–120`: NeedsAttention also means finalization stalled after a stop. It is not sufficient evidence of replay eligibility. Active resources and native engine outcomes must participate in assessment.
- `packages/platform-bun/src/execution-resources.ts`: active handlers and cleanup are tracked per run, and interrupt requests are owned by the host scope. A recovery implementation must not run concurrently with an old handler or finalizer.
- `docs/durability-and-recovery.md` explicitly deferred generic resume/result injection pending a separately reviewed protocol. Existing cancellation is not external-effect rollback.
- The vendored Effect ClusterWorkflowEngine has explicit resume handling, but this does not prove the installed Effect 4.0.5 can resume both the suspended leaf and its parent correctly. Review/probes must use the installed package, not infer capability from vendored source.

## Candidate contract to critique, not a presentation

Prefer a run-oriented recovery assessment and one explicit mutation that both records authorization and durably schedules continuation. Avoid making the operator coordinate two non-atomic recover/resume commands. No new task-context field, custom scheduler or parallel outcome journal.

Possible CLI shape: `run recovery <run-id>` to inspect; `run recover <run-id> --assessment <token> --acknowledge-reexecution --request-key <key>` to authorize the assessed uncertain work. Names, token shape, selection granularity and receipt are deliberately provisional. RPCs would expose the same schema-defined assessment and mutation, not invoke the CLI. Reviewers should propose exact signatures and compare whether a selected invocation option is needed immediately.

Assessment must distinguish uncertain manual re-entry from stop/finalizer holds, ordinary durable waits, deadlines, terminal results and unavailable pinned code. Show original invocation/task identity, attempts and existing publication/evidence references. Never infer external success from an artifact or log. Explain that re-execution can repeat an external action. Assessment must be bounded/paged for fan-out and reflect the same principal boundary as RunGet.

Mutation must recheck the exact assessed uncertainty and quiescence, reject stale assessments, retain immutable run/revision/input/keys, and create a durable authorization and continuation intent together. Native execution remains authoritative for results. Duplicate request keys return the original receipt before current-state validation. No direct engine table edits, clearing stop fences, resetting deadlines, deleting successful activities or injecting arbitrary success values.

A one-entry authorization is a candidate, not an established solution: consume it in attempt admission, never convert a manual task permanently to idempotent. If the process dies after consumption but before its result is durable, hold again. Prove what happens if it dies after authorization but before dispatch or before consumption. Public receipts must distinguish accepted authorization from completed recovery; repeated keys must not authorize another entry. Decide whether retry budgets/attempt numbers stay unchanged or advance and show the consequences to users.

Other uncertain siblings may coexist. The contract must explain whether all current unknown entries are authorized, whether selection is required, when newly discovered unknown entries re-block the run, and how already-running siblings are quiesced without manufacturing cancellation outcomes. Cancellation/deadline can win; recovery must not undo either. Settled waits and engine-recorded successful nodes remain settled. Publication-key conflicts remain conflicts; the user needs usable guidance if an external retry intentionally changes output.

Existing reports, scheduled-run blocking, reader pins, Vault tracker ownership, task-local Layer reacquisition, attempt deadlines and watcher events must remain consistent. Report runs themselves may need this recovery path when their reporter task is manual. A held source/report keeps its current retention protection; recovery should not fabricate a terminal transition just to requeue work.

## Questions the reviews must resolve

1. Is the installed engine's suspension/resume primitive sufficient for durable leaf plus parent continuation without changing journal ownership?
2. What exactly proves no old handler/finalizer can still perform work? Can the current per-run active count support recovery while siblings exist, or is narrower ownership needed internally?
3. What is the smallest complete consumer API for assessment, authorization, selection and idempotent delivery recovery? Avoid gratuitous plan objects if a stable attempt token suffices.
4. Which conditions are refused, and which can recover? Do not conflate re-execution permission with reconciliation of an external action. If a separate author-provided reconciliation hook is necessary, explain why rather than adding it silently.
5. What limits, old-daemon behavior, events and exit semantics are public choices?

## Required proof direction

Actual engine manual-task kill/restart; success committed before projection; authorization before/after admission consumption; duplicate/lost-response requests; stale assessments; simultaneous operator decisions; cancellation/deadline races; live/slow finalizers; multiple uncertain fan-out leaves; preserved successful branches and settled waits; same publication identities; pinned revision across deployment; manual report recovery; reader/Vault/Layer lifecycle after re-entry. Tests must demonstrate that unapproved manual execution is never silently repeated.

This pass reads source only and changes documentation. It does not establish feasibility or approve any public interface.

## Installed-engine continuation evidence

A subsequent [native engine probe](manual-recovery-engine-evidence.md) found that resuming only the root left the child suspended, while resuming the leaf woke the linked parent and retained its completed preceding Activity. Resuming both also completed. The experiment uses the installed Effect 4.0.5 and real SQLite engine Layers, but an in-memory permission flag: durable host authorization and crash recovery remain unproven. Recovery intent dispatch therefore needs the registered leaf execution identity, not merely the root run's engine ID.

The follow-up process-death probe also passed: SIGKILL while both native workflows were suspended, fresh-engine leaf resume, and another fresh-engine duplicate wake retained one execution of the completed preceding Activity. Its gate is still an in-memory stand-in, so it proves engine continuation only, not operator authorization durability or recovery after an actual uncertain external action. See the same evidence document for the corrected permission timing, assertions and reproducible driver.

## Crash after an external action, before a native result

The [uncertainty experiment](manual-recovery-uncertainty-evidence.md) now covers SIGKILL after a separate synthetic action commits but before the native Activity returns. Restart re-entered the child but its denied gate prevented a second action. Explicitly permitting and resuming it produced a second action while preserving the parent's earlier completed Activity; later duplicate wakes reused the completed result. This confirms both the feasibility of guarded re-entry and its unavoidable duplication risk. The gate is still a stand-in; it does not prove a durable host authorization protocol.

## Candidate contract and assessment source audit

The parent candidate is now written in [manual-recovery-api-draft.md](manual-recovery-api-draft.md), pending consolidation with both Claude critiques. `report-history.ts:214–225` already publishes the stored leaf identity as an opaque invocationId with a bounded path preview. `interpreter.ts:350–399` also confirms that a known domain failure can leave a leaf suspended on retry backoff. Assessment must distinguish an explicit manual admission refusal from this ordinary retry state; prior attempt rows plus Suspended are insufficient. The draft proposes one-entry authorization without choosing unresolved bulk/quiescence/dedup decisions prematurely.

The native fan-out continuation probe also passed: enabling one child left the second held and the parent suspended; enabling the second completed the parent without repeating the first child or the preceding Activity. This resolves the basic native-engine selectivity question. HostStore's run-wide NeedsAttention check, durable entry grants and active-resource isolation remain unresolved. Source and output are retained in [engine evidence](manual-recovery-engine-evidence.md#selective-fan-out-continuation).
