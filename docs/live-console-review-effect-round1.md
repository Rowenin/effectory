# Live console proposal — Claude Effect + consumer review, round 1

Reviewed: `docs/live-console-api-draft.md` (current checkout, untracked). Feature status: **not approved**. This review authorizes nothing. It does not reopen the settled live-watch transport, which covers frames, cursor semantics, observer limits, the oversized-event skip and JSONL bytes.

Evidence labels: **[source]** means read in this checkout. **[probe]** means a scratch script outside the checkout, run against the pinned `effect@4.0.5` and Bun 1.4.3 (`bun --version` = 1.4.3), in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/cb497bdd-b943-45b1-99fe-3dfc69b76d48/scratchpad/console-probes/`. **[inference]** means reasoning only. The probes are not implementation tests. Each one still needs a real CLI or unit test in the implementation.

## Verdict

**Approve the direction, with corrections.** The design is coherent. It uses a private pure formatter and a sequential consumer of the existing scoped stream. It has no new public surface and keeps JSON/JSONL as the automation interfaces. Corrections C1–C7 are small text changes. Once the text includes them, the draft is **conditionally approved on the Effect side without another round**. The user still has to make public decisions D1–D3 before implementation.

## Source facts checked

| Draft claim | Result |
| --- | --- |
| `print` writes JSON to stdout, indented unless `--json` | ✓ `packages/cli/src/main.ts:89-95` [source] |
| `observe` uses the streaming client but discards frames | ✓ `Stream.takeUntilEffect` → `Stream.runDrain`, `main.ts:193-226` [source] |
| `observation.ts` owns the stop rule and interruption classification | ✓ `stopForeground`, and `consumeObservation` maps interrupt-only to `Unavailable`, `observation.ts:6-35` [source] |
| Snapshot/Event/Heartbeat frames; Event payload is `Schema.Json` | ✓ `history-protocol.ts` `RunWatchFrame`; `protocol.ts:92-98` [source] |
| First Snapshot arrives promptly | ✓ The server sends the initial Snapshot first. Each non-empty event batch is followed by a Snapshot of the state at query time (`platform-bun/src/run-watch.ts:41-50`) [source]. So the terminal Snapshot that stops the observation always comes after its batch's Events, and deduplicating repeated snapshot lines is needed. |
| WaitOpened `{nodeId, waitId}`; WaitSettled `{status, waitId}` | ✓ `host-store.ts:1204-1207`, `:457-460` [source] |
| No AttemptSucceeded event | ✓ no producer found [source] |
| AttemptStarted carries nodeId and attempt | ✓ The payload is `{attempt, deadline, nodeId, startedAt}` (`host-store.ts:715-724`) [source] |
| Progress = `Task.Progress` plus nodeId and attempt | ✓ `core/src/task.ts:39-43`; `interpreter.ts:92-101` [source]. `completed` and `total` are TypeScript `number` only and are not checked for finiteness. |
| ArtifactPublished payload is the stored publication metadata | ✓ the normalized `ArtifactRecord` (including `artifactId` and `version`); the event `at` is `committedAt` (`lake.ts:341-372`) [source] |
| TelemetryTruncated | ✓ `{code: "LimitExceeded", message}` (`host-store.ts:388-392`) [source] |
| Log payload | ✓ `LogPayload {attempt, error, level, message: Json, nodeId}`. `message` is at most 2 KiB of JSON (`task-logger.ts:6-16`). Log and Progress are capped at 8 KiB per entry, 1000 entries and 1 MiB per run (`host-store.ts:384-387`) [source]. This bounds human output volume for telemetry. |
| Swamp references | ✓ `consumeStream` at `vendor/swamp/src/cli/commands/workflow_run.ts:776`; renderer file exists [source] |
| RunAccepted "tag only" | Fine. The payload is `{revision}`, which the snapshot already carries. |

**Tags the draft does not map.** These currently get the tag-only fallback [source]:

- `NeedsAttention {nodeId}` (`host-store.ts:702`)
- `CancellationRequested {actor, reason}` (`:506`)
- `RetryScheduled {attempt, deadline, nodeId}` (`interpreter.ts:330`; `attempt` is the _next_ attempt)
- `DeadlineStarted {deadline, name}` (`deadline.ts:55`)
- `FinalizationStalled {deadline, message}` (`runner.ts:68`)

See C5.

## Effect ownership

**Placement of the display relative to the stop predicate (C1).**

- **[probe]** `p1-effect.ts` case 3, with `Stream.tap(write)` before `Stream.takeUntilEffect(pred)`: the output was `write 1, pred 1, write 2, pred 2`. The triggering element is displayed and nothing after it is displayed.
- **[probe]** Same script, case 3b, with `takeUntilEffect` and then `runForEach(write)`: the output was `pred 1, pred 2, write 1, write 2`. The predicate runs over a whole chunk before anything is displayed.
- **[inference]** RPC frames arrive in chunks. With the 3b placement, the foreground `WaitList` RPC inside the predicate would run before the frames that triggered it are shown, and display would lag by a chunk.
- The draft's wording ("before applying the existing stop predicate") is correct. It should name the operator order explicitly.

**Reducer state.** **[inference]** Keep one local variable inside `Effect.suspend` per observation, the same pattern as `observeJsonLines` (`main.ts:228-257`). The stream is consumed sequentially, so it needs no `Ref`, `Layer` or shared map. `Stream.mapAccum` would also work, but a local variable is smaller.

**Writer and backpressure (C2).**

- **[source]** `writeJsonLine` always calls `JSON.stringify(value)`, so passing pre-formatted text would wrap it in quotes. The implementation needs a private text-line variant with the same callback/`error`-listener contract. One option is to extract `writeLine(text, output)` and have `writeJsonLine` call it with the JSON-encoded value, which leaves JSONL bytes unchanged.
- **[probe]** `p3-slow.ts`: stderr pointed at a FIFO that was never read. The writer stalled after about 8 KiB, the event loop stayed alive (a timer kept firing), and SIGINT ran the finalizer. `BunRuntime.runMain` teardown reported interruption, and the process exited 130. There was no detached fiber and no unbounded queue.
- **[inference]** An interrupted in-flight write leaves one `once("error")` listener attached. That is bounded and harmless because the process exits.
- Release of the server-side observer slot depends on the existing RPC scope. This review did not probe it again because it is settled transport behavior.

**Ordering.** **[probe]** `p4-order.ts`: 100 awaited 2 KB stderr writes, then `Console.error`, then more writes. Order was preserved through a stalled pipe and a file in 4 of 4 runs. The exit-4 hint therefore appears after progress output. This is probe evidence only, so the real CLI test should assert it.

## Output failure

**Typed mapping is required, not automatic (C3).**

- **[probe]** `p1-effect.ts` case 1: `Effect.tryPromise` without `catch` fails with `UnknownError`.
- **[probe]** `p2-stderr.ts`: a broken stderr pipe reaches the write callback as `EPIPE`, which becomes `UnknownError`.
- **[source]** `cli()` teardown (`main.ts:1404-1425`) maps only `OperationError` codes and `RpcClientError`. Anything else exits 2 with the message "Command failed".
- **[source]** As written, a failed progress sink would therefore exit 2, not the draft's exit 3. That is also how a broken JSONL stdout currently ends, because it uses the same writer. This review does not propose changing that.
- **Fix:** the private progress writer maps its write error to `OperationError({ code: "Unavailable", message: "Progress output failed; observation stopped…" })`. `consumeObservation` passes typed failures through unchanged (`Effect.failCause`), and `observationHint(runId, accepted)` then attaches the accepted run ID.

**A recovery hint must not mask the original failure (C4).**

- **[probe]** `p1-effect.ts` case 2: `Effect.tapError` with a hint that dies leaves no typed error, so the run exits 2.
- **[probe]** Case 2b: if the hint fails, its error _replaces_ the original.
- **[probe]** Case 2c: `Effect.ignore` does not catch the defect.
- **[probe]** Case 2d: `.pipe(Effect.catchCause(() => Effect.void))` on the hint keeps the original `OperationError`.

On Bun 1.4.3, `Console.error` and `console.error` to a broken stderr succeed silently, and the process survives SIGPIPE (`p2-stderr.ts`, `p2b-nohandler.ts`) **[probe]**. So the existing `observationHint` and the top-level `Console.error` boundary do not need a new service or wrapper today. The rule to write down: a best-effort hint is wrapped with `catchCause`, never with `ignore`, and a hint is never written through the callback writer. This is a private implementation detail, not a new boundary.

## Payload projections

- **[probe]** `p1-effect.ts` case 4a: `Schema.Struct` drops extra keys by default, so projections can declare only the fields they display.
- **[probe]** Cases 4b–4d: a non-object payload, a non-string `message`, or `completed: null` makes the whole projection fail.
- **[inference]** `completed: NaN` from an author would probably be stored as `null` after canonical JSON encoding. As drafted, one bad optional count would hide the progress message.
- **C6:** decode the required fields of a projection strictly, and decode each optional count separately (or as `Schema.Unknown`, refined individually) so a bad optional field is dropped on its own.
- Use the synchronous `Schema.decodeUnknownOption` inside the formatter so it stays pure, with no effectful decode per frame.

## Escaping and truncation (C7)

**What `JSON.stringify` misses.** **[probe]** `p5-escape.ts`: `JSON.stringify` escapes C0 controls and lone surrogates. It leaves these **raw**:

- DEL U+007F
- C1 controls, including U+009B (CSI) and U+0085
- U+202E and U+2066
- U+200E and U+061C
- U+2028 and U+2029
- U+FEFF
- ZWJ

A "JSON-formatted message" therefore still needs a separate escaping pass.

**Escape set.** Define it as the code-point class `[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]`, which covers everything the draft lists and more. Iterate by code point with `for…of`. Lone surrogates then arrive as single units and get escaped, which keeps the output well-formed. The cost is that `\p{Cf}` also escapes ZWJ inside emoji sequences. That is acceptable for a log line. A narrower hand-written list is the alternative, but it has to be pinned in tests.

**Apply it to every server-supplied string.** That includes the event **tag** (`Schema.String`, always printed, and arbitrary for unknown tags), `runId`, `targetId`, `waitId`, `nodeId` and enum-like strings such as `status`. Escape `nodeId` directly; do not re-JSON-encode it, because it is already a JSON path string.

**Truncation.** Make each escape sequence an atomic token, and apply the 2048-code-point budget (suffix included) over the tokens. **[probe]** The candidate algorithm gave a line of exactly 2048 code points that was well-formed and contained no raw unsafe character, and it did not split an escape token at the boundary.

## Consumer critique

1. **Default-on stderr progress (D1).** Recommended. Progress on stderr with the result on stdout is the common CLI convention, and showing it under CI redirection is useful. The real cost is scripts that run `out=$(effectory task run … 2>&1)` and parse JSON. Those already break on exit-4 hints, but they will now break on every run. `--json` is the documented escape. TTY-only output is a reasonable alternative but should not be adopted silently. Agree with the draft.
2. **`--json` both compacts stdout and silences progress (D2).** This couples two concerns. With no new flags, there is no way to get indented stdout without stderr progress, apart from `2>/dev/null`, which also hides errors. Accept it as the smallest coherent option, and say so in the help text. The draft's rule that `--jsonl` wins is correct.
3. **Sink-failure exit code (D3).** Exit 3 matches "observation ended; the run continues; inspect it by ID". The existing docs, though, describe exit 3 as _remote_ disconnect (`README.md:200`, `docs/live-run-observation.md:21`). A broken local JSONL stdout exits 2 today [source, see C3]. Either accept the asymmetry and widen the doc wording to "observation lost → exit 3", or map progress failure to the generic exit 2. Recommendation: exit 3 with the accepted run ID, documented as "observation lost". Leave the JSONL behavior unchanged.
4. **Replay of an already-terminal run.** Plain `run watch` shows only the snapshot line and the final JSON, because the first Snapshot is terminal. The draft accepts this; the help text should point to `--jsonl` for history.
5. **Unmapped tags (C5).** The events a human most wants while a run looks stuck are RetryScheduled, NeedsAttention, CancellationRequested and FinalizationStalled, and the draft renders them tag-only.

## Corrections (text only; conditionally approved once applied)

- **C1.** State the operator order: `Stream.tap(display)` before `Stream.takeUntilEffect(existing predicate)`. Do not put the display in `runForEach` after the predicate.
- **C2.** The writer is a private text-line variant of the `writeJsonLine` callback contract. JSONL bytes stay unchanged.
- **C3.** Map the progress write failure (`UnknownError` today) explicitly to a typed `OperationError`. It is not automatically exit 3.
- **C4.** Best-effort hints use `catchCause(() => Effect.void)`, not `ignore`. They never go through the callback writer. No new `Console` wrapper is needed on Bun 1.4.3 (probe).
- **C5.** Either add `RetryScheduled` (nodeId and the next attempt), `NeedsAttention` (nodeId), `CancellationRequested` (actor; escaped reason) and `FinalizationStalled` (message) to the mapping table, or list them explicitly as tag-only. `DeadlineStarted` can stay tag-only or show its name.
- **C6.** Decode required projection fields strictly and optional counts per field, using `decodeUnknownOption` synchronously.
- **C7.** Escape set `[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]`, applied to the tag and to every id and status string. Escape tokens are atomic. Truncation counts code points after escaping and includes the suffix.

## Decisions for the user (public)

- **D1.** Default-on stderr progress, including when stderr is redirected, or TTY-only.
- **D2.** `--json` silences progress as well as compacting stdout, with no new flag.
- **D3.** Exit code and wording for a failed progress sink: exit 3 "observation lost", or exit 2 like a broken JSONL stdout today.

Exact human wording carries no stability promise. Agree.

## Tests the implementation needs (beyond the draft's list)

- The triggering Snapshot is displayed before the foreground `WaitList` check, with frames delivered in a multi-frame chunk.
- Broken stderr ends with the mapped typed error, exit code D3, the accepted run ID and no resubmission.
- A hint whose write fails or dies does not change the exit code.
- `completed: null` keeps the progress message.
- The tag, ids and statuses are escaped.
- An escape token at the 2048 boundary is not split.
