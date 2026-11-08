# Manual recovery — consumer review, round 2

Status: narrowed re-review of [consolidated draft 2](manual-recovery-api-draft.md), 2026-11-06. This is reviewer review only, not user approval. No production code exists or changed. No scratch probe was needed for this round; every claim below is from reading the current checkout ([Source]) or from reasoning about the draft's text ([Inference]).

Scope, as instructed: check that round 1's B1–B6 are resolved, that the deliberate decisions are stated as a complete consumer contract, and find exact contract holes. This is not a redesign.

## 1. Verdict

**Conditionally ready for presentation.** No new public decision is needed. The deliberate choices (all-current-holds, a fresh window only for authorized manual re-entry, one read-only-by-default command, existing error codes, a whole-set token, 16/64 limits, lifetime receipts, cancellation kept available) form a coherent contract, and B1–B6 are each addressed.

Before presentation, the parent must make the corrections in §3. All of them are text or mechanical clarifications that fit decisions the draft has already made. One is a factual error that contradicts the "existing codes" decision: the exit-code mapping (§3.1). One optional additive field (§4) is the only thing that touches a proposed shape. If the parent applies §3 as written, no round 3 is needed.

## 2. Round-1 blockers

| Round 1 | Draft 2 resolution | Status |
| --- | --- | --- |
| B1 status overwritten by a wait settlement or runner poll | "Status remains NeedsAttention while unresolved uncertainty exists. A wait settlement or stale runner poll cannot overwrite it." Gate 6. | Resolved. The transition at acceptance is still unspecified; see §3.3. |
| B2 a running sibling cannot publish during a hold | Siblings in flight may finish and publish, using their captured entry, lease and the absence of a fence. Closed or superseded entries may not. Readers too. Gate 6. | Resolved. |
| B3 a re-hold event is deduplicated away | Event keys include the entry or generation. `NeedsAttention` carries attempt and entry. Gate 6: "Re-hold produces a new event". | Resolved. Without `--watch`, the operator-facing rendering needs one line; see §3.8. |
| B4 an authorized re-entry immediately times out | A fresh attempt window for authorized manual re-entry only. Absolute deadlines are fixed and act as a cap. The uncertainty is recorded _before_ the expired prior-entry timeout can fence. Gate 5. | Resolved. The meaning of the event fields needs pinning; see §3.6. |
| B5 no per-attempt quiescence or entry fence | Per-attempt live ownership from admission through Layer finalization. A captured entry fence. `ExecutionActive` refuses while the target's previous entry or finalizer lives. Unrelated siblings do not block. Gate 6. | Resolved. |
| B6 a finalization stall is conflated with uncertainty | A separate `FinalizationStalled` state placed in the precedence ahead of uncertainty. No token is issued unless the state is `Recoverable`. | Resolved. |

The draft also correctly drops round 1's `StaleAssessment`/`Refused` codes, the `scope` field, the `--watch` flag, the per-entry publication preview and the `RunGet` pending count, consistent with the decisions above.

## 3. Required corrections (small; no new public decision)

### 3.1 Exit codes are misstated — factual error

Draft: "InvalidInput/Conflict/RevisionUnavailable map to exit 2, Unavailable to 3, and LimitExceeded to 5."

[Source] `packages/cli/src/main.ts:1859–1876`. The CLI teardown maps `InvalidInput → 2` and `Unavailable → 3`. **Every other `OperationError` code maps to 5**, `RpcClientError` maps to 3, and a non-`OperationError` failure maps to 2. So `Conflict`, `RevisionUnavailable`, `NotFound`, `CursorExpired` and `LimitExceeded` all exit **5** today.

Counterexample: a script written to the draft treats exit 2 as "stale, reassess". It never sees 2 for a stale token, because `Conflict` exits 5, which the same script reads as "limit".

Smallest fix: replace the sentence with: "Errors reuse the existing CLI mapping: InvalidInput 2; Unavailable and transport failure 3; every other OperationError code (Conflict, RevisionUnavailable, NotFound, CursorExpired, LimitExceeded) 5. Scripts distinguish refusals by re-running the assessment and reading `state`, never by exit code or message." Changing the mapping instead would be a new public decision and would contradict "existing codes". Do not do that.

### 3.2 Map refusal states to codes

The draft says "Other refusals use Conflict, RevisionUnavailable or LimitExceeded as appropriate." For a consumer contract, that sentence needs to be a table, because the codes are the only typed signal `RunRecover` returns.

| Assessment `state` when `RunRecover` arrives | Code |
| --- | --- |
| Token's set or generation changed (new hold, already authorized, resolved) | Conflict; the message names the change and the accepted `authorizationId` when there is one |
| NotHeld, Pending, Stopping, FinalizationStalled, Terminal, ExecutionActive, DeadlineElapsed | Conflict |
| RevisionUnavailable | RevisionUnavailable |
| AuthorizationLimit (per attempt) or the 64-generation limit | LimitExceeded |
| Malformed token/flags, missing acknowledgment, paging flags combined with mutation | InvalidInput |
| Another principal's run | NotFound |

The table must also say that a refused request reserves nothing: its request key is not stored, so the same key with a new token is a new request. This mirrors cancellation ([Source] `host-store.ts:651–720`, where a receipt is written only on success).

### 3.3 Define the status projection at acceptance

The draft says status "can become Running" after authorization, and that `Settle` is withheld while the status is `NeedsAttention` ([Source] `host-store.ts:1292`). It does not say _when_ the status moves.

Counterexample: acceptance commits but leaves the status at `NeedsAttention` until the continuation finishes. A gate-suspended sibling's approval is settled meanwhile, and its `Settle` intent stays withheld. Meanwhile, `RunGet` shows `NeedsAttention` immediately after an `Accepted` receipt, which tells the operator the authorization did nothing. `RunGet` has no pending field, by decision.

Smallest fix, one sentence in "Admission and status invariants": "_Unresolved_ means recorded uncertainty with no accepted authorization. The acceptance transaction re-projects status: Running if no unresolved uncertainty or stall remains, otherwise NeedsAttention." This is the reading the rest of the draft already assumes.

### 3.4 Disclose that one exhausted entry blocks the whole run

With all-current-holds, `AuthorizationLimit` for one entry (16 prior authorizations) refuses the token for every entry in the set. Add to "Events, limits": "If any current entry has reached its limit, no entry in the run can be authorized; cancel is the remaining disposition." This is a consequence of the decided scope, not a new decision. The operator should see it before presentation.

### 3.5 Assessment completeness after restart

[Source/evidence] [uncertainty evidence](manual-recovery-uncertainty-evidence.md): the native engine re-enters unfinished leaves on startup, so holds are discovered asynchronously. An assessment taken soon after a restart may list only X while Y has not been re-entered yet. The token correctly goes stale if Y is recorded before acceptance. If Y is recorded after acceptance, it needs a later generation.

Smallest fix, human output plus one sentence of guidance: "This assessment lists uncertainty recorded so far. Leaves still being restarted may add entries later; they are never covered by an earlier token. Reassess after the run returns to NeedsAttention." Keep the existing all-pages warning verbatim.

### 3.6 Pin the event field meanings under the fresh window

[Source] `interpreter.ts:231–243` derives the in-handler timeout from `attemptStartedAt` (the first start), and `AttemptStarted` publishes `startedAt` and `deadline` ([Source] `host-store.ts:840–850`). Under the decided fresh window, an existing consumer that computes `startedAt + attemptTimeout` gets a deadline that is earlier than the real one.

Smallest fix: "In `AttemptStarted`, `startedAt` keeps its meaning (first start of the declared attempt). `deadline` is this entry's effective deadline: `min(entryStart + attemptTimeout, absoluteDeadline)`. The new `entry` field says which entry." The human assessment should print that effective-deadline formula alongside `absoluteDeadline` so the operator can see when little time remains.

### 3.7 Retry command and reason normalization

- "Normalized reason" is undefined. Use cancellation's rule exactly: absent is the same as `null`, and the reason is otherwise compared byte for byte, with no trimming. Drop the word "normalized", or define it that way.
- `acknowledgeReexecution` is the literal `true`, so it cannot differ between requests. Remove it from the conflict list, or keep it and say it is listed for completeness.
- Printing "the exact retry command" with an arbitrary `--reason` is a shell-quoting hazard. Follow the existing cancel pattern ([Source] `main.ts:604–610`): print `--authorize <token> --request-key <key>` and say "repeat the same --reason". Print it only on non-`OperationError` failures, as cancel does.

### 3.8 Watching after acceptance (no `--watch`)

[Source] `run watch` without foreground mode stops only at a terminal status (`main.ts:212–241`, `observe(..., false)`). So a re-held run keeps `run watch` open with no exit. That is acceptable and consistent with dropping `--watch`, but the text must say so. The `NeedsAttention` progress line currently prints only the node ([Source] `progress-format.ts:145`). Smallest fix: "`run watch` continues through a re-hold. Its NeedsAttention line shows node, attempt and entry, followed by `run recover <id>`." Also, the existing foreground exit-4 hint ("Inspect run waits … and run get …", `main.ts:244–247`) should name `run recover <id>` when `run.recovery.v1` is advertised.

## 4. Optional additive field (non-blocking)

The lost-reply case where the operator also lost the printed key (for example, the terminal closed) has no way to match `latestAuthorization` to their request. Every operator on the run shares one principal, so `actor` does not disambiguate. Adding `requestKey: string` to `latestAuthorization` closes the gap at a cost of ≤200 bytes. It does not change the receipt-replay rule. The parent may add it or leave it out without another review round. If it is left out, add the guidance "If both the reply and the key are lost, reassess; a `latestAuthorization` whose `acceptedAt` follows your attempt may be yours."

## 5. Test completeness

The listed gates cover the crash table, holds with siblings, the fresh window, reports and pinned revisions. Add these concrete cases. Each is a sentence added to an existing gate:

1. **All-pages acknowledgment (gate 9).** Set `total = limit + 1`. Page 1 and page 2 return the same token. Authorizing with page 1's token gives `receipt.authorized == total`, and both entries consume. The human output shows "k of total", the incomplete-page marker and the all-pages sentence verbatim. Paging flags together with `--authorize` → InvalidInput, exit 2.
2. **Delayed discovery after acceptance (gate 2).** X is authorized; Y is recorded before delivery completes. Y gets no permission. The state is Pending until delivery finishes, then Recoverable with a new token. The old token → Conflict, and the old key with a new token → Conflict.
3. **Lost replies (gate 4/9).** Drop the transport reply: the CLI prints the token and key and exits 3. A retry after the run advanced generation, or became terminal, returns the byte-identical receipt. The same key after a _refused_ request succeeds with a fresh token (§3.2).
4. **Exit codes (gate 9).** Golden tests for each code in §3.1/§3.2, including CursorExpired → 5 and a refused `run.recovery.v1` capability → 3.
5. **Status at acceptance (gate 6).** Immediately after `Accepted` with no other hold, `RunGet` is not NeedsAttention, and a pending `Settle` is delivered (§3.3).
6. **Limit blocks all (gate 4).** One entry at 16 plus one fresh entry → AuthorizationLimit, no token, and cancel still reaches Cancelled.
7. **Source-pinned ABI limitation (gate 8).** A held run retained by an older host ABI, opened by a newer host: the assessment state is RevisionUnavailable with no token, and the message points to the compatible build. `RunRecover` → RevisionUnavailable, and no authorization row is written. **`run cancel` on that run still reaches a terminal status on the newer host.** The Cancel path calls `stopInvocations` and `execution.interrupt` ([Source] `runner.ts:36–40`), but whether interrupting a held leaf there needs the unloadable revision has not been proven. If it does, a held scheduled run blocks its schedule indefinitely ([Source] `schedule-store.ts:153–161`). If this gate fails, the disclosure must say that cancel also requires the compatible host. That would be a text change, not a new recovery feature.
8. **Report capacity (gate 7).** Assert that the fifth active report record exists while at most four reporters execute concurrently.

## 6. Out of scope here, deliberately not raised

Selection, an `Abandoned` disposition, result injection, `ctx.entry` and author hooks are excluded by decision. The intent-table and cursor mechanics are private and covered by the liveness gates. The cross-ABI migration is disclosed as unsupported. None of these needs reopening for presentation.

## 7. Summary for the parent

- **Verdict:** conditional ready-for-presentation. Apply §3.1–§3.8 (text and mechanical clarifications) and fold §5 into the existing gates. No round 3 is needed if these are applied as written.
- **Factual fix:** §3.1. Conflict, RevisionUnavailable, NotFound, CursorExpired and LimitExceeded all exit 5 today, not 2.
- **Contract holes closed by text:** the refusal→code table and unreserved refused keys (§3.2), status at acceptance (§3.3), one exhausted entry blocking all (§3.4), assessment completeness (§3.5), event fields under the fresh window (§3.6), retry and reason rules (§3.7), and watch behavior (§3.8).
- **Optional:** `latestAuthorization.requestKey` (§4).
- **Unproven, needs a gate:** cancelling an ABI-incompatible held run on the newer host (§5.7).
