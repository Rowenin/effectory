# Manual recovery draft 2 — consumer resolution

Status: corrections merged into [the reviewed proposal](manual-recovery-api-draft.md) after the Effect re-review completed. Not user approval. No recovery production code changed. Based on [consumer round 2](manual-recovery-review-consumer-round2.md), with the source checks below. No further consumer round is needed for these corrections.

## Corrections accepted

1. **CLI codes:** InvalidInput exits 2; Unavailable and transport failure exit 3; all other OperationError codes, including Conflict, RevisionUnavailable, NotFound, CursorExpired and LimitExceeded, exit 5. This is the mapping at `packages/cli/src/main.ts:1859–1876`; do not change it. Scripts reassess and inspect `state` instead of interpreting exit 5 as a specific refusal.
2. **Refusal mapping:** use the table below. A refused request writes no receipt and reserves no request key. A later request can reuse that key with a new token; an already accepted key remains bound to its original payload.
3. **Acceptance projection:** unresolved uncertainty means a recorded hold with no accepted authorization. The transaction accepting all current holds also projects Running if no unresolved hold or finalization stall remains, otherwise NeedsAttention. No handler-start claim is implied. This lets ordinary pending wait-settlement delivery resume.
4. **Whole-set limit:** if any assessed entry has exhausted its 16-authorizations limit, the whole set is refused. The remaining disposition is cancellation, on a compatible host. A 64-generation limit also refuses all further recovery for that run. Failed requests consume neither quota.
5. **Late discovery:** human output says the assessment contains uncertainty recorded so far. Leaves still restarting can produce new holds, which are never authorized by an older token. Reassess if NeedsAttention returns. Retain the all-pages warning: acceptance covers every entry in the assessed set, not only the displayed page.
6. **Event timestamps:** AttemptStarted.startedAt remains the first start of the declared attempt; its deadline is the current entry's effective deadline, `min(entryStart + attemptTimeout, absoluteDeadline)`. The new entry field identifies re-entry. Show that rule in assessment guidance. The interpreter must use the current entry start for the actual timeout too; changing the event alone is insufficient.
7. **Receipt reasons:** absence is stored as null; otherwise compare strings byte for byte, without trimming. Acknowledgment is the literal true, so differing acknowledgment cannot reach fingerprint comparison. A different token or reason on an accepted key conflicts.
8. **Uncertain delivery:** print the generated key, token and acknowledgment in a shell-safe retry command, followed by guidance to repeat the same reason separately. Do not interpolate arbitrary reason text into a command. Like cancellation, distinguish a server OperationError from transport/other failures where acceptance is uncertain. A plain InvalidInput or Conflict is not uncertain delivery.
9. **Watch:** plain run watch stays attached through a re-hold. Its human NeedsAttention line shows invocation, attempt and entry plus a run recover hint; it does not imply an exit-4 at that point. Existing foreground commands still exit at NeedsAttention and add the recovery assessment hint when the daemon advertises run.recovery.v1. Do not imply ordinary approval waits are recoverable.
10. **Inspection field:** accept the optional recommendation to add requestKey to latestAuthorization. This is bounded to 200 characters and lets an operator identify a lost reply without relying on the shared owner actor. It changes no receipt semantics.

| Mutation condition | OperationError code |
| --- | --- |
| Changed set/generation, already authorized or resolved token | Conflict; name the change and accepted authorization when available |
| NotHeld, Pending, Stopping, FinalizationStalled, Terminal, ExecutionActive, DeadlineElapsed | Conflict |
| Unavailable pinned revision in a running host | RevisionUnavailable |
| Per-attempt or per-run authorization limit | LimitExceeded |
| Malformed input, missing acknowledgment, incompatible CLI flags | InvalidInput |
| Missing run or principal mismatch | NotFound |

Capability refusal remains Unavailable. Expired assessment cursors return CursorExpired from inspection. Receipt replay occurs after principal authorization but before current-state checks.

## ABI limitation — source correction to the requested proof

The review asks whether a newer host can cancel a held run whose revision it cannot load, and suggests testing an assessment with state RevisionUnavailable. The current production startup path prevents both RPC calls in this scenario:

- `packages/platform-bun/src/revisions.ts:178–190` checks every retained revision's host ABI and fails catalog construction on a mismatch.
- `packages/platform-bun/src/daemon.ts:128–156` includes that catalog in the runtime/services Layer build.
- Only after that build succeeds does it construct the RPC handler and call Bun.serve (`daemon.ts:160–174`).

This is a source trace, not a real two-binary execution proof. The draft must nevertheless not promise assessment or cancellation through a daemon that never starts. State clearly: **an incompatible host build may refuse startup, leaving both recovery and cancellation unavailable until the compatible host is restored. A held scheduled run continues to block its schedule.** An already running compatible host that cannot resolve a particular revision can return RevisionUnavailable through the assessment path; these are distinct failure modes.

Replace the proposed newer-host-cancel success gate with a real two-build test of startup refusal, no recovery delivery and intact pending state, followed by starting the compatible build and successfully cancelling or recovering. Cross-ABI administrative recovery is not added to this slice. Do not remove retained revisions or edit manifests to bypass the check.

## Proof additions

Fold these into the draft's existing gates:

- More entries than one assessment page: same token on every page; page-1 authorization covers the total; incomplete-page/all-pages warnings; paging flags with mutation fail InvalidInput.
- A hold discovered after acceptance receives no old permission; the prior generation completes delivery without clearing the new hold; reassessment then issues a new token.
- Lost transport reply followed by a terminal run still returns the identical receipt with the old key. A refused key can be reused; an accepted key with a new token conflicts.
- Golden output and exit codes for all rows in the table; reason text containing quotes, newlines and shell metacharacters never becomes executable retry-command content.
- Immediate post-acceptance status is re-projected; pending Settle delivery is no longer withheld solely by the old hold.
- One exhausted entry blocks all current holds; compatible-host cancellation still reaches terminal.
- Recovery can make a fifth active report record while actual report execution stays at four permits.
- Two-host-build compatibility test as specified above, not an impossible RPC expectation on a daemon that failed to start.

This document records the consumer-resolution pass; its corrections have now been merged with the Effect continuation fixes into the main proposal. Formatting was checked; no repository implementation suite is warranted for these documentation-only changes.
