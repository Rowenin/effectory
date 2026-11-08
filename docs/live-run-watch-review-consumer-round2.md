# Live run observation — consumer review, round 2 (narrow)

Reviewer: Claude consumer review. Scope: the proposed B1 recommendation and the R1–R4 corrections in `docs/live-run-watch-consumer-resolution.md`. I read them against the frozen `docs/live-run-watch-api-draft.md` and my round-1 review. I changed no production code and did not edit the draft or the resolution. The original Effect review still owns the maximum-frame proof and the interruption machinery (Fiber/Scope classification).

**This review only selects a recommendation to present. It is not user approval, and it authorizes no implementation.**

Evidence labels: **[code]** means read from source. **[probe]** means the round-1 scratch probes; I ran no new probes this round. **[inference]** means my reasoning, not checked by running anything.

## Verdict: approve for presentation after three small text changes (C1–C3)

- **B1.** The "Waiting plus an open external interaction → exit 4" policy is coherent to present. Its caveat is understated, though. Source shows that `Waiting` is **sticky** after a timer or retry backoff, so the caveat must cover a run that is actively executing, not only a run that also has a pending timer (C1). The CLI must also re-evaluate on every Waiting Snapshot, not only on the transition into Waiting (C2).
- **"Actually awaiting" semantics.** These cannot be derived from WaitList or from status. They would need new durable metadata plus a projection fix. Present that as a separately designed follow-up; do not add it to this slice.
- **R1–R4.** They are accepted, with one wording fix for R2 and one cursor clarification for R1 (C3).

If C1–C3 are applied as written, no further consumer round is needed.

## B1 — the signal-registration caveat

### What the source shows

- **[code] Pre-registration.** `interpreter.ts:932-936`: `SignalRegistration` calls `registerWait`, and that call commits `openWait` with a `WaitOpened` event in one store transaction (`host-store.ts:1146-1210`). `AwaitSignal` reaches `awaitWait` later, at `:938-963`, and arbitrary graph work can run in between. An Open signal wait therefore proves only that an endpoint was issued. It does not prove that the run is blocked on that endpoint. This confirms the resolution's finding.
- **[code] Approval, Input and Signal nodes are different.** They register and await back to back (`:965-970`). For these kinds, an Open wait means a branch is (or is about to be) awaiting it.
- **[code] New finding: Waiting is sticky after timer or retry suspension.**
  - `runner.ts:97-100` projects `Waiting` only from `Running`/`Queued` when the engine reports `Suspended`.
  - Only two paths project `Running` again:
    - `dispatch` while the run is still `Queued` (`runner.ts:28-31`);
    - `awaitWait` after a wait settles (`interpreter.ts:458-460`).
  - Nothing projects `Running` when a `DurableClock.sleep` (graph Sleep at `:926-931`, retry backoff at `:336`) wakes.
  - **[inference]** After the first timer, the run stays `Waiting` while it executes later tasks. It changes only when a wait settles or the run reaches a terminal state.
  - **[probe]** This is consistent with round 1's `sleep-probe.mts`, which reported `Waiting` continuously until `Succeeded`. That probe's post-sleep task was short, so it is consistent with this finding but does not prove it on its own.
- **[code] Status changes stream correctly.** `project` appends a `RunStatus` event in the same transaction (`host-store.ts:1222-1245`), and the watcher emits a Snapshot after every event batch (`run-watch.ts:45-47`). A Waiting Snapshot therefore always reaches the foreground observer. `WaitOpened` also produces a Snapshot, and that Snapshot is the stale `Waiting` one when the run is sticky.

### Consequence for the proposed policy

**[inference]** Combine sticky Waiting with pre-registration, for example `sleep → SignalRegistration → task(address) → AwaitSignal`. Foreground returns exit 4 at `WaitOpened`, while the run is still executing the task. That task might itself deliver the address to a service that calls back automatically. This case is broader than "coexists with an unrelated timer": the run may not be suspended at all.

The same sticky status affects `run get` and `run list` today. That behavior already exists and is outside this slice. Do not change engine or projection statuses here to hide it.

### Is the explicit policy coherent to present?

**Yes, provided it is described as an interaction-availability rule rather than a blocked-run rule.** The reasons:

- It is decidable from data that is already durable: run status, plus Open waits from WaitList. It adds no frame, status or flag.
- It is exactly right for approval and input, which are the main CI and human cases.
- For signals, an Open wait really is actionable: someone can send the signal. Returning early is surprising only for the pre-registration pattern, and that pattern is visible in the workflow's own definition.
- The alternative choice (return at every Waiting) is strictly worse for CI. With sticky Waiting, it would return at the first timer even when the run is executing.

### Do stronger "actually awaiting" semantics need durable metadata?

Yes. Neither WaitList (`WaitSummary` has no awaited/registered distinction, `history-protocol.ts:97-106`) nor status can provide them. The smallest follow-up design has two parts, and neither belongs in this slice:

1. A durable "awaited" marker, written idempotently by `awaitWait` before `DurableDeferred.await`: an `Activity` that sets a column on `host_waits` or appends a `WaitAwaited` event. WaitList (or an internal query) could then filter for awaited Open waits. This changes the public `WaitSummary` and the event vocabulary, so it needs user approval.
2. Re-projecting `Running` when a timer or backoff wakes, so that `Waiting` means suspended. Without part 2, part 1 still only proves that an await has started, not that the run is blocked overall.

If the user wants that guarantee, present it as "defer B1 signal handling to a follow-up", not as an option inside this slice.

## Required text changes

### C1. Restate the B1 caveat (replaces the resolution's caveat paragraph)

> Foreground exit 4 means: the run is NeedsAttention, or its status is Waiting and it has at least one Open approval, input or signal wait. It does not claim that all runnable work is blocked. Two current behaviors make the difference visible:
>
> - A signal endpoint opened by `SignalRegistration` counts as soon as it is registered, before `AwaitSignal`.
> - After a durable timer or retry backoff, the run's status remains `Waiting` while later work executes.
>
> As a result, a workflow that pre-registers a signal after any sleep or retry can return exit 4 while it is still running. Workflows that need foreground to stay attached should register and await the signal together (`signal`), or callers should use `--background` with `run watch`. Stronger "actually awaiting" semantics need new durable metadata and are a separate follow-up.

### C2. Specify the CLI decision rule precisely (B1)

- Evaluate the rule on **every** Snapshot whose status is `Waiting`, including the initial Snapshot. Sticky Waiting means a later approval arrives as another `Waiting` Snapshot, with no status transition. A transition-only check would hang through the sleep → task → approval case.
- `NeedsAttention` returns immediately, with no wait query.
- For Waiting, issue `WaitList({ runId, status: "Open", limit: 1 })`. All three `WaitKind` values (`protocol.ts:49`) qualify, so no kind filter is needed. One item is enough to decide. Snapshots arrive at most once per 16-event batch, so the query rate stays bounded.
- Compute the exit code from the final `RunGet`:
  - terminal → existing 0/1;
  - otherwise → 4.

  This settles the race in which the wait settles between the WaitList query and the `RunGet`.

- Print the stderr hint only for exit 4.

### C3. Wording fixes to R1/R2

- **R2.** The suggestion "To submit without observing, use --background" applies only to `task run` and `workflow run`. For `run watch`, end the message with: `Inspect without observing with run get <run-id>.`
- **R1.** The JSONL resume cursor is the last Event written to stdout, or the user's `--after-sequence` value (default 0) if no Event was written. This matches today's `main.ts:180-201`. It must never be `Snapshot.lastSequence`, as the resolution already says.

## R1–R4 otherwise accepted

- **R1.** The accepted-run message, the "never suggest resubmission" rule, exit 3 for remote ends, exit 5 retained for LimitExceeded, and exit 130 only for local SIGINT all read correctly to a consumer. Whether a remote interrupt can be told apart from a local one in Effect 4.0.5 is the Effect review's proof obligation. The acceptance item, which requires real `daemon stop` and real Ctrl-C, is the right gate.
- **R2.** One shared SystemStatus preflight before admission, with no reserved observer slot, is correct. The window between the preflight and admission is covered by R1.
- **R3.** Accepted as written. The draft's compatibility section must state plainly that foreground run now returns before the terminal state at actionable waits.
- **R4.** Accepted. Consumer-visible consequence: a paused reader, such as `| less`, holds one of the 16 shared observer slots until it disconnects. Say so in the docs. Do not publish the byte bound until the Effect review proves it.

## Acceptance coverage

The resolution's list is adequate, with these concrete cases replacing or adding to the B1 items:

1. **Timer only:** `sleep → task`. Foreground stays attached and exits 0.
2. **Retry backoff only:** a task fails once, then succeeds after a scheduled retry. Foreground stays attached and exits 0.
3. **Sticky Waiting then approval:** `sleep → task → approval`. Foreground stays attached through the sleep and the task, then returns exit 4 at the approval with the hint. This guards C2 against a hang.
4. **Pre-registration (documented result):** `sleep → SignalRegistration → task → AwaitSignal`, and separately `SignalRegistration → sleep → AwaitSignal`. Each asserts the C1 result: exit 4 once the signal is Open and status is Waiting. The tests document the result rather than assert "actually awaiting".
5. **Plain signal:** a `signal` node returns exit 4. Input returns exit 4. NeedsAttention returns exit 4.
6. **Race:** if a wait settles between the WaitList query and `RunGet`, the exit code follows the `RunGet` result (C2).

The interruption, old-daemon, capacity and frame-size items remain as listed. Their proofs belong to the Effect review.

## What the root should present

- **B1 (recommended):** "stay attached through timers and retries; exit 4 at NeedsAttention or at Waiting with any Open approval, input or signal wait". Present it with the C1 caveat.
- **Alternative:** return at every Waiting. Not recommended, and worse with sticky Waiting.
- **Optional follow-up for the user:** durable awaited-wait metadata plus `Running` re-projection after a timer wakes, for stronger semantics. This needs its own design and review.
- **Also for the user:** sticky Waiting is an existing status-projection behavior that is visible today in `run get` and `run list`, independent of this slice.
