# Live run observation — Claude Effect review, round 2 (narrow re-check)

Reviewer: Claude (Effect/Stream/Scope ownership, transport and bounds). Date: 2026-11-05. Subject: `docs/live-run-watch-api-draft.md` revision 2, as it stood on disk when this review was written, including consumer round-3 C4–C7. Pinned `effect@4.0.5` and `@effect/platform-bun@4.0.5`, Bun 1.4.3, Darwin.

**This is reviewer approval for presentation only.** It is not user approval and does not authorize implementation. The user has not approved any live-watch change. I changed no production code, did not edit the draft, and made no commits. Nothing below claims that an implementation was tested; the probes exercise pinned Effect and Bun in isolation, not Effectory code.

Evidence labels:

- **[source]** — code inspection of the checkout or of pinned Effect under `node_modules/effect/src`.
- **[probe]** — a scratch program I ran outside the checkout, importing the checkout's pinned `effect` through a symlinked `node_modules`.
- **[inference]** — reasoning that no test establishes yet.

Scope: only the three items requested. I did not re-examine the merged watcher/idle/ownership corrections or the consumer's foreground open-action policy.

## Verdict: APPROVE for presentation. No public change needed.

All three items hold under pinned Effect, subject to implementer proof obligations P1–P8 below. I suggest one optional wording tightening (W1) and one optional clarification (W2). Neither changes behaviour.

## 1. Line units, encoded-envelope guard, ordering and stdout bound

### Units: confirmed [source]

`RpcSerialization.makeNdjson` (`RpcSerialization.ts:150-200`) fails a complete line when `nlIndex - position > maxBufferSize`. It fails an unterminated tail when `buffer.length > maxBufferSize`. Both measure decoded JavaScript string length, which is UTF-16 code units, excluding the newline. So the draft's "2,097,152 units per encoded NDJSON line excluding its newline" is the exact acceptance condition: a line of exactly the limit passes.

### Boundary and guard: confirmed [probe `watch2/guard.ts`]

Setup: real `RpcServer.toHttpEffect` behind `Bun.serve` with NDJSON, `streamBufferSize: 4`, and a real `RpcClient.layerProtocolHttp` client. Server and client share `maxBufferSize` (scaled to 4,096 for speed). The upstream is one 4-frame chunk: `Event 1`, `Event 2` (containing `\u0001`, U+FFFF and an astral character), `Snapshot`, and a padded `Event 4`.

| Case | Lines on the wire (units) | Client received | Client exit |
| --- | --- | --- | --- |
| No guard, line 4 = 4,096 | 95, 103, 67, **4096**, 68 | E1, E2, S, E4 | success |
| No guard, line 4 = 4,097 | 95, 103, 67, **4097**, 68 | **nothing** | `RpcClientDefect: Error decoding HTTP response` |
| `rechunk(1)` → `mapEffect(guard)` → `rechunk(1)`, 4,097 | 95, 103, 67, 187 | E1, E2, S | typed `OperationError` `LimitExceeded`, "Event 4 …" |
| `mapEffect(guard)` only, 4,097 | 95, 103, 67, 187 | E1, E2, S | typed `LimitExceeded` |
| Guard over the whole array (`mapArrayEffect` + `forEach`), 4,097 | 187 | **nothing** | typed `LimitExceeded` |

Conclusions:

- **The guard expression matches the wire exactly.** For every frame, the guard computed `JSON.stringify({ _tag: "Chunk", requestId, values: [encode(frame)] }).length`, where:
  - `encode` is `Schema.encodeUnknownSync(Schema.toCodecJson(RunWatchFrame-like))`, which is the same `codecForJson` that `RpcServer` uses.
  - `requestId` is the value the handler receives in its options (`Rpc.Handler` options, `RpcServer.ts:274`).

  The computed value equalled the actual wire line length every time. Key order does not affect length. The draft's "real Schema-encoded Chunk line, including envelope/request ID" is therefore implementable without access to the serializer.

- **Without the guard, an oversized line loses earlier frames too, not just itself.** The parser throws partway through a read, so every line already decoded from that read is discarded (row 2). This is stronger than round 1 stated, and it is a further reason the server guard is required and must not be looser than the client limit.
- **Ordering.** Pinned `Stream.mapEffect` emits element by element, so preceding frames survive even without a prior `rechunk(1)` (row 4). Earlier frames are lost when the guard validates a whole array before emitting any of it (row 5). Separately, `RpcServer.streamEffect` sends one `Chunk` line per upstream array (`Stream.runForEachArray`, `RpcServer.ts:471`). `run-watch.ts` emits up to 16 Events plus a Snapshot per array, so the trailing `rechunk(1)` at the RPC boundary is what makes "one frame per line" true. The draft requires both, which is correct. See W1 for an optional wording change.
- **The typed failure line is small.** Its `Exit` line was 187 units for a short message. The daemon-authored message contains at most three 200-unit run IDs, the sequence and fixed text, so it stays within a few KiB [inference from `history-protocol.ts` `Id`].
- **Typed failure arrives after the preceding Chunks.** On the client, the `Exit` was observed after the preceding Chunks had been handed to `runForEach` (rows 3–4). The CLI writes each frame before pulling the next (`json-lines.ts`), so the last Event written is the last delivered Event before N [probe + source].

### Sequence in the bounded failure: confirmed as feasible [source]

The guard sees the frame value, so it can name `event.sequence` and `runId` for Event frames and the frame tag for other frames, as the draft says.

### 6,291,457-byte stdout bound: correct and conservative [source + inference]

- The CLI prints `JSON.stringify(decodedFrame)` (`json-lines.ts`). `RunWatchFrame` decoding preserves length:
  - `Event.payload` is `Schema.Json`, and the other fields are strings and integers.
  - `RunSummary.tags` has a decoding default, but the server always encodes `tags`.

  The stdout line is therefore the frame portion of the envelope line, which is strictly shorter than that line.

- `JSON.stringify` escapes lone surrogates, so its output is well-formed. Each UTF-16 unit then encodes to at most 3 UTF-8 bytes, and a surrogate pair to 4 bytes for 2 units. That gives at most 3 × 2,097,152 + 1 (newline) = 6,291,457 bytes.

The real upper bound is lower by the envelope overhead, but that does not need to be stated.

## 2. Oversized-event recovery guidance

### The objection holds [source]

- `run events` takes `--after-sequence`, not `--after` (`main.ts:474`).
- `inspection.ts:eventPage` adds `Buffer.byteLength(JSON.stringify(item))` and throws `LimitExceeded` ("Event exceeds page byte limit") when the first item alone exceeds 1,048,576 bytes.
- An event that exceeds the watch cap has an item JSON longer than (2,097,152 − envelope overhead) units. The UTF-8 byte count is at least the unit count, so the event necessarily exceeds the page cap. Round 1's suggestion `run events <id> --after <seq-1>` therefore cannot retrieve it, under either flag name.

### The revision-2 remedy is the smallest truthful one [source]

- The skip command `run watch <id> --jsonl --after-sequence <N>` works with current code:
  - `afterSequence` is exclusive (`host-store.ts:857`, `sequence > ?`).
  - `observation` accepts N ≤ lastSequence.
  - Sequences are allocated as `lastSequence + 1` per run (`host-store.ts:318`).
- Non-JSONL `run watch` ignores its parsed `--after-sequence` flag (`main.ts:497-501` calls `observe(client, id, false)`). Offering the skip only with `--jsonl` is therefore correct. That D1 does not widen plain watch is a user decision, already flagged.
- The message is daemon-authored and printed unchanged, so the CLI parses no message text. Plain and foreground observation get no generic reattach hint for `LimitExceeded`, so there is no loop.
- No authoring path bound and no export API is added.

### W1 (optional wording) — "this release has no reader for it"

That is true of the CLI and RPC readers in this release. However, the raw row is still preserved by repository backup/snapshot, so a careful reader could find the wording overbroad. Suggested wording: "this release has no CLI or RPC reader for it." This is a wording change only, with no behaviour change. If the consumer reviewers have already settled the exact text, leave it.

### W2 (optional clarification) — "L is N−1"

This holds when history is contiguous from the starting cursor, which is current allocation behaviour. The draft already says to print the actual last-written L rather than compute it. Keep it that way, and have the test assert the printed value against the frames actually written. A one-line note is unnecessary unless retention can later remove events mid-history.

## 3. Remote interruption (exit 3) versus local Ctrl-C (exit 130)

### Feasible with ordinary Effect, and the problem is real [source + probe `watch2/interrupt.ts`]

[source] When a server handler fiber ends in failure without having responded, `RpcServer` sends `Exit.interrupt()` (`RpcServer.ts:404-414`). It also interrupts handler fibers when its scope closes. On the client, an `Exit` message is decoded and becomes the request's exit (`RpcClient.ts:759-771`). So a remote interruption reaches the client's stream as an **interrupt-only Cause**. The current CLI teardown maps any `Cause.hasInterrupts` to 130 (`main.ts:1361`).

[probe] Setup:

- The driver process hosts a real NDJSON `RpcServer` behind `Bun.serve` with `timeout(req, 0)`.
- The client is a separate `bun` process under `BunRuntime.runMain`, with a copy of the CLI's teardown mapping.
- The server handler stream emits a frame every 150 ms, and its server-side finalizer is counted.

| Remote/local event | Naive `runForEach` in main fiber | `Effect.forkScoped(consume)` + `Fiber.await`, interrupt-only child exit → `Unavailable` |
| --- | --- | --- |
| Handler interrupted after 3 frames (socket open) | **130**, no hint | **3**, "Run … accepted … `--after-sequence 3`" |
| Server RPC scope closed while Bun is still serving | **130**, no hint | **3**, accepted-run hint with last-written cursor |
| `Bun.serve.stop(true)` mid-stream | 3 (`RpcClientError`) | 3 (`RpcClientError`) |
| SIGINT to the client process | 130 | **130**, no hint |

In every case the server-side finalizer ran (released = 1). In the fork case the printed cursor equalled the last frame written to stdout.

How the classification works:

- Local SIGINT interrupts the main fiber. That interrupts `Fiber.await` itself, and the enclosing Scope then interrupts the child, so no code after `await` runs.
- A remote interruption completes the child with an interrupt-only Cause while the parent is still running, so the parent maps it to `Unavailable` and keeps the accepted run ID and last-written cursor.
- `Fiber.join`, or consuming in the main fiber, would re-raise the interrupt and erase the distinction, as the "naive" column shows. The draft's direction is correct.

[inference, not probed against `daemon.ts`] In the real daemon, the program Scope releases `Bun.serve` (`stop(true)`) before the RPC server scopes, because they are released in reverse order of acquisition. A plain daemon stop therefore most likely reaches the CLI as `RpcClientError`, which already exits 3, but today it prints only "Command failed". The interrupt-only path matters whenever a watch handler is interrupted while its socket is still open: draining, an RPC-scope close ordered before Bun stops, or a future change in ordering. Both paths must produce the accepted-run guidance.

### Residual race (tolerable, worth a test note)

If SIGINT arrives after the child has already exited with a remote interrupt but before the parent fails with `Unavailable`, the final Cause can contain both. Teardown checks for `OperationError` before interrupts, so the result would be 3. This is a narrow window, and either answer is truthful. Do not add machinery for it.

## Implementer proof obligations (no draft change required)

1. **P1 — exact boundary.** The server guard limit equals the client `maxBufferSize` (2,097,152). Test a line of exactly the limit (delivered) and one unit over (typed `LimitExceeded`, preceding frames delivered), using real Effectory `RunWatchFrame` fixtures and a real request ID.
2. **P2 — per-element guard.** Guard each frame with a per-element operator, and keep `Stream.rechunk(1)` after the guard as the final step before the RPC boundary. Add a regression test with a multi-frame upstream array whose last frame is oversized; it must deliver the earlier frames. Never validate a whole array before emitting it.
3. **P3 — stdout length.** For the fixtures, assert that the stdout line length is no greater than the guarded envelope line length. This protects the 6,291,457-byte claim against future schema transformations.
4. **P4 — bounded failure and defect lines.** Bound the `Exit` line for typed failures and handler defects, for example by mapping handler defects to a bounded `OperationError` before the RPC boundary. Include a test that a defect carrying a large message cannot produce an over-limit line.
5. **P5 — page-cap truthfulness.** For one oversized event, `run events <id> --after-sequence <N−1> --limit 1` fails `LimitExceeded`. This keeps the message's "also exceeds the run events page limit" honest.
6. **P6 — interrupt classification.** Consume the stream in a child forked into the observation Scope (`forkScoped`, or `forkChild` within `Effect.scoped`), then `Fiber.await`. Map an interrupt-only child exit to `Unavailable` with the accepted run ID and last-written Event cursor. Never `Fiber.join`. Keep final `RunGet` outside the child.
7. **P7 — real daemon cases.** Test against a real daemon and the real CLI:
   - (a) `daemon stop` during foreground and during JSONL observation exits 3 with accepted-run/resume guidance, whichever of `RpcClientError` or interrupt-only it produces;
   - (b) a test-induced handler interruption with the socket open exits 3;
   - (c) SIGINT exits 130 with no remote hint, and the server-side observer and permit are both released.
8. **P8 — exit precedence.** Typed `LimitExceeded`, whether for capacity or oversize, still exits 5 through the fork path. The child's exit is a `Fail`, not interrupt-only, so it must be re-raised unchanged.

## Public choices for the user (unchanged)

No new choice. Items still requiring user approval are those the draft already lists: the capability requirement, the foreground return rule, the oversized-event typed failure with explicit lossy JSONL skip, and D1.

## Evidence files

In `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/298249ce-5558-4785-97cb-c53212ddc557/scratchpad/watch2/`, outside the checkout:

- `guard.ts` — envelope guard versus wire length, exact client boundary, per-element versus whole-array guarding, and loss of earlier frames without a guard (§1).
- `interrupt.ts` and `out.txt` — remote handler interruption, RPC-scope close, Bun stop and SIGINT under `BunRuntime.runMain`, naive versus `forkScoped` + `Fiber.await` (§3).
