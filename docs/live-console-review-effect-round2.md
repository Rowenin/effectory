# Live console proposal — Claude Effect review, round 2

Reviewed: `docs/live-console-api-draft.md` revision 2 (untracked, current checkout). Scope is narrow: the new decisions only. These are the fixed stop barrier, plain-watch cursor use and progress-sink degradation, plus the round-1 corrections that were merged. Feature status: **not approved**. This review authorizes nothing. No draft, production or test edits.

Evidence labels: **[source]** means read in this checkout. **[probe]** means a scratch script outside the checkout, run against the pinned `effect@4.0.5` and Bun 1.4.3, in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/de4b9733-638d-4b9f-92dc-1d306126877f/scratchpad/r2/b1.ts`. **[inference]** means reasoning only. Probes are not implementation tests.

## Verdict

**Conditionally approved on the Effect side, with no further full round.** The fixed barrier is the right shape. Reducer state stays bounded, ordering and backpressure stay owned by the existing scoped stream, and degradation is confined to the human display. I accept the switch from my round-1 preference (typed exit 3) to the consumer recommendation (degrade the display). It is the better consumer contract, and it removes the exit-3 versus JSONL-exit-2 asymmetry I flagged as D3.

R1–R4 below are small text corrections. R1 is the only one that changes behavior. Each can be checked against this review without another round. The user still has to approve the public decisions the draft already lists: default-on stderr, `--json` silencing progress, sink degradation and honoring the plain cursor.

## Round-1 corrections merged

| Round 1 | Revision 2 |
| --- | --- |
| C1 display before the predicate | ✓ "before the eligibility/barrier check"; "Display a triggering snapshot before evaluating". The `Stream.tap` → `Stream.takeUntilEffect` order is implied but not named; naming it is optional. |
| C2 private text writer | ✓ "private text writer underpinning writeJsonLine, preserving JSONL bytes". See R3 for where formatting must happen. |
| C3 typed mapping | Superseded by degradation. No exit mapping is needed for progress anymore. |
| C4 hints use `catchCause`, not `ignore` | ✓ |
| C5 unmapped tags | ✓ all five are mapped |
| C6 per-field decode | ✓ `decodeUnknownOption`, `Schema.Finite` |
| C7 escape set, atomic tokens, code-point cap | ✓ |

## Fixed barrier: ordering, state and starvation

**[source]** The server reads events with `sequence > after AND sequence <= run.lastSequence` in the same transaction as the snapshot (`host-store.ts` `observation`). It sends them in sequence order, at most 16 per page, and follows each nonempty page with a Snapshot (`run-watch.ts:41-50`). It does not sleep while events remain. So every event up to a captured `lastSequence` B is delivered before any later event. Draining to B needs at most ⌈(B − displayedThrough)/16⌉ immediate pages, however fast siblings append. The barrier cannot starve.

**[inference]** A barrier that moves to each later snapshot's `lastSequence` would chase a sibling that appends at least 16 events per page, and could keep it from ever stopping while an outside action is open. Fixing B at the first eligible snapshot is what makes the drain finite. Agree.

**[probe]** `b1.ts` uses chunked frames (`rechunk(8)`), with `Stream.tap(update)` before `Stream.takeUntilEffect(barrier check)`. The first eligible snapshot has `lastSequence` 20 while a sibling keeps appending to 60. The stream stopped with `through = 20` after pulling 22 of 52 frames. Nothing past the barrier was consumed, and the stop landed on an Event frame, as the draft says.

**Bounded state.** ✓ The reducer is the last printed status, `displayedThrough`, `Option<B>` and `enabled`: a constant number of scalars per observation, held in a local inside `Effect.suspend` like `observeJsonLines`. It needs no `Ref`, history or per-node map.

**Small text points:**

- After B is captured, the predicate is only `displayedThrough >= B`. Later `Waiting` snapshots must **not** call `WaitList` again. The existing `stopForeground` is evaluated only until a barrier exists. The draft implies this ("capture once") but should say it, because otherwise each 16-event page during the drain adds an RPC.
- With a cursor N ≥ B (for example, plain watch `--after-sequence` equal to the terminal `lastSequence`), the first snapshot stops at once. This is correct and needs no special case.
- Plain watch of a terminal run: the server also ends its stream naturally once `after >= lastSequence` (`run-watch.ts:52`). The barrier and natural end agree, so `runDrain` completing without reaching B is also a normal stop.

### R1 (behavior): the drain newly exposes the oversized-event failure

**[source]** `guardWatchFrame` (`watch-plane.ts:86-103`) fails the whole stream with `OperationError{LimitExceeded}` for an event frame over 2 MiB. The CLI teardown maps `LimitExceeded` to exit **5** (`main.ts` teardown: codes other than InvalidInput and Unavailable map to 5). Today the foreground rule and the plain-watch rule stop at the first eligible snapshot and never pull events after it. The barrier now pulls events between that snapshot and B. **[inference]** So an oversized event in that tail turns a run that succeeded (or an exit-4 wait) into exit 5 with no stdout, only when progress is on. `--json` would still exit 0. The draft's "No changes to the oversized-event typed error/skip behavior" holds for the transport but not for this outcome. That conflicts with the draft's own principle that stderr is decoration.

**Smallest fix:** once a barrier exists, a stream failure that is an `OperationError` with code `LimitExceeded` from an Event frame ends the drain like reaching B. Write one best-effort escaped line on the display path, such as "event N exceeds the live display limit; see run get". Then do the normal final RunGet and exit mapping. Catch only that typed failure, and only while draining. Before the barrier, the existing failure, hint and exit behavior stays unchanged. Interruption and other errors still propagate. Add a test: an oversized event between the first eligible snapshot and B gives the same stdout and exit as `--json`.

Alternative, if the user prefers: keep exit 5 and document that progress mode can surface an oversized tail event that `--json` skips. I recommend the fix. It is local to the CLI and fits the rest of the design.

## Sink degradation: interruption and defects

**[probe]** `b1.ts`: a hanging `tryPromise` write wrapped in `Effect.catch(...)` and one wrapped in `Effect.catchCause(...)` were each forked and then interrupted externally. Both exits were interrupt-only, neither handler ran, and the code after them did not continue. External interruption is therefore not swallowed by either combinator in 4.0.5. That resolves the main risk for Ctrl-C (exit 130) and remote scope release.

### R2: degradation must catch only the sink's typed error

**[source]** `writeJsonLine` runs `JSON.stringify` **inside** the `tryPromise` body, and `tryPromise` without `catch` turns any throw into a typed `UnknownError`. **[probe]** `b1.ts`: a `BigInt` stringify inside `tryPromise` gave a **typed failure**. The same throw in `Effect.suspend` before `tryPromise` gave a **defect**.

If the private text writer keeps that shape, or if the formatter runs inside it, a formatter bug looks like a write error. The degradation catch would then turn the bug into a silently disabled display. That contradicts "do not swallow formatter defects".

**Fix (text):**

- The formatter runs in pure code before the write.
- The text writer's `tryPromise` contains only `output.write` and its callback, and maps the rejection to one private tagged error (for example `ProgressSinkError`).
- Degradation uses `Effect.catchTag`/`Effect.catch` on that tag only. It never uses `catchCause`, `ignore` or `exit` around the display step.

`writeJsonLine` can keep its current bytes by encoding first and calling the text writer. JSONL's exit 2 on a broken stdout is unchanged.

### R3: what degrading during the drain does

The draft says "Drop the display barrier and use the existing immediate stop rule after degradation." **[inference]** If degradation happens after B was captured, the snapshot that was eligible has already gone. The immediate rule then waits for the next snapshot. One always arrives, because the page holding B is followed by a Snapshot, so this cannot hang. That snapshot may show a newer state, though, such as a settled wait. In that case observation keeps going past the point where `--json` would have stopped, and it calls `WaitList` again.

**Smaller rule:** if a barrier exists when display is disabled, stop on that same element. Eligibility was already established, and the final RunGet covers any race exactly as the draft describes. If no barrier exists yet, use the existing immediate rule. In code this is `!enabled && Option.isSome(barrier)` in the predicate. Because the predicate follows `tap` on the same element, the stop is immediate.

### R4: confine hints and keep the listener note

- **[source]** The exit-4 guidance `Console.error` in `observe` runs after stdout and outside `tapError`. If stderr is broken, it goes to the same sink. On Bun 1.4.3, `Console.error` to a broken pipe succeeds silently (round-1 probes), so no change is needed today. The draft's rule should still be "do not print **progress** or hints through the callback writer after degradation". Existing `Console.error` diagnostics stay as they are.
- **[source]** A failed callback write intentionally leaves one `once("error")` listener attached (`json-lines.ts:20`). After degradation no further callback writes occur, so the listener count stays at one per observation and remains bounded. Pin this in the broken-stderr test by asserting that the process keeps observing and exits with the run-derived code.
- **[inference]** Best-effort `observationHint` wrapped in `catchCause(() => Effect.void)` is safe with respect to interruption. `tapError` does not run on interrupt-only causes, and the probe shows `catchCause` does not intercept an external interrupt. ✓

## Plain-watch cursor

**[source]** `observation()` rejects `after > run.lastSequence` with `InvalidInput` (`host-store.ts`, "Watch sequence must be within the recorded event range"). This maps to exit 2. Today plain `run watch --after-sequence 999` ignores the flag and succeeds. After this change it fails with exit 2, in both progress and `--json` modes. That is correct and consistent with JSONL. It belongs inside the "requires user approval" note for honoring the flag, which should mention the out-of-range case explicitly.

## Tests to add (beyond the draft's list)

- A tail oversized event during the drain gives the same stdout and exit as `--json` (R1, or the documented exit 5 if the alternative is chosen).
- A formatter defect is a defect (exit 2, "Command failed"), not a silently disabled display (R2).
- A sink failure after the barrier is captured stops without another `WaitList` call (R3).
- No `WaitList` calls happen after the barrier is captured. Use a sibling that appends more than 16 events per page while the wait is open.
- Plain watch with an out-of-range `--after-sequence` exits 2 with the server message.

## Decisions for the user

These are unchanged from the draft's list. R1 adds one choice: an oversized tail event during the drain either ends the drain quietly (recommended) or surfaces as exit 5 only in progress mode.
