# Manual recovery: Effect review, round 1

Status: design review of `docs/manual-recovery-research.md`, 2026-11-06. This is not user approval, and it makes no production change. The reviewer read the current source and the installed `effect@4.0.5` package (`node_modules/.bun/effect@4.0.5`). It also ran synthetic kill/restart probes against that package, outside the checkout.

Evidence labels:

- **[T]**: tested by a probe in this review. The probes use the installed engine, not the vendored newer Effect.
- **[S]**: a source fact, cited by path and line.
- **[I]**: an inference that no probe or test proves yet.

## Verdict

The candidate works with the installed engine, but it is not yet safe to implement.

- **[T]** The installed `ClusterWorkflowEngine` can durably continue a suspended manual leaf and its parent without anyone editing engine tables. An explicit `Workflow.resume` on the leaf resets the leaf's `Suspended` run reply. During replay, the engine resets and re-runs the `handler/N` activity, because that activity's stored reply is `Suspended`. When the leaf completes, the engine resumes the parent by itself.
- **[T]** The host admission transaction is the only safety gate. Engine resume only provides liveness. Every replay re-enters `admitAttempt` before any task code runs. Without an unconsumed authorization, the entry is held again.

Before a public contract can be approved, nine host-side issues must be fixed (B1–B9 below). Five of them are counterexamples that already exist in the current source:

- An uncertain sibling can be hidden behind the run's hold.
- In-flight siblings fail to publish while the run is held.
- Event keys drop re-entry and re-hold events.
- The `NeedsAttention` status can be overwritten.
- An old daemon acknowledges and drops an outbox intent it does not recognise.

None of these need a new engine primitive, task-context field, scheduler or outcome journal.

## Probe setup

Probe path: `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/8b6b956c-9af7-4243-b6b1-3a6a314ae506/scratchpad/mr/probe.ts`. Its `node_modules` is a symlink to the checkout, so it resolves the installed `effect@4.0.5`, `@effect/sql-sqlite-bun@4.0.5` and `@effect/platform-bun@4.0.5`.

The probe copies `engine.ts`: `ClusterWorkflowEngine.layer` with `SingleRunner.layer({ runnerStorage: "memory" })`, SQLite in a file, and 20 ms polling. It has two workflows:

- `ProbeParent/v1` runs leaves `c1`, `c2` and optionally `c3` concurrently.
- `ProbeLeaf/v1` runs one `Activity.make({ name: "handler/1", interruptRetryPolicy: Schedule.recurs(0) })`, like `interpreter.ts:349–355`.

The activity body calls a host admission function in a separate `bun:sqlite` file. On `NeedsAttention` it runs `Workflow.suspend(yield* WorkflowInstance)`, as `interpreter.ts:221–223` does. `c1` and `c3` are manual tasks. `c2` is gated by the run's hold. Each phase is a separate OS process, and "kill" means `kill -9` while the handler hangs after its "external action" log line.

The probe's admission differs from production in one deliberate way: it records a prior manual entry before it checks the hold (see B1). Probe authorizations are keyed by `(node, forEntries)` and consumed in the admission transaction.

| # | Scenario | Result |
| --- | --- | --- |
| T1 | Kill c1 during its handler. Restart twice with no authorization. | **[T]** On the first restart the engine redelivered the activity, admission returned NeedsAttention, and c1, c2 and the parent were `Suspended`. The second restart did not re-execute anything. `EXECUTE c1` ran once. |
| T2 | Explicit `Leaf.resume` on c1 and c2 with no authorization. | **[T]** Both replayed, admission held again, and nothing executed. Resume is not a bypass. |
| T3 | Authorize c1, clear the hold, then resume c1 and c2. | **[T]** c1 executed exactly once more, and its finalizer ran. c2 executed once. **The parent completed without an explicit parent resume.** |
| T4 | Authorize and resume c1, kill it while it hangs (after consumption), then restart twice. | **[T]** The run held again. The authorization was marked consumed. `EXECUTE c1` ran 2 times, not 3. |
| T5 | Authorize c1 and persist the authorization, but never resume. Restart. | **[T]** The run stayed `Suspended` with the authorization unconsumed. Nothing woke the leaf. Continuation must be a durable intent. |
| T6 | Authorize c1, call engine `Leaf.interrupt(c1)`, then immediately `Leaf.resume(c1)`. | **[T] Counterexample.** The activity ran and the leaf completed with **Success**. The engine interrupt did not beat an explicit resume. |
| T6b | Authorize c1, insert the host fence, then resume. | **[T]** Admission returned `Cancelled` and nothing executed. The host fence wins. |
| T6c | Interrupt c1 only, then later resume c2. | **[T]** c1 completed `Interrupt`. After c2 finished, the parent replayed and stayed **with no reply** (`poll = None`). Interrupting a child alone strands the parent. |
| T7 | Kill with uncertain c1 and c3. Authorize c1 only, then resume all leaves. | **[T]** c1 executed. c3 held again and the parent stayed Suspended. After c3 was authorized, the parent completed. `resume` called twice was harmless. |
| T8 | Authorize c1 and resume only c1. Restart. | **[T]** c1 completed, but c2 stayed `Suspended` across restarts and so did the parent. Gate-suspended siblings need **their own** resume. The parent's replay does not revive them, because a repeated `execute` returns the stored Suspended reply. |

Limits: the probe is not the Effectory interpreter. It has no permits, `withDeadline` races, waits, publishing, Vault or reports, and it was not run under the repository lease. Every row must be repeated as an Effectory test (see the proof gates).

## Engine facts that support resume (installed 4.0.5)

- **[S]** `Workflow.suspend` sets `instance.suspended` and self-interrupts (`effect/src/workflow/Workflow.ts:1031–1035`). `retryOnInterrupt` does not retry a suspended activity (`Activity.ts:198–211`). `intoResult` turns this into a `Suspended` result (`Workflow.ts:745–749`).
- **[S]** `activityExecute` resets the attempt and executes it again when the stored activity reply is `Suspended` and the activity is registered for this replay (`ClusterWorkflowEngine.ts:735–745`). That is why the handler re-enters admission after a resume.
- **[S]** `engine.resume(..., "explicit")` resets only a `Suspended` run reply (`ClusterWorkflowEngine.ts:285–305, 699`). Otherwise it does nothing, so a duplicate or late resume is harmless ([T] T7).
- **[S]** When a non-suspended, non-interrupted child exits, the engine calls `sendResumeParent` (`ClusterWorkflowEngine.ts:511–518`). This is the parent's continuation ([T] T3).
- **[S]** A leaf can also be woken automatically by its `retry/N` DurableClock or by an InterruptSignal. Both replay through admission, so safety does not depend on which wake happens ([I], based on T2).
- **[S]** A pending InterruptSignal only blocks new activities if the activation has already loaded it (`ClusterWorkflowEngine.ts:310–317, 707–721`). It is delivered asynchronously, which explains T6. **Engine interrupt cannot be the arbiter for cancel or recovery races.**
- **[S]** Journal ownership does not change. Effectory never writes engine tables. Recovery uses only the public `leafExecution.resume(executionId)`. The host DB and the engine DB are the same SQLite file but use separate connections (`host.ts:18–24`, `engine.ts:28`), so the host and the engine can never commit in one transaction. The design must not need them to.

## Answers to the research questions

### Q1. Is the installed engine sufficient for leaf and parent continuation?

Yes. **[T]** T3, T4, T7 and T8 show it, and journal ownership does not change. There are two conditions:

1. The continuation must explicitly resume **every** registered invocation whose engine reply is `Suspended` (T8), not only the authorized ones.
2. Resume must be delivered from a durable host intent (T5).

The parent needs no explicit resume ([T] T3). Calling one anyway is harmless.

### Q2. What proves that no old handler or finalizer is still working?

- Across a process restart, the repository lease (`ownership.ts`, `engine.ts:15`) excludes the previous owner. An entry recorded under the old `host_attempts.owner` cannot still be running. **[S]+[I]**
- Within one process, the source does not rule out a second delivery of the same activity, for example after entity reactivation. `ExecutionResources.active(runId)` is per run (`execution-resources.ts:31–45`). That is too coarse: an unrelated sibling that runs for hours blocks recovery. It is still necessary as a signal of whether finalizers are finished. `track` releases only after the body and its inner scopes close (`interpreter.ts:340`), and the task Layer is built inside that body (`core/src/task.ts:452–470`).
- **Required:** track live entries per attempt, keyed by `(runId, nodeId, activityAttempt)`, alongside the per-run count. Authorization of an entry requires all of the following:
  - That entry's live count is `0`.
  - No fence exists.
  - The run is not terminal.
  - The pinned revision loads.

  Siblings may keep running. **[I]**

- A stopped run has a fence and is refused outright. A "finalization stalled" `NeedsAttention` (`runner.ts:64–83`) can never become recoverable.

### Q3. What is the smallest complete consumer API?

One read-only assessment RPC and one mutation RPC. The mutation authorizes **the whole current uncertain set** that an opaque assessment token names. It needs no selection and no plan object (see D1 for why). Signatures are below.

### Q4. Which conditions are refused, and which can recover?

Recoverable means all of the following hold:

- The run is held.
- There is at least one unresolved uncertain entry.
- There is no fence.
- The run is not terminal.
- The revision loads.
- No live entry exists for any listed attempt.
- No absolute deadline (`deadline`) has passed.

Everything else is refused with a reason (see the states below). Re-execution permission is **not** reconciliation. Effectory never decides that the external action succeeded. No author reconciliation hook is needed now, because `ctx.key()` and `attemptId` stay the same across entries (B6 and D4). That gives authors the stable identity for external idempotency keys that such a hook would otherwise provide. Adding a hook would also need a new task-context surface, which is out of scope.

### Q5. Which choices are public?

Limits, old-daemon behavior, events and exit semantics are public decisions D1–D9.

## Blockers and counterexamples

**B1. An uncertain sibling is hidden behind the hold.** **[S]** `host-store.ts:786` returns `NeedsAttention` for a held run **before** it checks `prior && replay === "manual"` (`:822`).

Counterexample: a restart redelivers A and B, both manual and both in flight. A is admitted first and holds the run. B returns `NeedsAttention` with no attention event and no uncertainty record. The assessment lists only A. After recovery, B re-enters and holds the run again: a stale and incomplete assessment, although not a double execution.

Fix: check prior manual entries first and record them, then check the hold. The probe does this ([T] T7 found both c1 and c3).

**B2. Siblings cannot publish during a hold, so a recoverable run fails.** **[S]** `lake.ts:249–256` rejects a publication unless the status is `Queued|Running|Waiting|Retrying`.

Counterexample: idempotent sibling B is re-admitted before manual A holds the run. B then calls `ctx.publish` and gets `Conflict: Publication attempt is no longer admitted`. That error becomes a host failure. The parent replays, the graph fails, and `stopWithFailure` fences the run, so it can never be recovered. **[I]** The sequence follows from the source and has not been executed in Effectory.

Fix: gate publication on an admitted entry under the current lease plus no fence (both already checked), not on the status label. Alternatively, allow `NeedsAttention` when no fence exists.

**B3. Event keys drop re-entry and re-hold events.** **[S]** `event()` silently ignores a repeated `eventKey` (`host-store.ts:348–356`). The keys `attempt/${nodeId}/${attempt}` (`:844`) and `attention/${nodeId}/${attempt}` (`:831`) do not include the entry number. After T4's crash after consumption, the second hold for the same attempt emits **no** event, so watchers never learn the run is blocked again.

Fix: keep the existing keys for entry 1, and add `/${entry}` for entries 2 and later and for each recovery generation.

**B4. Status is not a durable hold.** **[S]** `project()` overwrites any non-terminal status (`host-store.ts:1298–1328`). `awaitWait` projects `Running` unconditionally (`interpreter.ts:530`), and `reconcile` projects `Waiting` from a stale `activeRuns` snapshot (`runner.ts:100–103`).

Counterexample: a sibling wait settles while the run is held. The parent replays and projects `Running`, which removes the hold. New leaves are admitted, the uncertain leaf stays suspended forever, and assessment by status reports "not held".

Fix: store uncertainty in a table such as `host_recovery_entries`. `NeedsAttention` is projected and kept while unresolved rows exist. `project()` must not move a run out of `NeedsAttention` unless the recovery mutation does so (or the run becomes terminal).

**B5. Continuation must resume every suspended invocation.** **[T]** T8. Continuation must page through `host_invocations` for the run (up to 10,000 nodes per `interpreter.ts` budget). It polls each `leafExecution` and resumes those that are `Suspended`, in pages, all from one durable intent.

**B6. A preserved `startedAt` turns recovery into an immediate run TimedOut.** **[S]** Admission keeps the first `startedAt` (`host-store.ts:794–812`). When `startedAt + attemptTimeout` has passed, it **fences the whole run** as TimedOut (`:808–820`).

Counterexample: a 5-minute `attemptTimeout`, an operator who authorizes after 10 minutes, and an accepted receipt, after which the run times out. This is legal but useless. It is decision D2.

**B7. Cancel and deadline races must be decided by the host fence.** **[T]** In T6, engine interrupt followed by resume still executed the task. In T6b, the host fence won. In T6c, interrupting a leaf alone stranded the parent. The existing Cancel path writes the fence first and interrupts the parent too (`runner.ts:30–35`, `interpreter.ts:571–604`), so it is correct. Recovery must rely on the same rule:

- Authorization consumption and the fence check happen in **one** admission transaction.
- The mutation refuses if a fence exists.
- A fence that commits after the mutation wins at admission.
- A cancel that arrives after consumption is ordinary cancellation of a live task.

Run deadlines keep firing while the run is held, through the parent's `DurableClock`/`raceAll` (`deadline.ts:42–80`). The engine wakes the parent automatically, `expired` fences the run and the stop path interrupts the held leaves. **[I]** Not probed.

**B8. Quiescence is per run, not per entry.** See Q2. Without a per-entry live count, recovery is either blocked by unrelated siblings or unsafe.

**B9. An old daemon drops an unknown outbox kind.** **[S]** `runner.ts:20–60`: when `kind` is neither `Dispatch` nor `Cancel` and there is no `waitId`, the intent falls through to `acknowledge`. If a recovery intent reaches a downgraded daemon, the intent is acknowledged and lost. The run then shows `Running`/`Waiting` with a suspended leaf forever.

Fix: a host schema version that refuses to downgrade while unconsumed recovery generations exist, or a doctor check. A new daemon also re-derives undelivered generations at startup from `host_recoveries.state = 'Accepted'`.

## Smallest complete design

### Storage (host DB, one SQLite transaction per operation)

```sql
host_recovery_entries(runId, nodeId, activityAttempt, entry INTEGER,   -- entry that was found uncertain
  observedAt, observedOwner, generation INTEGER NULL,                   -- null until authorized
  consumedAt NULL, PRIMARY KEY(runId, nodeId, activityAttempt, entry))
host_recoveries(runId, generation INTEGER, token, actor, reason NULL, acceptedAt,
  state TEXT CHECK(state IN ('Accepted','Dispatched')), PRIMARY KEY(runId, generation))
host_recovery_receipts(runId, requestKey, actor, fingerprint, receiptJson, PRIMARY KEY(runId, requestKey))
```

### Admission (`admitAttempt`, one transaction)

Check in this order:

1. Fence, terminal or `Cancelling` returns `Cancelled`.
2. If the attempt deadline (D2) or the absolute deadline has passed, fence the run and return `TimedOut`.
3. For a prior manual entry, look for an authorized, unconsumed row for `(attempt, priorEntries)`:
   - If one exists, consume it, increment `entries`, set `owner`, emit `AttemptStarted{entry}` and return `Admitted`.
   - Otherwise, insert an uncertainty row for `priorEntries`, project `NeedsAttention`, emit `NeedsAttention{nodeId, attempt, entry}` with an entry-qualified key, and return `NeedsAttention`.
4. If the run is held, return `NeedsAttention`. The entry is gate-suspended and gets no uncertainty row.
5. Otherwise, admit normally.

An authorization covers exactly one entry. A replay after consumption finds no row for the new entry count and holds the run again ([T] T4).

### Mutation (`RunRecover`, one transaction, then the outbox)

1. Look up the receipt by `(runId, requestKey)` **before** checking current state:
   - Same fingerprint: return the original receipt.
   - Different fingerprint: `Conflict`.
2. Check `RunGet`'s principal boundary. Recompute the assessment. If its token differs from the one in the request, return `StaleAssessment` and change nothing.
3. Check the state is `Recoverable`, including that every listed entry has a live count of 0.
4. Set `generation` on all unresolved rows and insert into `host_recoveries`.
5. Project `Running`, emit `RecoveryAuthorized{generation, entries}`, and insert the outbox row `Recover` with intentKey `recover/${runId}/${generation}`.
6. Insert the receipt. Commit.

Dispatch pages through the run's invocations and calls `leafExecution.resume(engineId)` for each one whose poll is `Suspended`. After every page has been issued, it marks the recovery `Dispatched` and acknowledges the intent.

Crash safety:

- A crash before dispatch replays the outbox ([T] T5 shows the outbox is needed).
- A crash during dispatch re-resumes; resume is idempotent ([T] T7).
- A crash after consumption holds the run again ([T] T4).

No engine table is edited. No deadline or fence is cleared. No successful activity is deleted, and no result is injected.

### Public signatures (protocol and RPC)

```ts
export const RecoveryState = Schema.Literals([
  "Recoverable",
  "NotHeld",
  "Stopping",
  "Terminal",
  "Live",
  "RevisionUnavailable",
  "DeadlineElapsed",
  "AuthorizationLimit",
]);
export const UncertainEntry = Schema.Struct({
  nodeId: Schema.String, // invocation path, as RunGet/inspection show it
  taskId: Schema.String,
  taskVersion: Schema.String,
  attempt: Schema.Int, // retry attempt; unchanged by recovery
  entry: Schema.Int, // the entry whose result is unknown
  attemptId: Schema.String, // = Task.Identity.attemptId; stable across entries
  firstStartedAt: Schema.Finite,
  observedAt: Schema.String,
  attemptDeadline: Schema.NullOr(Schema.Finite),
  runDeadline: Schema.NullOr(Schema.Finite),
  priorAuthorizations: Schema.Int,
  publications: Schema.Int, // committed records under this invocation path (not evidence of success)
});
export const RecoveryAssessmentRequest = Schema.Struct({
  runId: Id,
  after: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))
  ),
});
export const RecoveryAssessment = Schema.Struct({
  runId: Schema.String,
  revision: Schema.String,
  status: RunStatus,
  state: RecoveryState,
  reason: Schema.String, // actionable text, e.g. "Run is stopping; use run get"
  token: Schema.NullOr(Schema.String), // hash over the FULL set + generation; same on every page
  total: Schema.Int,
  entries: Schema.Array(UncertainEntry),
  next: Schema.NullOr(Schema.String),
  suspendedInvocations: Schema.Int, // to be resumed, including gate-suspended siblings
  liveInvocations: Schema.Int, // still running siblings; may become uncertain later
});
export const RecoveryRequest = Schema.Struct({
  runId: Id,
  assessment: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  acknowledgeReexecution: Schema.Literal(true),
  requestKey: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
});
export const RecoveryReceipt = Schema.Struct({
  runId: Schema.String,
  requestKey: Schema.String,
  actor: Schema.String,
  acceptedAt: Schema.String,
  generation: Schema.Int,
  authorized: Schema.Int,
  outcome: Schema.Literal("Accepted"), // never "Recovered": completion is observed via run get/watch
});
Rpc.make("RunRecoveryGet", {
  error: OperationError,
  payload: RecoveryAssessmentRequest,
  success: RecoveryAssessment,
});
Rpc.make("RunRecover", {
  error: OperationError,
  payload: RecoveryRequest,
  success: RecoveryReceipt,
});
```

CLI:

- `run recovery <run-id> [--after] [--limit]`
- `run recover <run-id> --assessment <token> --acknowledge-reexecution [--request-key <key>] [--reason]`

When delivery is uncertain, `run recover` prints a message like cancel's: "Delivery uncertain. Retry with --request-key …".

New errors: `StaleAssessment`, returned with the current token, and `NotRecoverable`, returned with the state. These need new `OperationError` codes or reuse of `Conflict` (decision D6).

Events: `NeedsAttention{nodeId, attempt, entry}`, `RecoveryAuthorized{generation, actor, entries}` and `AttemptStarted{…, entry}`, all with entry- or generation-qualified keys.

## Required public decisions

- **D1. Selection.** Recommend **authorizing the whole current set** with no selection. Authorizing part of the set holds the run again as soon as an unselected entry replays ([T] T7), and holding again also re-blocks gate-suspended siblings. Selection is only useful together with a "fail this entry" alternative, and cancel already covers that.
- **D2. Attempt timeout for an authorized entry.** Choose between:
  - **(a) Recommended:** start a new `attemptTimeout` window for each authorized entry, and keep absolute run and scope deadlines unchanged.
  - **(b)** Keep `startedAt`, and refuse with `DeadlineElapsed`.

  Both are visible to users. Without one of them, B6 accepts a recovery and then times out the run.

- **D3. Status flow.** `NeedsAttention` → `Running` (which reconcile can turn into `Waiting`) → the normal flow, or `NeedsAttention` again for each new uncertainty. The receipt only means _accepted_.
- **D4. Numbering.** `attempt` and the retry budget stay the same, and `entry` increases. `Task.Identity` gets no new field, so `attemptId` and `ctx.key()` stay stable across entries. Document that this is the hook for external dedupe. A re-executed publication with the same key and different content stays a `Conflict`, and the guidance tells the user to publish under a new `options.key` if the output intentionally changes.
- **D5. Authorization limit.** At most 16 authorized entries per attempt (`AuthorizationLimit`) and 64 receipts per run, matching cancel.
- **D6. Error codes.** Add `StaleAssessment` and `NotRecoverable`, or reuse `Conflict`/`Unavailable` with structured messages. Decide the CLI exit codes: assessment exits `0` for every state and prints `state`, and the mutation exits non-zero on any refusal.
- **D7. Principal.** Assessment uses `RunGet`'s principal check. The mutation needs the same authority as `RunCancel`.
- **D8. Old daemon and downgrade.** A new CLI talking to an old daemon gets "requires daemon upgrade". Choose between refusing to downgrade and a doctor warning (B9).
- **D9. Report and scheduled runs.** Report runs with a manual reporter use the same path, and their sources keep retention protection. A held run still blocks scheduled overlap. Recovery never projects a terminal state.

## Proof gates (Effectory tests, real interpreter, installed Effect)

1. Kill a manual task mid-handler and restart: the run is held, the handler is not re-entered, and a second restart does the same (T1).
2. Success is committed to the engine but not projected: after restart the run is not held and nothing re-executes.
3. Authorize, then crash (a) before dispatch, (b) during resume paging, (c) after consumption but before the result: exactly one more execution, and the run is held again in case (c) (T3–T5).
4. Duplicate `requestKey`: the same receipt comes back even after the state changes. Different payload with the same key: `Conflict`. A lost response retried: no second authorization.
5. Two operators submit the same token with different keys: one accepted, one `StaleAssessment`.
6. A new uncertain entry appears after assessment (B1 ordering): `StaleAssessment`.
7. Cancel before the mutation is refused. Cancel after the mutation but before consumption: `Cancelled` with no execution. Cancel after consumption: ordinary cancel (T6b). The run deadline expires while held: `TimedOut` with no execution.
8. A slow finalizer of an in-process entry, and a long-running sibling: the entry is refused as `Live`, and the sibling does not block other entries (B8).
9. Fan-out with several uncertain leaves, gate-suspended siblings, successful branches and settled waits: everything resumes, nothing settled runs again, and the parent completes (T7, T8).
10. A held run with an in-flight sibling publish succeeds (B2). A sibling wait settles while held and the hold is kept (B4).
11. Re-entry publishes the same content under the same key and gets the existing record. Different content gets `Conflict` with guidance.
12. The pinned revision is used after a newer deployment. A missing revision is refused as `RevisionUnavailable`.
13. A manual reporter in a report run; Lake reader pins, a Vault tracker and a task Layer are rebuilt and closed for each entry. A re-hold emits a new event (B3).
14. Under concurrent load, a manual task is never executed without an unconsumed authorization. Assert `executions(attempt) ≤ 1 + consumedAuthorizations(attempt)` in every test.

## Blockers summary

B1–B9 above. The engine is not a blocker. Every blocker is a host-store, projection, outbox or resource-tracking fix that public signatures depend on. They need to be resolved in the next design draft and then re-reviewed.
