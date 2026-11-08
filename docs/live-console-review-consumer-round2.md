# Live console proposal — consumer review, round 2

Reviewed: `docs/live-console-api-draft.md` revision 2 (untracked, current checkout). Reviewer: Claude (consumer + Effect lens). The scope is narrow: the fixed stop barrier, full replay of an initially terminal run, the plain-watch `--after-sequence` cursor, and sink degradation. I also checked that the round-1 text corrections were merged. This review edits no draft, production code or tests, and authorizes nothing. User approval is still required.

Evidence labels: **[source]** read in this checkout, **[probe]** scratch run outside the checkout (Bun 1.4.3, `effect@4.0.5` from the checkout), **[inference]** reasoning only, not executed. Probes are not implementation tests.

## Verdict

**Ready to present to the user once three small text corrections are applied (R1–R3). No further review round is needed.** The fixed barrier is the right choice. It always terminates, it stops at a predictable point, and it removes the moving-threshold failure. Degrading on a broken sink combines safely with the barrier. The round-1 items are merged correctly: per-field decoding, the five lifecycle tags, escaping after JSON formatting with atomic tokens, the Swamp comparison, the snapshot cadence, the example tail, and the removed test count. None of the corrections below changes the design.

## Barrier: completeness and termination

**[source]** Every appended event takes `lastSequence + 1` and updates `host_runs.lastSequence` in the same write. This holds for lifecycle events (`host-store.ts:318-331`), telemetry, which goes through the same `event()` (`:399`), and artifact publication (`lake.ts:363-377`). The watcher reads the run row and the next ≤16 events `sequence > after AND sequence <= run.lastSequence` in **one transaction** (`host-store.ts:1077-1124`). So sequences are dense, and a snapshot's `lastSequence` is always the sequence of a stored event that the stream will deliver. A barrier captured from a snapshot is therefore reachable. There is no gap that could leave `displayedThrough` below it forever, except the oversized-event failure (R1). Every snapshot's `lastSequence` is at least the cursor (range check `:1110-1118`), so the barrier is never below the initial `displayedThrough`.

**[probe]** `r2/barrier-probe.ts` ran the real `createRunWatcher` and the real `stopForeground` against a fake store. The run is `Waiting` with an open wait, and a sibling appends N events between polls.

```text
moving threshold, sibling +20/poll : hit the 2000-frame cap, never stopped
fixed barrier,    sibling +20/poll : barrier 60, stopped on E60 after 64 frames
moving threshold, sibling  +3/poll : stopped on S@52
fixed barrier,    sibling  +3/poll : barrier 43, stopped on E43
fixed barrier, write fails at E25  : display off, stopped on that page's trailing S@80
```

This confirms the change:

- A moving threshold never stops only when siblings append at least 16 events per poll. The `run-watch.ts` page cap is 16, and a page that drains the backlog emits a snapshot equal to its last event. That rate is uncommon, but it is reachable for a fast sibling (Log/Progress up to the 1000-entry budget, or unbudgeted lifecycle/artifact events).
- The fixed barrier stops on exactly the barrier Event. Because sequences are dense, "Events after that barrier need not be displayed" can be stated as **are not displayed**. That makes the stop point deterministic and gives tests something exact to assert (R3).

**Initially terminal run [source].** The barrier is the initial snapshot's `lastSequence`. For a terminal run this equals the final sequence: telemetry refuses terminal runs (`host-store.ts:343`), and the server ends the stream at `terminal && after >= lastSequence` (`run-watch.ts:52`). Full replay therefore ends at the barrier Event, at the same point where the server stops anyway. With `--after-sequence N`, `displayedThrough = N` and the replay is just the tail. Agree.

**Race caveat.** The draft names it correctly. The window is longer than it used to be, though. Before this change it was only the gap between `WaitList` and `RunGet`. Now it also includes the drain, and the drain is bounded by backlog **and stderr backpressure**. A paused `| less` can stretch it without limit. If the wait settles during that time, the final `RunGet` can be `Running`. `observe` maps any non-terminal status to exit 4 and prints "Outside action is available…" (`main.ts:214-224`). That is existing behavior, and fixing it would be a redesign. The approval text should still say plainly that the window grows with the backlog and with a slow reader (R2).

## Cursor effects (`--after-sequence` on plain watch)

**[source]** Plain watch parses `Flag.Int("after-sequence")` with default 0 and currently drops it (`main.ts:554-564`). The change is sound, but the user should approve two visible effects:

1. **Validation now applies.** An out-of-range cursor, such as `run watch X --after-sequence 999` on a 40-event run, used to succeed silently. It now fails with `InvalidInput` and exits 2 (`host-store.ts:1110-1118`, teardown `main.ts:1410-1414`). This also happens with `--json`. It is a correct fix, but it is a compatibility change, so list it next to D1.
2. **With `--json` the cursor matters only for validation and for which events the stream pulls before the immediate stop.** It never changes stdout. This is harmless, and it gives plain watch a way to step past an oversized event (R1).

The existing failure hint `observationHint(runId, false)` still says `--after-sequence 0` (`main.ts:162`), even when the user started the watch at N or had displayed events through M. Recommendation (part of R3): pass `displayedThrough` as `after` when display is on, and the requested cursor otherwise. This matches what JSONL does with `after`. It is a private change and adds no flag.

## Sink degradation

The recommendation is correct, and it does not interact badly with the barrier.

- **[source]** Every non-empty page is followed by a Snapshot (`run-watch.ts:48-50`). Suppose a write fails mid-drain and the CLI falls back to the immediate rule, which only stops on a Snapshot. The trailing snapshot of the page the stream is already reading then re-evaluates eligibility. The run cannot hang on an idle Waiting run. **[probe]** case 5 stopped on S@80.
- If the wait settled in the meantime, the immediate rule keeps observing until the next eligible snapshot. That is the existing semantics and is correct.
- If the failing write is the triggering Snapshot line itself, the predicate runs after the tap, sees display disabled and stops on that same snapshot. That is also correct, as long as the flag is set before `takeUntilEffect` evaluates the same frame. Sequential `tap` → `takeUntilEffect` guarantees this (round-1 probes).
- **Effect detail (text, R3):** catch only the write's typed failure, the mapped `UnknownError`/EPIPE, to flip the flag. Use a typed catch and not `catchCause`, so a Ctrl-C that interrupts a pending write still exits 130 and a formatter defect still surfaces. The draft says the intent ("do not swallow … parent interruption"). Naming the operator class prevents a `catchCause` shortcut.

## Corrections (text only; apply before presenting)

- **R1. Oversized events become reachable in human mode.** **[source]** `guardWatchFrame` fails the stream with `LimitExceeded` for any frame over 2 MiB (`watch-plane.ts:84-103`). That exits 5, with no stdout. Today plain and foreground watch "may stop sooner if a terminal snapshot arrives first" (`docs/live-run-observation.md:36`). With the drain they now reliably reach an oversized event at or below the barrier. A foreground run that ends exit 0 today could end exit 5 in human mode, while `--json` still returns. Such events are rare: telemetry is ≤8 KiB, so the risk is mainly very large lifecycle or artifact metadata. Smallest fix: accept the behavior and state it. Replace "No changes to the oversized-event typed error/skip behavior" with: "Human-mode draining can reach an oversized event that the immediate rule might have skipped past. The existing typed `LimitExceeded` failure and accepted-run hint apply. Recovery is `--json`, or plain/JSONL `--after-sequence <seq>`." Update `live-run-observation.md:36` during implementation. Add a real-CLI or fixture proof.
- **R2. Race wording.** In the barrier paragraph, after "as in the existing observation race", add: "The drain lengthens this window by the remaining backlog and any stderr backpressure. The final status can then be non-Waiting with exit 4, as the existing mapping does."
- **R3. Determinism and small mechanics.**
  - Say "Events after that barrier **are not** displayed".
  - Say "after capture, eligibility and `WaitList` are not re-evaluated until degradation". This also avoids extra `WaitList` RPCs during the drain.
  - The hint passes `displayedThrough` (display on) or the requested cursor (display off) as the resume cursor.
  - The degradation catch is typed, not `catchCause`.

## Public decisions for the user (unchanged set, plus one)

- D1 Default-on stderr progress, including redirected stderr, with the `2>&1` cost. Recommend yes.
- D2 Drain to a fixed barrier, including full replay of an already-terminal run. Recommend yes, with R1 stated.
- D3 `--json` = machine mode: compacts stdout and turns off progress. Recommend accepting it.
- D4 A broken progress sink disables only the display. Recommend yes. This overrides the round-1 Effect review's exit-3 preference, and the draft presents it that way.
- **D5 Honour plain `--after-sequence`, including the new `InvalidInput` exit 2 for out-of-range cursors that are ignored today.** Recommend yes.

## Proofs: additions only

- Reducer unit test with synthesized frames: a barrier captured at the first eligible snapshot. A sibling burst of ≥16 events per page does not move it, and the stop happens on exactly the barrier Event. This is deterministic, unlike the real-CLI "continuously publishing sibling" test, which should stay as a smoke test.
- Degradation mid-drain stops on that page's trailing Snapshot. Degradation on the triggering Snapshot stops on that same frame.
- Plain watch with an out-of-range `--after-sequence` exits 2, with and without `--json`.
- Oversized event within the barrier, per R1.

## Scratch probe

`/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/62db9b12-4623-4666-9f23-993a3fb413ce/scratchpad/r2/barrier-probe.ts` uses the real `createRunWatcher` and `stopForeground` with a fake store. It compares the moving threshold with the fixed barrier and covers mid-drain degradation. Note: the fake store advances on the watcher's admission query too, which is why the captured barrier is 60/43 rather than 40. That doesn't affect the comparison.
