# Manual recovery: Effect review, round 2

Status: reviewer re-review of the frozen [consolidated draft 2](manual-recovery-api-draft.md), 2026-11-06. This is not user approval. It authorizes no implementation, and no recovery code exists. Scope: Effect ownership, durability and continuation feasibility, plus whether the round 1 blockers B1–B9 are resolved. The full round 1 research is not repeated.

Evidence labels:

- **[T]**: tested by a scratch probe in this round, against the installed `effect@4.0.5`. The probes ran outside the checkout on synthetic data. They are models, not Effectory.
- **[S]**: a fact from the current source, cited by path and line.
- **[I]**: an inference that no probe or test proves yet.

## Verdict: conditionally ready for presentation

Draft 2 resolves B1–B9 at the contract level. Recovery fits the existing ownership model:

- Effectory never edits the engine journal.
- Only the host admission transaction consumes a permission.
- Durable host rows drive continuation, through public `resume`/`poll` calls only.
- The host fence wins every cancel and deadline race.

No new engine primitive or public field is needed.

One feasibility gap remains, and it is the strongest concern from the brief. **The draft does not define when continuation is complete.** Two natural readings of line 153 fail, as shown in counterexamples CE1–CE3 below. The fix is private host mechanics and changes no public shape, so it does not need another review round.

**Condition:** the parent applies corrections C1–C6 below before presenting the draft to the user. C1 is required. C2–C6 are small text changes. None of them changes the recommended package of public decisions (line 202). If the parent applies C1 as written, I approve presenting the draft without round 3. If C1 is changed in substance, for example by keeping a poll-based completion rule, the draft needs re-review.

## Round 1 blockers

| Blocker | Draft 2 | Status |
| --- | --- | --- |
| B1: uncertain sibling hidden behind the hold | Step 3 inspects the prior entry before the hold gate (line 133) | Resolved |
| B2: held siblings cannot publish | Line 143: an admitted entry under a captured lease and entry, with no fence, may publish. Closed entries may not. | Resolved in the contract. `lake.ts:249–256` must change, which the draft covers. |
| B3: event keys drop re-holds | Line 171 adds entry and generation to keys | Resolved |
| B4: status is not a durable hold | Lines 127 and 141 make status a projection of uncertainty rows, and no overwrite is allowed | Resolved. The existing `outbox()` already defers `Settle` while the run is `NeedsAttention` (`host-store.ts:1292`), which is consistent. |
| B5: continuation must resume every suspended leaf | Line 153 | **Partly resolved.** Completion is undefined. See C1. |
| B6: preserved `startedAt` causes an immediate TimedOut | Line 139 gives a fresh window to authorized re-entry, and an expired old window does not fence before the uncertainty is recorded | Resolved in intent. The order and timestamp need clarifying (C2, C3). |
| B7: cancel and deadline races | Lines 131 and 167, and the crash/race table | Resolved |
| B8: per-entry quiescence | Lines 135 and 167 | Resolved in the contract. The Effect shape is in C4, with a [T] result. |
| B9: old daemon | Lines 151 and 183: separate intent table plus the existing ABI refusal | Resolved, and the correction is accepted. See "Host layering and ABI". |

## New probes

Probe directory: `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/0cbe1d3e-f529-47f5-9388-aecd93f13de8/scratchpad/mr2/`. Its `node_modules` is a symlink to the checkout, which resolves the installed `effect@4.0.5`.

### P1: reservation release order (`reserve.ts`, pure Effect)

The probe uses `Effect.scoped(acquireRelease(admitAndReserve, release))` around a handler. The handler provides a task Layer whose finalizer takes 150 ms.

**[T]** In all four cases the log reads `admitted live=1 → layer finalized live=1 → released live=0`:

- success;
- `Effect.timeoutOrElse` firing, which is the attempt-timeout path in `interpreter.ts:301–315`;
- outer `Fiber.interrupt`;
- self-interrupt.

In 4.0.5, `timeoutOrElse` waits for the interrupted handler's finalizers before it returns. A reservation registered this way therefore never reaches zero before task Layer cleanup has finished.

### P2: late suspension, and a leaf parked on a clock (`late.ts`, `ClusterWorkflowEngine` and SQLite)

Setup: a parent runs leaves `c1`, `c2` and `c4`.

- `c1` is the manual leaf.
- `c2` is gated by the hold. It commits its gate row and then delays 1.5 s before `Workflow.suspend`.
- `c4` completes its handler and then sleeps on `DurableClock` with `inMemoryThreshold: 0`, as the retry backoff does (`interpreter.ts:394–401`).

Phase 1 runs `c1` and `c4`, then `kill -9` while `c1` hangs. Phase 2 restarts the process and authorizes `c1`. It then runs two continuation passes that resume whatever polls `Suspended`.

**[T]** Observed output:

```
admit c1 -> NeedsAttention ; admit c2 -> Gated ; authorized c1
pass1 polls={parent:None, c1:Suspended, c2:None, c4:Suspended}  pendingAuth=[c1] pendingGate=[c2]
admit c1 -> Admitted ; EXECUTE c1
pass2 polls={parent:Suspended, c1:Complete, c2:Suspended, c4:Suspended}  pendingAuth=[] pendingGate=[c2]
admit c2 -> Admitted ; EXECUTE c2
final {parent:Suspended, c1:Complete, c2:Complete, c4:Suspended}
```

The output shows three things:

- `c2` had a committed gate row but no `Suspended` reply when pass 1 scanned, so pass 1 did not resume it.
- `c4` stayed `Suspended` after an explicit resume, and its completed handler did **not** run again.
- After pass 2 the authorizations had all been consumed, yet a stranded leaf (`c2`) still existed until the durable gate obligation drove another resume.

**[S]** `resume(..., "explicit")` returns without doing anything unless the run reply is `Suspended` (`effect/src/cluster/ClusterWorkflowEngine.ts:285–307`). An issued resume is therefore never proof of delivery, as draft line 153 already says.

## Strongest concern: when continuation is complete

Draft line 153 says to retry "until authorized entries have consumed their permissions or been superseded, and gate-suspended leaves have been handed back to the engine." Line 123 blocks a new generation while one is pending. Under the plausible readings of this text, there are three failures.

- **CE1. "Authorizations consumed, plus one scan of Suspended leaves" strands siblings.** **[T]** P2 pass 1 and pass 2. A gated sibling that saves `Suspended` after the scan is never resumed. The parent stays `Suspended`, and the run looks `Running` or `Waiting` indefinitely.
- **CE2. "No registered leaf polls Suspended" never finishes on time.** **[T]** `c4` stays `Suspended` after resume. Leaves in a retry backoff are natively `Suspended` for the whole retry delay. **[I]** Because of line 123, a long backoff would also block acceptance of the _next_ recovery generation for that long.
- **CE3. "Handed back" read as "admitted" deadlocks.** **[I]**, following directly from lines 123, 134 and 153. Suppose that during delivery of generation 1, a late replay of another manual leaf records new uncertainty B. Gated sibling `c2` is resumed, re-enters admission and is gated again under B. Generation 1 then never completes. The state stays `Pending`, so B never gets a token, and the only exit is cancel.

**C1 (required; private mechanics, no public change). Drive continuation from durable obligation rows, and define completion by host-observed re-entry.**

1. Give the admission transaction a monotonic host sequence. A gated admission (step 4) upserts `(run, invocation, activityAttempt) → gatedSeq`. **Every** later admission of that key clears the gate row in the same transaction, whatever the outcome: admitted, gated again with a new sequence, recorded as uncertain, cancelled or timed out.
2. A generation records `acceptedSeq` when it commits. Its obligations are:
   - each authorized entry, which closes when admission consumes it or when it is superseded;
   - each gate row with `gatedSeq < acceptedSeq` that has not been cleared.

   A leaf gated again under a newer hold gets a larger `gatedSeq`. It drops out of this generation and becomes an obligation of the next one, which removes CE3.

3. On each runner pass, for each open obligation, poll the leaf:
   - `Suspended`: call `resume`.
   - `Complete`: close the obligation as superseded, without deleting or replacing the result.
   - `None` (running or not yet saved): keep the obligation and retry on the next pass.

   A stop or terminal run closes every obligation as superseded. The generation is delivered when it has no open obligations. `continuationPending` in the assessment (line 89) means exactly "open obligations exist".

4. Do not use "a leaf polls Suspended" as a criterion for completion or membership. Uncertainty rows, authorizations and gate rows already identify every leaf that the hold suspended. A leaf in a retry backoff can be resumed without harm (**[T]** `c4`), but it is not an obligation. This also bounds each pass by the number of obligations, not the 10,000 invocations.
5. Do not let `resume` stall the runner tick. **[S]** `resume` is wrapped in `ensureSuccess`, which retries forever with a backoff of up to 1 minute (`ClusterWorkflowEngine.ts:861–871`). One run's resume could therefore delay the outbox and reconcile work for every other run. Fork resumes into the runner scope, de-duplicated per invocation (as `ExecutionResources.interrupt` does at `execution-resources.ts:51–75`), or bound the time each tick spends on them. Treat a failure as "obligation still open".

The proof for item 3 in the draft's required-proofs list must include P2's interleaving under real Effectory: a gate row is committed before `Suspended` is saved, and the scan runs between the two. It must also include a re-gate under a newer hold (CE3) and a leaf parked in a retry backoff (CE2).

## Other items the brief asked about

### Admission order: absolute deadline vs an expired old attempt window

The draft gets the intent right: an expired absolute deadline stops the run, and an expired _old attempt window_ does not fence an uncertain manual entry. It never says where the ordinary attempt-window check goes. Today that check runs before the manual check (`host-store.ts:794–821`).

**C2 (text).** State the admission order as follows.

1. Fence, terminal state or `Cancelling` returns `Cancelled`.
2. Absolute run or ancestor deadline: take the stop path and return `TimedOut`.
3. If the prior entry is manual:
   - consume a matching authorization and admit with a fresh window; or
   - record uncertainty (idempotent) and return `NeedsAttention`.

   The old attempt window is not checked on this path.

4. If the prior entry is idempotent and its preserved window has expired, fence the run and return `TimedOut`, as today.
5. Hold gate: record the gate row (C1) and suspend.
6. Admit: a first entry gets a new window, and an idempotent replay keeps its window.

Putting step 4 before step 5 means a held run whose idempotent sibling has already expired shows `Stopping`/`Terminal`, rather than issuing a token that ends in TimedOut right after it is accepted. That is small, private-observable behavior, not a public decision.

### Initial entry vs authorized manual re-entry

This part is consistent: the first entry of a declared attempt goes through ordinary admission and gating, a domain-error retry is a new attempt, and every later manual entry consumes its own authorization.

**C3 (text).** Name the persisted value that both admission and the in-handler timer read. Admission sets `windowStartedAt`:

- to now, for a first entry or an authorized manual re-entry;
- unchanged, for an idempotent replay.

`firstStartedAt` is kept for inspection only. **[S]** The handler currently derives its timeout from `attemptStartedAt` (`interpreter.ts:231–243`). If the store gains a fresh window but that lookup is not changed, the handler times out immediately. The `AttemptStarted` event payload's `startedAt` and `deadline` should report the window.

**C5 (text).** State the gate predicate exactly: the run is held when **an uncertainty row exists that has no authorization**. Without this, gated siblings that are resumed before the authorized entry is consumed are gated again, and line 141's "authorization resolves the current holds" has no definition.

### Atomic per-entry reservation through scoped cleanup

**C4 (text, Effect shape).** The draft requires "no untracked interval" (line 135). Name the construction that meets it:

- Admission and the in-memory per-entry increment run in one synchronous `bun:sqlite` transaction callback. This is atomic with the mutation's check, because both run synchronously on the daemon's single JS thread.
- That call is the _acquire_ of an `Effect.acquireRelease`. Its release decrements only when the result was `Admitted`.
- The surrounding `Effect.scoped` encloses the handler, task Layer, Vault tracker and logger scope.

The acquire is uninterruptible, so no interrupt can land between commit and registration. **[T]** P1 shows that the release runs after Layer finalizers on success, timeout and interruption.

A refused admission takes no reservation. The mutation may therefore accept while a refused leaf is still unwinding toward `Suspended`, and C1 covers that case.

Known limit: fibers that author code detaches with `forkDetach` escape any scope. **[I]** This matters only for a redelivery in the same process, and the existing per-run `track` has the same limit. Do not claim more.

### Separate intent table and the resume-before-Suspended race

The separate table is correct, and it removes any dependence on how the legacy `Outbox` behaves (see ABI below). The race is real (**[T]** P2) and is fully handled by C1. Startup re-derivation (line 151) works directly from the obligation rows.

### Rescanning siblings without resetting native results

**[S]** `resume` resets only a `Suspended` run reply (`ClusterWorkflowEngine.ts:296–307`). `activityExecute` resets an activity only when the stored reply of that registered activity is `Suspended` (`:738–745`). **[T]** `c4`'s completed handler did not run again after an explicit resume. Line 155 holds.

**C6 (text).** Line 155 applies native supersession only to _authorized_ candidates. Apply it to unauthorized uncertainty rows too. If the leaf polls `Complete` (possible after a redelivery in the same process), close the row as superseded. Otherwise the run stays `NeedsAttention`, and the only way out is to "authorize" a re-execution that can never happen.

### A pending permission and new uncertainty

The behavior is consistent once C1 is applied:

- An authorized entry proceeds even though a newer hold exists (step 4).
- New uncertainty shows `Pending` with no token until the earlier generation's obligations close.
- The newer generation's token covers the new set.

Without C1, this is CE3.

## Host layering and ABI (B9)

The correction to round 1 is accepted:

- **[S]** `HostStore.outbox` decodes the strict `Outbox` schema before dispatch (`host-store.ts:1287–1296`).
- **[S]** The fail-closed boundary already exists, and it is stronger than the draft states. `sourceAbi()` hashes every `.ts` file in `core/src`, `runtime/src` and `platform-bun/src` (`host-runtime.ts:27–44`). Any build that contains recovery therefore has a different ABI from every earlier build.
- **[S]** The catalog layer validates **every** retained revision while it is being built, and fails on a `hostAbi` mismatch (`revisions.ts:167–190`).
- **[S]** `runnerLayer` sits above `interpreterLayer`, which requires that catalog (`host.ts:21–29`). An older binary therefore cannot start its runner, its interpreter or its admission code while a revision deployed by the newer host is retained. A recoverable run always pins such a revision, because otherwise its state is `RevisionUnavailable`.

The draft's requirement for a real old-binary proof is correct. **[I]** It is expected to pass and is cheap to run, so keep it as a gate rather than a design risk.

Line 181 can say plainly: "an older or newer host refuses to start while revisions with a different ABI are retained." This also makes "no automatic migration of old held runs" literally true.

## Not blocking

These items were checked and need no change:

- Wire shapes are consistent with the source. `taskVersion` is a number (`core/src/task.ts:36`). `invocationId` is the existing leaf `engineId` (`report-records.ts:60`).
- The state precedence and the bounds on the token, cursor and receipt are coherent.
- Lookup by principal first and then receipt, with `(runId, actor, requestKey)`, is sound.
- Accepted-only receipts and the 16/64 limits are public decisions already listed for the user.

## Summary for the parent

- **Required before presentation:** C1, the obligation rows, completion by re-entry, and no poll-based criterion.
- **Text-only:**
  - C2: admission order;
  - C3: `windowStartedAt`, read by the handler;
  - C4: `acquireRelease` around admission and the reservation;
  - C5: the gate predicate;
  - C6: native supersession for unauthorized rows;
  - an ABI sentence on line 181.
- **Proof gate 3 additions:** P2's interleaving, a re-gate under a newer hold, and a leaf in a retry backoff.
- **Public decisions:** none added or changed. The recommended package on line 202 can go to the user once C1–C6 are in.
- **Evidence limits:** P1 and P2 are synthetic models on the installed engine. They are not Effectory's interpreter, lease, permits, publication or reports. Every claim still needs the draft's real-interpreter proofs.
