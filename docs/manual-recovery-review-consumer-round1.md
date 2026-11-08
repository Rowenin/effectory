# Manual recovery — consumer review, round 1

Status: design review of [manual-recovery-research.md](manual-recovery-research.md), 2026-11-06. This is not user approval. No production code changed. One scratch probe ran outside the checkout. Synthetic names only.

Review lenses: consumer workflow (the author and the operator), CLI/RPC ergonomics, and operational recovery.

Evidence tags used below:

- **[Probe]**: executed in this review against the installed package.
- **[Source]**: read in the current checkout at the cited line. Not executed.
- **[Swamp]**: read in `vendor/swamp`. Not executed.
- **[Inference]**: reasoning from the above. Needs a proof gate before anyone relies on it.

## 1. Verdict

The candidate's direction is right: one read-only assessment, one atomic mutation that both authorizes and schedules continuation, no result injection, and consumption inside attempt admission. It is not yet a complete contract. Six blockers in current behavior would make a recovery feature misleading or unsafe even if the new API were implemented exactly as sketched (§4). The biggest gap is that `NeedsAttention` is a **run status**, while uncertainty belongs to **one attempt**. Several code paths can overwrite or bypass that status, and nothing durable records which attempts are uncertain.

My recommendation is a smallest complete design (§6) built on durable per-attempt **hold rows**. The run status is derived from them. Authorization is per hold and consumed once in admission. The operator-facing surface is one CLI command and two RPCs. In v1, scope is per-run and covers all current uncertain holds; per-invocation selection is a deliberate public decision (§5). No new author reconciliation hook and no task-context field are needed for correctness (§7). Duplicate external effects and publication conflicts stay explicit consequences, not things the runtime hides.

## 2. What Swamp actually does

[Swamp] `vendor/swamp/src/cli/commands/workflow_recover.ts`, `domain/workflows/recovery_assessment.ts`, `domain/workflows/workflow_run.ts:1642–1800`, `domain/workflows/execution_service.ts:5727–5800`:

1. **Discovery.** `recover <workflow>` finds dead-owner runs (process liveness via a run tracker) and `interrupted` runs. Without `--run`, it picks the **newest** interrupted run. That implicit choice is a consumer hazard Effectory should not copy: always require the run ID.
2. **Assessment.** It refuses on any definition-fingerprint mismatch, including legacy runs without a recorded definition fingerprint. It splits `unknown` steps into _guarded_ and _unguarded_. `canAutoRecover` means no mismatch and no unguarded steps.
3. **Granularity.** Recovery resets **every** unknown step in the run. There is no per-step selection. `--acknowledge-unknown` is a single run-wide acknowledgement.
4. **Mutation.** `--assess-only` is opt-in; the **default mutates**. The mutation withdraws settled step starts, resets unknown steps to `pending` and the run to `suspended` with `recovered = true`, then saves. It prints a separate `swamp workflow resume … --run <id>`. `awaitsResumeAfterRecovery` keeps `serve` from continuing the run on its own, so the operator must issue the second command.
5. **No request key, token or receipt.** There is no stale-assessment check between assess and recover beyond re-evaluating state at mutation time. A lost response is resolved by rerunning `--assess-only`.
6. **Guards are the reconciliation hook.** A step's `guard` is an authored CEL expression that runs before the step and may call model methods. If it is truthy, the step is **skipped**, not succeeded with a value. An abort during guard evaluation leaves the step pending. So Swamp's "auto-recoverable" really means "the author supplied an idempotence predicate".

Parity reading: Swamp's operator capability is _authorize re-execution of all unknown work in one run, then resume_. Its author capability is _declare a pre-step skip predicate_. Effectory already has the author half in a different shape (§7). The missing piece is the operator half.

## 3. Effectory today

| Fact | Evidence |
| --- | --- |
| Attempt identity is `(runId, nodeId, activityAttempt)`. A manual task with a prior attempt row sets the **run** to `NeedsAttention`. Any later admission in that run, for any node, returns `NeedsAttention` while the status holds. | [Source] `host-store.ts:764–850` |
| The fence check runs before the NeedsAttention check, so a stop wins over a hold at admission. | [Source] `host-store.ts:772–784` |
| `startedAt` is preserved across re-entry. The attempt timeout is measured from the **original** start. | [Source] `host-store.ts:789–800` |
| Each attempt is a journaled Activity `handler/${attempt}` inside a per-leaf child workflow (`idempotencyKey = [runId, nodeId]`). Admission runs **inside** the Activity body, and NeedsAttention calls `Workflow.suspend`. | [Source] `interpreter.ts:152, 200–223, 345–351` |
| A retry after a Domain failure is a new activity (`handler/N+1`). Only an uncommitted `handler/N` re-enters with the same N. | [Source] `interpreter.ts:345–400` |
| `ctx.key(name)` is `[runId, nodeId, name]` and `ctx.attemptId` is `run/node/attempt`. Both are stable across re-entry. | [Source] `interpreter.ts:80, 95` |
| The publication key is `[runId, invocationPath, output, key]`, so it does not depend on the attempt. An identical repeat returns the same receipt; different content fails with `Conflict`, which surfaces as `PublicationConflict`. | [Source] `lake.ts:218–275, 492`; `artifact-storage.md:41` |
| Publication requires run status ∈ {Queued, Running, Waiting, Retrying}, no fence, and `owner === lease.token`. | [Source] `lake.ts:249–257` |
| The attention event key is `attention/${nodeId}/${attempt}`. A second event with the same key is silently dropped. | [Source] `host-store.ts:342–356, 828–834` |
| A wait decision projects `Running` unconditionally (except terminal/same). `project` does not protect `NeedsAttention`. | [Source] `interpreter.ts:529–531`, `host-store.ts:1300–1325` |
| Outbox `Settle` deliveries are withheld while the status is `NeedsAttention`. | [Source] `host-store.ts:1292` |
| `NeedsAttention` is also used for a finalization stall after a stop. | [Source] `runner.ts:65–82` |
| Active execution is counted **per run**, not per attempt. | [Source] `execution-resources.ts:28–47` |
| Report admission excludes `NeedsAttention` from its limit of 4. Execution is separately bounded by the in-process `reports` semaphore (4). | [Source] `host-store.ts:600–610`, `execution-resources.ts` |
| A schedule is `Blocked` by any non-terminal active run, including a held one. | [Source] `schedule-store.ts:153–161` |
| Reader pins are released only at terminal status. Queries run fresh on every attempt. | [Source] `lake-protection.ts:6, 34–42, 131–157`; `artifact-reads.md:43` |
| `run watch`/observation stops at `NeedsAttention`. The CLI exit code for a non-terminal end is 4. | [Source] `cli/src/observation.ts:31`, `cli/src/main.ts:240` |
| Cancellation receipts: the principal check, then the request-key replay (with a fingerprint conflict check), then current-state validation; capped at 64 per run. | [Source] `host-store.ts:651–720` |
| Installed Effect 4.0.5 exposes `Workflow.resume(executionId)`. `ClusterWorkflowEngine` distinguishes explicit and automatic resume and has a parent-resume path. | [Source] `node_modules/effect/src/workflow/Workflow.ts:410`, `cluster/ClusterWorkflowEngine.ts:285–335` |
| **With the in-memory engine**, a leaf that suspends **inside an Activity** leaves both the leaf and its parent `Suspended`. An explicit `Leaf.resume(id)` re-runs the Activity body (entry 2), the leaf completes, and the parent continues to `Complete` without its own resume. | [Probe] scratch `probe.ts`, output below |

```text
parent poll before Suspended
leaf poll before Suspended
leaf poll after Complete Success "done-p/leaf-entry2"
parent poll after Complete Success "parent:done-p/leaf-entry2"  entries 2
```

The probe does **not** cover `ClusterWorkflowEngine` on SQL, a process kill, or an automatic wake. Question 1 from the research doc is only partly answered: the primitive exists and composes leaf→parent in memory.

## 4. Blockers in current behavior (concrete counterexamples)

Each item is a failure that a naive "lift NeedsAttention and resume" implementation inherits.

**B1. A held run can silently become Running again.** [Source + Inference] Leaf X (manual) re-enters after a crash and sets the run to `NeedsAttention`. Sibling branch W had a `Settle` delivered just before that, because the outbox filter is checked at read time. W's continuation calls `project(run, "Running")`, which overwrites `NeedsAttention`. The run now reports `Running`, and X stays suspended with no operator-visible hold. It is not silently re-executed, because the next re-entry holds again, but the operator is told nothing is wrong. _Required:_ durable hold rows as the source of truth, and `project` must not leave `NeedsAttention` while any hold is open.

**B2. A running sibling breaks when another leaf is held.** [Source + Inference] Sibling Y is mid-handler when X holds the run. Y's `context.publish` now fails with `Conflict: Publication attempt is no longer admitted` because `NeedsAttention` is not an admitted status. Y fails and the failure reaches the parent. Under fail-fast composition, the parent can interrupt the suspended X and finish `Failed`. The uncertainty about X is then buried inside a Failed run that recovery cannot touch. _Required:_ an in-flight admitted entry stays admitted for publication while another hold is open. The hold gates **new** admissions only.

**B3. A re-hold is invisible.** [Source] After one authorized entry is consumed and the daemon dies again, the second hold reuses event key `attention/X/1`, so no event is written. A `run recover --watch` that is following the run never sees the second hold. _Required:_ include the entry number in the hold event key (`attention/X/1/2`).

**B4. Authorized re-entry can immediately time out the whole run.** [Source] Task `charge` has `attemptTimeout: "5 minutes"`. The daemon dies at minute 2. The operator authorizes the next morning. Admission computes `startedAt + 5m < now`, writes a **TimedOut fence** and the run ends `TimedOut`. The operator's authorization resulted in a run failure and no re-execution. _Required:_ a public decision (D3) and an assessment that shows this outcome before authorization.

**B5. "No old handler is running" cannot be proven per attempt.** [Source + Inference] `active(runId)` counts the whole run. With live siblings it is never 0, and a zero count would not prove anything about X alone. Attempt ownership is `owner = lease.token`, so a stale in-process handler for X has the same owner as a fresh entry. That matters if the engine ever re-delivers an Activity in the same process, which is unproven either way. _Required:_ internal per-attempt entry fencing (§6.6). This is not a public API.

**B6. The status cannot tell an uncertain hold from a finalization stall.** [Source] `runner.ts:81` uses `NeedsAttention` for "stopped run still has unfinished execution". Authorizing re-execution there would be wrong, because a fence exists and the stop must win. _Required:_ hold rows carry their reason, and the assessment refuses `FinalizationStalled`.

Non-blocking consequences that must be documented:

- **C1. Duplicate external effects.** Re-execution runs the same body with the same `ctx.key` and `ctx.attemptId`. If the provider does not deduplicate by that key, the action repeats. Nothing in the run proves whether the first entry's external effect happened. Published artifacts and logs from the earlier entry are evidence for a human. They are never proof.
- **C2. Publication conflicts.** If the earlier entry published `key: "main"` and the re-execution produces different content (for example, a new provider-assigned ID), the publish fails `PublicationConflict` and the invocation fails. That is correct: the lake must not hold two truths for one invocation. The assessment must list the existing publications so the operator sees this coming. The author guidance is to reconcile to the original resource, or to publish provider-variant data under a key that includes a value the provider returns, not under a fixed key.
- **C3. Fresh reads.** A re-executed reader sees the **current** latest version, which may differ from what the first entry read. Pins from both entries are held until terminal status.
- **C4. Report capacity.** Recovering a held report run can bring active report records to 5 against an admission limit of 4. Execution stays bounded by the semaphore. Recommendation: allow it and document it. Refusing would strand a held report behind fresh admissions.
- **C5. Schedules.** A held scheduled run blocks its schedule until recovery or cancel. `ScheduleGet.blockedBy.status` already shows `NeedsAttention`, so no change is needed.

## 5. Per-run versus selected invocation recovery

**Counterexample for per-run.** Fan-out `charge[eu]`, `charge[us]`, `charge[apac]`, all `replay: "manual"`. The daemon dies with all three admitted. The operator checks the provider console: `eu` was charged; `us` and `apac` were not. Per-run authorization re-executes all three, so `eu` is charged twice unless the body reconciles. The only alternative is cancelling the run.

**Counterexample for selection alone.** Selecting `us` and `apac` leaves the `eu` hold open forever. Its only remaining dispositions are still "authorize" (a double charge) or "cancel run". Selection without a third disposition ("mark this invocation done" or "fail just this invocation") does not let the run finish without one of those two outcomes. Success injection is ruled out. "Fail this invocation" (an `Abandoned` control failure that composition can catch) is a real new public outcome that touches every task's error union.

**Implementation consequence.** [Source + Inference] Today the run-wide status gate blocks every admission. Selection only helps if gating moves from run status to per-hold rows, so `us` and `apac` can be admitted while `eu` stays held. With hold rows (§6) that is cheap to implement, but it changes what users see: a run can make progress while also showing `NeedsAttention`.

**Recommendation.**

- v1 authorizes **all current uncertain holds** in the run, bound by the assessment token. That is complete: every hold reaches re-execution or cancellation, and the operator never has to coordinate commands.
- The `eu` case is solved by the author (§7), not the operator. A task that is safe to reconcile performs the lookup in its body and therefore re-executes harmlessly. A task that cannot reconcile is exactly the case where per-run versus selection does not save the run anyway.
- Keep the request shape forward-compatible: `scope: { _tag: "AllUncertain" }`. Adding `{ _tag: "Holds", holdIds }` later is additive.
- **Public decision D1**: ship selection and `Abandoned` together later, or never. Do not ship selection alone.

## 6. Proposed smallest complete design

### 6.1 Internal model (not public, but required)

- `host_attempt_holds(runId, holdId, nodeId, activityAttempt, entry, reason, createdAt, resolvedAt, resolution)`
  - `reason ∈ {UncertainManualEntry, GatedByRunHold}`
  - `resolution ∈ {Authorized, Superseded}`
- `host_recovery_authorizations(runId, authorizationId, requestKey, actor, fingerprint, holdGeneration, receiptJson)` plus one row per authorized hold: `(holdId, consumedAt, consumedEntry, outcome)`.
- `host_runs.holdGeneration`: a counter incremented on every hold creation and authorization. The assessment token is derived from it.
- Status is derived. The run is `NeedsAttention` iff an open `UncertainManualEntry` hold exists or a finalization stall exists. `project` must not move the run out of `NeedsAttention` while either holds (fixes B1).
- `GatedByRunHold` rows record sibling leaves that suspended on the run gate. They are never "authorized". They are resumed with the authorization, because their suspended leaf executions also need an explicit resume.

### 6.2 RPCs

```ts
// packages/runtime/src/protocol.ts (proposed)
export const RecoveryToken = Schema.NonEmptyString.check(Schema.isMaxLength(200)) // opaque "rcv1.…"

export const HeldInvocation = Schema.Struct({
  holdId: Schema.String,
  invocationPath: Schema.String,          // e.g. "charge[us]"
  taskId: Schema.String,
  taskVersion: Schema.Int,
  attempt: Schema.Int,                    // unchanged by recovery
  attemptId: Schema.String,               // same value the task saw
  entries: Schema.Int,                    // entries already started for this attempt
  priorAuthorizations: Schema.Int,
  firstStartedAt: Schema.String,
  lastEnteredAt: Schema.String,
  reason: Schema.Literals(["UncertainManualEntry", "GatedByRunHold"]),
  publications: Schema.Struct({           // evidence, never proof
    count: Schema.Int,
    preview: Schema.Array(ArtifactRefPreview), // ≤ 5
  }),
  deadline: Schema.Struct({
    run: Schema.NullOr(Schema.String),
    attempt: Schema.NullOr(Schema.String),
    onAuthorize: Schema.Literals(["WithinDeadline", "WillTimeOut"]),
  }),
})

export const RecoveryRefusal = Schema.Union([
  Tagged("NotHeld", {}),                       // nothing uncertain
  Tagged("Terminal", { status: RunStatus }),
  Tagged("Stopping", { outcome: Schema.Literals(["Cancelled", "TimedOut"]) }),
  Tagged("FinalizationStalled", {}),
  Tagged("RevisionUnavailable", { revision: Schema.String }),
  Tagged("DeadlineElapsed", { deadline: Schema.String }),     // run-level
  Tagged("ExecutionActive", { holdIds: Schema.Array(Schema.String) }), // B5
  Tagged("AuthorizationPending", { authorizationId: Schema.String }),
])

export const RecoveryAssessment = Schema.Struct({
  runId: Schema.String,
  revision: Schema.String,
  status: RunStatus,
  token: Schema.NullOr(RecoveryToken),    // null when refused
  refusals: Schema.Array(RecoveryRefusal),
  totals: Schema.Struct({ uncertain: Schema.Int, gated: Schema.Int }),
  holds: Schema.Array(HeldInvocation),    // one page
  nextCursor: Schema.NullOr(Schema.String),
  authorizations: Schema.Array(RecoveryAuthorizationStatus), // most recent ≤ 10
  consequence: Schema.Literal(
    "Authorizing re-executes every uncertain invocation. External actions may repeat. Changed publications fail PublicationConflict."
  ),
})

export const RecoveryRequest = Schema.Struct({
  runId: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  requestKey: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  token: RecoveryToken,
  acknowledge: Schema.Literal("ReexecuteUncertainInvocations"),
  scope: Schema.TaggedStruct("AllUncertain", {}),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
})

export const RecoveryReceipt = Schema.Struct({
  authorizationId: Schema.String,
  runId: Schema.String,
  requestKey: Schema.String,
  actor: Schema.String,
  reason: Schema.NullOr(Schema.String),
  acceptedAt: Schema.String,
  authorized: Schema.Array(Schema.Struct({ holdId: Schema.String, invocationPath: Schema.String, attempt: Schema.Int, entry: Schema.Int })),
  status: Schema.Literal("Accepted"),     // never "Recovered"; completion is observed elsewhere
})

export const RecoveryAuthorizationStatus = Schema.Struct({
  authorizationId: Schema.String,
  acceptedAt: Schema.String,
  actor: Schema.String,
  holds: Schema.Array(Schema.Struct({
    holdId: Schema.String,
    state: Schema.Literals(["Pending", "Consumed", "Superseded", "ReHeld"]),
    consumedEntry: Schema.NullOr(Schema.Int),
  })),
})

Rpc.make("RunRecoveryGet", { payload: { runId, cursor?: string, limit?: 1..200 = 50 }, success: RecoveryAssessment, error: OperationError })
Rpc.make("RunRecover",     { payload: RecoveryRequest, success: RecoveryReceipt, error: OperationError })
```

`OperationError` codes: `NotFound` (the same principal boundary as RunGet), `InvalidInput`, `StaleAssessment { current: token|null, change: "NewHold"|"Authorized"|"Stopped"|"Resolved" }`, `Refused { refusals }`, `Conflict` (request key reused with a different fingerprint), `LimitExceeded` (64 authorizations per run), `Unavailable` (an old daemon: unknown RPC).

### 6.3 CLI

Use one command name. It is read-only by default; the mutation needs two explicit flags. `run recovery` and `run recover` differ by two letters, so pairing them invites typing the wrong one.

```text
effectory run recover <run-id> [--cursor c] [--limit n]                 # assess; exit 0 if recoverable, 3 if refused
effectory run recover <run-id> --authorize <token> --acknowledge-reexecution
                     [--reason text] [--request-key k] [--watch]         # mutate; exit 0 Accepted (or watch result)
```

- Unlike Swamp, the default does not mutate.
- If `--request-key` is omitted, a UUID is generated and printed on an uncertain-delivery error, mirroring `run cancel` (`main.ts:684–705`).
- `--watch` follows the run after acceptance. It ends on terminal status (exit 0/1) or on a **new** hold (exit 4, the existing non-terminal code), and prints the new assessment command.
- JSON output is the schema value; text output prints the consequence sentence verbatim.

### 6.4 Transaction semantics

**`RunRecover`, one SQLite transaction:**

1. Principal check (NotFound).
2. Request-key replay: if the key exists and the fingerprint matches, return the stored receipt **before** any state validation. A mismatch is `Conflict`. Fingerprint = `{token, acknowledge, scope, reason}`.
3. Recompute the assessment. If the token's generation differs, return `StaleAssessment` with the change kind. If the only change is that another key authorized the same holds, the change is `Authorized` and carries that `authorizationId`. That way, two concurrent operators see "already done by X", not a vague stale error.
4. Any refusal returns `Refused`. This includes a fence, terminal status, revision unavailable, run deadline elapsed, an attempt whose old entry may still be live (§6.6), and any authorization still `Pending`.
5. Insert the authorization and one row per uncertain hold. Resolve those holds as `Authorized` and bump `holdGeneration`. Re-derive the status (→ `Running` when no other hold remains). Enqueue an outbox `Resume { leafExecutionIds }` covering both uncertain **and** gated holds. Append event `RecoveryAuthorized/<authorizationId>`. Store the receipt.

**Admission (`admitAttempt`), still one transaction:** fence → terminal → open uncertain hold in run (gate; record a `GatedByRunHold` row) → deadline → `prior && manual`:

- If a `Pending` authorization row matches `(run, node, attempt)` and `consumedEntry IS NULL`: consume it (`consumedEntry = entries + 1`) and admit. Event `AttemptReentered/<node>/<attempt>/<entry>`.
- Otherwise: create a hold `UncertainManualEntry` with `entry = entries`. Event `attention/<node>/<attempt>/<entries>` (B3).

**Outbox delivery:** call `leafExecution.resume(executionId)` for each listed leaf. It is idempotent: resuming a non-suspended execution is a no-op [Source: `ClusterWorkflowEngine.ts:293–296`, `Option.isNone(maybeSuspended) → return`].

### 6.5 Crash windows (expected behavior → gate in §9)

| Dies after… | Result |
| --- | --- |
| Authorization commit, before outbox delivery | Startup replays the outbox, resumes the leaves, and the authorization is consumed. No user action needed. |
| Resume, before admission consumption | The authorization is still `Pending`. The next activation consumes it. |
| Consumption commit, before the handler's external effect | Next re-entry: no pending authorization → **new hold**, `entry = 2`. The operator must authorize again, even though nothing ran. This is accepted: the runtime cannot know. |
| Handler effect, before the activity result is journaled | Same as the previous row. This is the case the feature exists for. |
| Result journaled, before projection | The engine replays the result; there is no admission and nothing re-executes. |
| Cancel/deadline between authorization and consumption | The fence wins in admission → `Cancelled`/`TimedOut`. The authorization shows `Superseded` on the terminal transition. The receipt still says `Accepted`, as it should. |

At no point does a manual entry start without a consumed authorization, and one authorization can never admit two entries.

### 6.6 Quiescence (internal)

The assessment and the mutation refuse `ExecutionActive` for a hold unless one of these is true:

- the attempt row's `owner` is a previous lease token. Exclusive lease ⇒ that process is gone [Source: `lease.assertActive` and `owner` column; exclusivity itself must be gated].
- a new per-`(run, node, attempt)` in-process tracker reports zero live entries.

Also record `entry` on admission and capture it in the handler. Publication and progress writes then check `entries == capturedEntry` alongside `owner == lease.token`, so a stale in-process entry cannot publish after a newer entry was admitted (B5). Siblings are **not** quiesced. They keep running and publishing (B2) and are gated only at their next admission. Recovery manufactures no cancellation outcome for them.

### 6.7 Attempt numbers, retries and deadlines

- The attempt number, `attemptId`, the retry budget and `ctx.key` stay **unchanged**. Re-entry re-runs Activity `handler/N`; advancing to N+1 would require editing the journal. `entries` increments. Users see attempt 1, entry 2.
- Run/ancestor deadlines never reset. An elapsed run deadline means `DeadlineElapsed` is refused, and the operator is told to cancel.
- Attempt timeout: **D3** (§8).

## 7. Does retry or recovery need an author reconciliation hook?

No new hook for v1. Reasoning:

- [Source] `ctx.key(name)` and `ctx.attemptId` are stable across re-entry. An author who can reconcile writes _look up by key, else act_ in the body. If that lookup is always reliable, the honest declaration is `replay: "idempotent"`, which Effectory already supports. That is exactly Swamp's guarded or "auto-recoverable" case. If the lookup needs human judgment, the task stays `manual`, and the authorized re-entry runs the same reconciling body.
- Swamp's guard **skips** a step without output. An Effectory task must return a typed success that downstream nodes consume. A skip-style hook would need to synthesize that success, which is the result injection the candidate correctly forbids. A hook shaped like `reconcile(input, ctx) => Option<Success>` is just the first half of the body, so a separate hook adds surface without adding power.
- The retry loop does not need one either. Domain-failure retries create a new activity with a recorded failure, so they are not uncertain.

The cost, stated plainly: the body cannot tell the first entry from an authorized re-entry, so it always pays for the lookup. That is a performance concern, not a correctness one. A `ctx.entry` field would fix it. Record it as **D5** rather than adding it silently.

Author example (synthetic):

```ts
const Charge = Task.make(
  {
    id: "billing/charge",
    version: 1,
    replay: "manual",
    input: Schema.Struct({ account: Schema.String, cents: Schema.Int }),
    success: Schema.Struct({ chargeId: Schema.String }),
    error: Schema.TaggedStruct("Declined", {}),
    outputs: { receipt: ChargeReceipt },
  },
  (input, ctx) =>
    Effect.gen(function* () {
      const provider = yield* PaymentsClient;
      const key = ctx.key("charge"); // same value on every entry
      const existing = yield* provider.findByClientKey(key); // reconciliation lives in the body
      const charge = Option.isSome(existing)
        ? existing.value
        : yield* provider.create({ ...input, clientKey: key });
      // Publication key is per invocation, so a re-entry that reconciled publishes identical content → same receipt.
      // A re-entry that created a *second* charge publishes a different chargeId → PublicationConflict (visible, not hidden).
      yield* ctx.publish("receipt", { chargeId: charge.id }, { key: "main" });
      return { chargeId: charge.id };
    })
);
```

This task remains `manual` because `findByClientKey` lags behind `create` by up to a minute (a synthetic provider property). A lookup in the window right after a crash may miss, and a human should look before authorizing.

## 8. Required public decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Per-run versus selected invocation; whether to add an `Abandoned` disposition | v1 per-run `AllUncertain`. Selection only together with `Abandoned`, decided separately. |
| D2 | CLI shape and default | `run recover` read-only by default; `--authorize <token> --acknowledge-reexecution` to mutate. |
| D3 | Attempt timeout on authorized re-entry | Per-entry window: re-entry `startedAt` = consumption time for **timeout** purposes; first `startedAt` kept for display. Otherwise B4 makes recovery of any timed task pointless. Run deadlines are never reset. |
| D4 | Status during authorized-but-unconsumed | No new status. `Running`, plus a `recovery.pending` count on RunGet. |
| D5 | `ctx.entry` exposure | Not in v1. Revisit if authors report lookup cost. |
| D6 | Report admission over-limit after recovery (C4) | Allow, because execution is semaphore-bounded. Document it. |
| D7 | Event names and payloads: `RecoveryAuthorized`, `AttemptReentered`, entry-keyed `NeedsAttention` | Accept, entry-keyed. Watch clients must not dedupe by node/attempt. |
| D8 | Limits | 64 authorizations per run; assessment page 50 by default, 200 max; publication preview ≤ 5. |
| D9 | Old daemon | A new CLI against an old daemon prints "daemon does not support recovery" (unknown RPC) and exits 2. A downgraded daemon ignores authorization rows, so admission holds again. That fails closed and must be gated. |
| D10 | Revision retention | A held run's revision must stay retained. Refuse `RevisionUnavailable`; never resolve against current code. |

## 9. Proof gates

Use `ClusterWorkflowEngine` with real SQLite and real process kills unless stated. Synthetic tasks only.

1. **Engine.** Kill during a manual handler → restart → hold. Authorize → explicit leaf resume → parent continues. Repeat with an **automatic** wake (restart while held, unrelated deferred, clock) and assert the leaf is not re-entered without authorization. (Extends the memory [Probe] in §3.)
2. **Success before projection.** Journal the result, kill before `project` → restart → no hold, no re-entry.
3. **Every row of §6.5.** Inject a kill at each point and assert entry counts, authorization state, events and the final status. The invariant across all of them: count of handler entries ≤ 1 + count of consumed authorizations.
4. **Duplicate and lost-response requests.** The same key returns a byte-identical receipt, even after the run has become terminal. The same key with a different token or reason → `Conflict`. A response dropped at the transport → a retry with the key → the same receipt, no second authorization.
5. **Stale assessments.** A new hold appears between assess and authorize → `StaleAssessment{NewHold}`. Two operators race on one token → one `Accepted`, the other `StaleAssessment{Authorized, authorizationId}`.
6. **Cancel/deadline races.** Cancel before authorize → `Refused{Stopping}`. Cancel after authorize, before consumption → `Cancelled`, authorization `Superseded`. A run deadline elapses while held → `DeadlineElapsed`. Each D3 timeout variant shows the expected outcome.
7. **B1.** A wait settles concurrently with a hold → the status stays `NeedsAttention` until authorization.
8. **B2.** A sibling mid-handler publishes successfully while another leaf is held. Its later retry is gated.
9. **B3.** A re-hold after a consumed authorization emits a new event, and `--watch` exits 4.
10. **B5.** A stale in-process entry's publish after a newer entry → `Conflict`. `ExecutionActive` is refused while an old entry lives.
11. **Fan-out.** Three uncertain leaves and two gated leaves: one authorization re-enters exactly the three, resumes the two, and leaves successful branches and settled waits untouched.
12. **Publications.** An identical re-publish returns the same receipt. A changed one fails `PublicationConflict`, and the run's error names the existing ref.
13. **Pinned revision.** Deploy revision 2 while a revision-1 run is held → recovery executes revision 1 code. Revision 1 unavailable → `RevisionUnavailable`.
14. **Manual report task.** A held report run is recoverable. Its retention protection on the source is held throughout, no terminal transition is fabricated, and admission behaves as D6 says.
15. **Lifecycle after re-entry.** Reader pins from both entries are held until terminal and then released. The Vault tracker is fresh per entry. A task-local Layer is acquired once per entry and released. Schedule `blockedBy` follows the status.
16. **Old daemon.** The D9 behaviors in both directions.
17. **Principal boundary.** Another principal gets `NotFound` from both RPCs, identical to RunGet.
18. **Negative global gate.** Across the whole suite, no manual handler entry happens without a matching consumed authorization. Assert this from the attempt and authorization tables at teardown.

## 10. Summary for the coordinator

- **Blockers:** B1 (status overwrite), B2 (siblings' publications fail while held), B3 (re-hold event deduped), B4 (attempt timeout fences authorized re-entry), B5 (no per-attempt quiescence or entry fence), B6 (stall versus uncertainty conflated). All six come from current source; none was executed.
- **Proposed signatures:** `RunRecoveryGet`, `RunRecover`, `RecoveryAssessment`, `RecoveryRequest`, `RecoveryReceipt`, `RecoveryRefusal`; CLI `run recover <id> [--authorize <token> --acknowledge-reexecution]` (§6.2–6.3).
- **Public decisions:** D1–D10 (§8). D1 and D3 matter most.
- **Proof gates:** §9. Gate 1 (cluster engine with automatic wake) and gate 18 (no unauthorized entry) must pass before any API ships.
- **Only executed evidence:** the in-memory engine probe. Suspend inside an Activity, then an explicit leaf resume, re-runs the body and completes the parent.
