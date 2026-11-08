# Live console proposal — consumer review, round 1

Reviewed: `docs/live-console-api-draft.md` (untracked, current checkout). Reviewer: Claude (consumer + Effect lens). No production, draft or test edits; scratch probes ran outside the checkout against the pinned Effect 4.0.5 / Bun 1.4.3.

Evidence labels: **[source]** read in the checkout, **[probe]** scratch run, **[inference]** reasoning, not executed. Probes are not implementation tests and do not count toward the proofs.

## Verdict

The direction is right and mostly elegant: stdout stays the machine contract, human progress is append-only stderr, `--json`/`--jsonl` stay quiet, there's no new surface, and display state is bounded. It's more pipe-friendly than Swamp. It is **not ready to present** as written, for one reason:

1. **Under the "unchanged stop rule", a fast run's progress silently loses its tail.** The last logs, the final `RunStatus`, and the `WaitOpened` before an exit-4 can all be dropped. See F1. That is the main thing a consumer looks for in progress output.

Before presenting, the user also needs to decide four smaller things: sink-failure behaviour (F2), what happens to tags the draft doesn't mention (F3), `--json` doing double duty (D3), and the `2>&1` compatibility note (D1). Everything else is small text corrections that can be approved on condition, without another round.

## Source claims checked

| Draft claim | Result |
| --- | --- |
| `print` writes JSON to stdout, indented unless `--json` | Confirmed: `packages/cli/src/main.ts:89-95` **[source]** |
| `observe` uses the streaming client and discards frames until the stop condition | Confirmed: `main.ts:193-227`, `Stream.takeUntilEffect` + `Stream.runDrain` **[source]** |
| `observation.ts` owns the foreground stop rule and interruption classification | Confirmed: `stopForeground`, `consumeObservation` **[source]** |
| Snapshot/Event/Heartbeat frames; Event payload is `Schema.Json` | Confirmed: `history-protocol.ts` `RunWatchFrame`; `protocol.ts:92-98` `Event{at,payload,runId,sequence,tag:String}` **[source]** |
| `WaitOpened` has `{nodeId, waitId}` but no kind or prompt | Confirmed: `host-store.ts:1204` **[source]** |
| `WaitSettled` has `{status, waitId}` and no nodeId | Confirmed: `host-store.ts:457` **[source]** |
| There's no general AttemptSucceeded event | Confirmed **[source]**, but see F3: other lifecycle tags exist that the draft never mentions |
| `AttemptStarted` has nodeId and attempt | Confirmed. Full payload is `{attempt, deadline: number\|null, nodeId, startedAt}` (`host-store.ts:715`) **[source]** |
| `Log` has level, nodeId and a JSON message | Confirmed. `LogPayload{attempt, error: Json\|null, level, message: Json, nodeId}`. `message` is already bounded to about 2 KiB with an omission placeholder (`task-logger.ts`) **[source]** |
| `Progress` comes from `Task.Progress` plus nodeId and attempt | Confirmed. `{attempt, nodeId, message: string, completed?: number, total?: number}` (`task.ts:39`, `interpreter.ts:97`). Counts are TypeScript `number`s, so they aren't guaranteed finite **[source]** |
| `ArtifactPublished` payload is publication metadata | Confirmed. It's the full `lake-protocol` `Record` (`lake.ts:366`). It has no `nodeId` (use `invocationPath`), and its own `sequence` field is the _lake_ sequence, not the event sequence **[source]** |
| `TelemetryTruncated` | `{code: "LimitExceeded", message}` (`host-store.ts:388`) **[source]** |
| `RunAccepted` | `{revision}` (`host-store.ts:596`) **[source]** |
| The first Snapshot arrives promptly | Confirmed: `run-watch.ts` pushes `Snapshot` on the `initial` page before any events **[source]** |
| Plain-watch `--after-sequence` is parsed but unused | Confirmed: `observe` never receives it (`main.ts:553-565`) **[source]** |
| Swamp `workflow_run.ts` ~736–776 feeds `consumeStream`; console renderer in `presentation/renderers/workflow_run.ts` | Confirmed (`consumeStream` at about line 771) **[source]**. The comparison is incomplete; see T1 |

## Findings

### F1 (blocking): the stop rule drops the tail of displayed events

**[source]** `run-watch.ts` reads at most **16 events per page** (`host-store.ts` `observation`, `LIMIT 16`). After every non-empty page it sends a `Snapshot` of the **current** run. That snapshot can already be terminal (or `Waiting`/`NeedsAttention`) while events up to `run.lastSequence` still haven't been sent. Both CLI predicates (`stopForeground`, and the plain-watch "terminal snapshot") stop on that snapshot.

**[probe]** `tail-probe.ts` used the real `createRunWatcher` and the real `stopForeground` against a fake store: the run is `Running@1` on the first poll, then `Succeeded@40`.

```
displayed: S:Running@1 E1 S:Running@1 E2 … E17 S:Succeeded@40
events displayed 17/40; last event (RunStatus Succeeded #40) shown: false
```

What a consumer sees is a task that logs quickly and fails: the progress stops partway, then a "snapshot Failed" line appears with none of the final error logs, and the `#N RunStatus Failed` line never prints. For foreground `Waiting`, the `WaitOpened` line can be cut off too. The draft only acknowledges the "initial terminal snapshot" case. This mid-run case is much more common: any task that writes more than 16 events in about 100 ms hits it.

**Smallest fix** (CLI only; no transport, frame, server or exit-code change): track `displayedThrough`, the highest event sequence displayed, starting at the cursor (0). While human progress is active, stop only when the existing predicate holds **and** `frame.run.lastSequence <= displayedThrough`. With progress suppressed (`--json`), keep today's predicate byte-for-byte and timing-for-timing. The final stdout still comes from `RunGet` after observation, and the exit-code mapping doesn't change. The extra cost is one or more immediate pages (no 100 ms sleep while events remain) **[source: run-watch only sleeps on empty pages]**. For foreground `Waiting`, the `WaitList` check then runs after catch-up, which only makes it fresher.

The same fix also decides what to do about an _initially_ terminal run (plain watch of a finished run, or foreground re-submission with a `--request-key` that has already completed). Its snapshot has `lastSequence > 0`, so its history replays and the stream ends naturally, the same as JSONL. I recommend that over the draft's "may end before replay". It removes a special case, and "what happened in run X" is the main reason to watch a finished run. Replay is bounded: at most 1000 telemetry entries plus lifecycle events. If the user prefers the draft's behaviour, the catch-up condition can be limited to snapshots after the first. Both choices are listed under D2.

This doesn't reopen settled watch contracts: the server, frames, cursors and exit mapping are unchanged. It changes only when the CLI stops pulling while it is displaying.

### F2: sink failure. Recommend degrading instead of exit 3

**[probe]** `sink-probe.ts` wrote with the `writeJsonLine` callback pattern to `process.stderr`, with stderr piped to `head -n1`:

- The 52nd write fails with `UnknownError (cause: Error: EPIPE: broken pipe, write)`. Bun doesn't die from SIGPIPE.
- After that, `Console.error` returns `Success`: the write fails silently, and the final stdout still appears.
- With `2>&-` (closed fd) and with a file redirect, all writes succeed.

**[source]** An `UnknownError` isn't an `OperationError` or an `RpcClientError`, so the CLI teardown (`main.ts:1394-1426`) maps it to **exit 2** and prints "Command failed". The draft's "Unavailable/exit 3" needs an explicit `mapError`. **[inference]** JSONL's broken _stdout_ currently exits 2 by the same path, so the draft's rule would also make the two sinks behave differently.

**Consumer recommendation:** stderr progress is decoration and stdout is the contract. If progress causes a command that used to succeed (for example, stderr piped to a log shipper that exits early) to fail with exit 3 and no stdout, that's a regression this feature introduced. Instead, on the first failed progress write, set a per-observation `displayEnabled = false`, keep observing silently, and print the final stdout and exit code unchanged. Observation hasn't stopped, so nothing is hidden, and there's no hint to write to a broken stderr. Once display is off, the predicate goes back to today's rule. A _slow_ sink should still apply backpressure; only an _error_ switches display off. This also answers the draft's open question: on Bun 1.4.3, `Console.error` already swallows EPIPE **[probe]**, so it needs no wrapper.

If the user still wants a hard failure, `mapError` to `OperationError{code:"Unavailable"}` with a distinct message, and record the deliberate exit-3-vs-JSONL-exit-2 difference. Either way it's a public decision (D4).

### F3: lifecycle tags the draft doesn't mention

**[source]** The runtime also writes:

- `RetryScheduled{attempt (next), deadline, nodeId}` (`interpreter.ts:330`)
- `CancellationRequested{actor, reason}` (`host-store.ts:506`)
- `NeedsAttention{nodeId}` (`host-store.ts:702`)
- `FinalizationStalled{deadline, message}` (`runner.ts:68`)
- `DeadlineStarted{deadline, name}` (`deadline.ts:55`)

Under the draft, all of these render tag-only. `RetryScheduled` is the only signal that an attempt failed, and `NeedsAttention` is what explains an exit 4. Both are exactly what a person watching wants to see.

Smallest fix: list them explicitly.

- RetryScheduled: nodeId, next attempt, and deadline as ISO.
- NeedsAttention: nodeId.
- CancellationRequested: actor and reason, escaped.
- FinalizationStalled: message.
- DeadlineStarted: name.

None of these claims anything the payload doesn't state. If they stay tag-only, say so, so the formatter fixtures pin that.

### F4: decode per field, not per event (minor)

A malformed `completed` in Progress shouldn't drop `message` and `nodeId`. Decode each optional display field on its own (`Schema.decodeUnknownOption` per field, or a struct whose fields are all `optionalKey`/`UndefinedOr`). Fall back to tag-only only when the payload isn't an object at all. Pin Progress counts with `Schema.Finite`. The source doesn't guarantee they're finite.

### F5: Effect ownership (agree, with two notes)

The plan is sound:

- `Stream.tap` (a sequential write) placed **before** `takeUntilEffect`, so the frame that triggers the stop is shown.
- State lives in an `Effect.suspend` closure, as `observeJsonLines` does with `after`.
- No forks, no Layer, and the observer slot is still owned by the RPC scope and `consumeObservation`.

**[probe]** `order-probe.ts` ran 2,000 awaited `process.stderr.write` callbacks followed by `console.error`. Order was preserved for a pipe and for a file. That supports keeping hints on `Console.error` while progress uses the callback writer.

Smallest refactor: generalize `writeJsonLine` into `writeLine(text, output)` and keep `writeJsonLine = writeLine(JSON.stringify(v), stdout)`, instead of copying the promise/listener code. **[inference]** If Ctrl-C interrupts a write blocked on a stalled stderr, the pending promise is abandoned (`tryPromise` without a signal), so exit 130 isn't delayed. Keep the existing interruption test, and add a case where stderr is stalled.

## Public decisions for the user

- **D1. Progress on stderr by default, including when stderr is redirected. Recommend: yes.** I agree with the draft: TTY-only would hide progress in CI and split the tests. Name the cost in the approval: `cmd 2>&1 | jq` and `out=$(cmd 2>&1)` worked on the success path before and won't now. Error and exit-4 paths already mixed in stderr. Fix: `--json`, or drop `2>&1`. Put this in release notes.
- **D2. Display completeness. Recommend: catch-up stop (F1), including full replay for a run that was already terminal.** The alternative is the draft's "an initial terminal snapshot may end display", which still needs F1 for snapshots after the first.
- **D3. `--json` both compacts stdout and turns off progress. Recommend: accept for this slice.** There's no way to get indented stdout without stderr progress except `2>/dev/null`, which also hides hints and errors. Write it down as "`--json` = machine mode". Leave a `--quiet` flag for later if someone asks.
- **D4. Sink failure. Recommend: degrade silently (F2) instead of Unavailable/exit 3.**
- **D5. (Low priority.)** Plain `run watch --after-sequence N` without `--jsonl` is still silently ignored. Once output is visible, a user who passes it will see replay from 0. Recommend either honouring it for the display cursor (it's already a `RunWatchRequest` field) or rejecting it outside `--jsonl`. Ignoring it silently is the worst of the three.

## Text corrections (conditionally approved; no further round needed)

- **T1. Swamp comparison.** Swamp's console renderer writes to **stdout** (`writeOutput` → `console.log`, `infrastructure/logging/logger.ts:308`). It is mutually exclusive with JSON mode (`createWorkflowRunRenderer` switches on `outputMode`), and it uses heartbeat `setInterval` timers and per-step maps (`workflow_run.ts:91-113`, `:153`). State that Effectory differs on purpose: stdout stays JSON, progress goes to stderr, with no timers or per-node maps. That makes the "simpler" claim concrete.
- **T2. Snapshot cadence.** Add: "the daemon sends a Snapshot after every non-empty page of at most 16 events". That's why the dedup-by-status rule is needed, and why a snapshot's status can be ahead of the events around it (F1).
- **T3. Escaping.** Escape **after** JSON formatting. **[probe]** `JSON.stringify` leaves U+202E (and C1 controls) unescaped, so "JSON-formatted message" isn't safe by itself.
- **T4. ArtifactPublished.** Don't use the payload's `sequence` (it's the lake sequence). Use the event's `sequence`. If a node is shown, use `invocationPath`.
- **T5. Log errors.** Say explicitly whether `error` (bounded JSON) is shown for `Error`/`Fatal` logs. Recommend showing it, escaped and under the same 2048 cap, because it's often the only useful line in a failing run. Otherwise keep "no error dump" and accept that `run logs` is where to find it.
- **T6. Example.** Use `task` or `workflow` from `RunSummary.kind` and `targetId` exactly. Add a `RetryScheduled` line and a final `RunStatus Succeeded` line, so the example shows the tail that F1 makes sure appears.
- **T7. "264 tests".** Remove it from the status line or link it to a dated verification record. This review didn't re-run it.

## Additional proofs to require (implementation tests, not probes)

- Real CLI: a task that writes 40 or more logs in under 100 ms with a distinctive last log. Non-JSON foreground stderr contains that last log and the final `RunStatus`, and stdout is byte-identical to today.
- Plain watch of an already-finished run, per the D2 outcome.
- Foreground Waiting: `WaitOpened` is shown before the exit-4 hint.
- Broken stderr (EPIPE) per the D4 outcome: either stdout and the exit code are unchanged, or there's an explicit exit 3 with a distinct message. Closed stderr (`2>&-`) doesn't fail.
- Formatter fixtures for the F3 tags, and for per-field fallback (F4).

## Scratch probes

These ran in the session scratchpad, outside the checkout, with Bun 1.4.3 and Effect 4.0.5 from the checkout's `node_modules`:

- `tail-probe.ts`: real watcher plus stop predicate, fake store (F1)
- `sink-probe.ts`: EPIPE / closed / file stderr with the callback writer, then `Console.error` (F2)
- `order-probe.ts`: ordering of callback writes vs `console.error` (F5); a separate one-line `bun -e` check showed `JSON.stringify` leaves U+202E unescaped (T3)
