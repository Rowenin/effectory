# Live run observation — consumer resolution for narrow review

Status: **historical resolution input; not user-approved**. The merged revision-2 proposal is in [the main draft](live-run-watch-api-draft.md); its line units and recovery behavior supersede earlier alternatives here. The main revision-1 draft remains frozen while its original Effect review completes. This delta records the recommended consumer behavior and round-1 text corrections for a narrow consumer re-check. Merge it with the Effect findings before presenting a concrete proposal to the user. No watch implementation changes are authorized.

## B1: foreground return policy

Recommend keeping foreground observation attached through timer/retry-only suspension. Return a final Run normally at terminal status; return exit 4 for NeedsAttention, or for Waiting when at least one open approval, input or signal wait exists. Use the existing WaitList RPC filtered to this run and Open status, querying after a Waiting Snapshot. Do not reconstruct open waits solely from replayed events, which can omit earlier registrations when observing from a sequence. This adds no frame, status or flag. Print an exit-4 stderr hint naming `run waits <run-id>` and `run get <run-id>`.

This is a proposed public choice, not an inference of user approval. Compared with today's buffered behavior, foreground calls can return before terminal completion for these actionable states. The alternate choice (return at every Waiting, including timers/backoff) remains available for the user, but is not recommended. `run watch --jsonl` stays attached across waits and emits live frames; non-JSONL watch prints only the final run.

### Signal registration caveat for the reviewer

Source inspection found that SignalRegistration calls registerWait/openWait before AwaitSignal calls awaitWait (`interpreter.ts:933–962`). Therefore, an Open signal wait does not prove that the interpreter has reached its corresponding await. Waiting from an unrelated timer can coexist with a pre-registered signal endpoint. The simple policy above would return exit 4 in that case, even though a timer is also pending. It means **Waiting plus an open external interaction**, not a claim that all runnable work is blocked solely on that interaction.

Decide in the narrow review whether this explicit policy is sufficiently clear to present, or whether consumers need a stronger "actually awaiting external input" guarantee. Do not silently add public fields or change engine statuses to manufacture that distinction. If stronger semantics need new durable blocking metadata, identify the smallest follow-up design rather than treating WaitList as evidence it does not contain. Add a foreground test for pre-registration plus a timer either way. Timer/retry-only tests must stay attached and finish successfully.

## R1: accepted runs and interruptions

After successful TaskRun/WorkflowRun admission, any observation failure prints to stderr: `Run <run-id> was accepted; observation ended (<reason>). Inspect with run get <run-id> or reattach with run watch <run-id>.` This includes typed LimitExceeded and Unavailable, transport loss, daemon stop/restart, and final RunGet failure. Never suggest repeating submission after a known successful admission. Uncertain admission retains its existing request-key retry guidance.

Remote transport interruption maps to Unavailable/exit 3. Typed server refusals retain their existing code/exit mapping (LimitExceeded exits 5). Local Ctrl-C/SIGINT remains exit 130 and does not print a remote-disconnection hint. JSONL remote-ended cases print `run watch <run-id> --jsonl --after-sequence <last-written-event>`; do not derive the cursor from Snapshot.lastSequence.

Implementation feasibility suggestion for the Effect reviewer, not a new API: run stream consumption in a scoped child fiber and inspect its Exit with Fiber.await. A remote interrupt of the consumer fiber can then be classified as observation failure; interruption of the parent by local SIGINT still interrupts the whole observation Scope. Do not use Fiber.join if it erases that distinction. Prove real daemon stop and local Ctrl-C behavior; do not assume any interrupt-only Cause is local user intent.

## R2: old daemon

Unavailable exits 3 with: `The running daemon does not support run.watch.stream.v1. Restart it with this binary (effectory daemon stop, then effectory daemon start). To submit without observing, use --background.`

Parse input, then perform one SystemStatus preflight shared with tag capability checks when applicable, before sending TaskRun/WorkflowRun. Background submissions and unrelated commands keep existing compatibility. This does not reserve an observer slot; a capacity failure after admission uses the R1 accepted-run guidance.

## R3: exact parity claim

Swamp renders execution events live during foreground in-process workflow runs (`workflow_run.ts:736,776`). Its history-log stream reads recorded history and is not evidence of a live follow mode. This slice makes Effectory `run watch --jsonl` live and changes foreground return behavior as described above. A live human-readable foreground/watch renderer remains out of scope and needs its own user discussion.

## R4: idle and line behavior

Disable Bun's idle timeout for the watch route using the original request, as the bytes route does. A paused reader may keep its producer/observer resources until disconnect or daemon shutdown. Heartbeats remain five-second idle frames; no new idle-timeout setting is added.

Each stdout JSONL line is exactly one logical frame. Proposed maximum is 2,097,152 UTF-8 bytes including its newline, subject to the original Effect review's bound proof before presentation. The RPC NDJSON envelope also has a 2 MiB parser bound; establish that every valid frame plus envelope fits, and check the actual stdout serialization. Do not label the bound proven or implemented until that evidence exists.

## Added acceptance checks

- Approval/input/signal waiting and NeedsAttention foreground return with exit 4 and actionable hints; timer and retry-only foreground runs remain attached and reach their final result.
- Pre-registered signal plus timer has a deliberately documented result, distinguished from actual AwaitSignal suspension.
- Remote daemon stop during foreground observation and JSONL watch exits 3 with accepted-run/resume guidance; local SIGINT exits 130 without misleading remote-failure guidance.
- Observer capacity failure after successful admission preserves the run ID and does not suggest resubmission.
- Missing capability refuses foreground admission before mutation, reuses one status preflight with tags, and leaves background admission supported.
- Largest frame and RPC envelope fit the proven byte limits, including escaped cancellation reasons and artifact metadata.

Reviewer: review this delta plus the frozen main draft and your first consumer review. Recommend the smallest coherent presentation, especially the signal-registration caveat. Write `docs/live-run-watch-review-consumer-round2.md` only; no production/draft edits, commits or subagents. User approval is still required after both reviews are resolved.
