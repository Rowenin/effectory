# Live run observation — Claude Effect review, round 1

Reviewer: Claude (Effect/Stream/Scope/Layer ownership, transport and bounds). Date: 2026-11-05. Subject: `docs/live-run-watch-api-draft.md` (72 lines, untracked, unchanged by this review). Pinned `effect@4.0.5`, Bun 1.4.3, Darwin.

**This is reviewer approval for presentation only. It is not user approval, and it does not authorize implementation.** I changed no production code and did not edit the draft. I did not read the consumer review, so this one is not anchored on it.

Evidence labels used below:

- **[source]**: code inspection of the checkout or of pinned Effect.
- **[probe]**: a scratch program I ran, outside the checkout.
- **[inference]**: reasoning that no test establishes yet.

## Verdict: CONDITIONAL APPROVAL for presentation, after R1–R3

The diagnosis is correct. The separate NDJSON route is the right reuse of the bytes transport. The proposed ownership model is sound in principle.

Two statements in the draft cannot stand as written:

- **The line budget.** The proof obligation "establish the maximum encoded Event frame" cannot be met with a constant today. Event payloads that embed `nodeId` have no upper bound across child-workflow chains (R1).
- **The idle-timeout alternative.** "or verify existing heartbeats keep it consistent" is disproved by probe. A stalled reader trips Bun's idle timeout even though heartbeats are being produced (R2).

R3 makes the shared-observer construction explicit, so it does not depend on Layer memoization luck. With R1–R3 applied as text, I expect no further Effect round to be needed.

## Claims verified

### 1. Buffering diagnosis

**Confirmed** [source, probe].

- **Server.** `RpcServer.makeProtocolWithHttpEffect` (`effect/src/rpc/RpcServer.ts:1186-1255`) creates the response queue with no capacity when `includesFraming` is false. It then calls `Queue.collect` before it builds the response.
- **Client.** `RpcClient.makeProtocolHttp` reads `response.text` for unframed serialization.
- **Probe.** `scratchpad/watch/legacy.ts` runs a stream that heartbeats every 5 s over `layerJson` behind `Bun.serve` with the default idle timeout. All four frames arrived together at 15.04 s, after the server stream ended. The connection was not cut.

So the draft's wording is accurate: on `/rpc`, a foreground run waiting for approval **stays blocked**. It does not time out, because Bun's idle timer does not fire while the handler's Response promise is still pending.

Undocumented legacy cost [source]: while a legacy watcher is blocked, its unbounded server queue keeps accumulating Heartbeat frames, about 12 per minute. This is bounded by the 16 observers and ends when the run terminates or the client disconnects. Document it as a legacy limitation; nothing needs to change.

### 2. Foreground waiting

**Confirmed** [source].

- `packages/cli/src/main.ts:156-175` `observe(…, untilWaiting = true)` uses `Stream.takeUntil` on a `Waiting`/`NeedsAttention` Snapshot, then calls `RunGet` and sets exit code 4.
- Every `host_runs.status` write emits an event in the same transaction:
  - `project` → `RunStatus`
  - `Cancelling` → `CancellationRequested`
  - `NeedsAttention` → `NeedsAttention` (`host-store.ts:473,699,1231`)

  The watcher emits a Snapshot after every non-empty event batch (`run-watch.ts:47-49`), so a status change always produces a Snapshot. A status change with no event, which would leave foreground waiting until a heartbeat, does not occur in current code.

- Probe `scratchpad/watch/rpc.ts`, case A: with NDJSON, the first frame reached the client 9 ms after acquisition. `Stream.take(1)` on the client then released the server-side `acquireRelease` within 3 ms, so the abort reached the server. Ending foreground with `takeUntil` therefore frees the observer.

Consumer caveat (existing behaviour, worth one sentence in the draft): the Snapshot comes from the same transaction as a batch of up to 16 events. A terminal or Waiting Snapshot can therefore appear **before** the remaining Events of that run. JSONL consumers must treat stream end, not a terminal Snapshot, as completion.

### 3. Shared observer count

**Confirmed as current behaviour** [source].

`createRunWatcher` keeps a closure counter and is called once, inside `controlPlaneLayer` (`control-plane.ts:186`). `SystemStatus.observers` reads that same instance. Authorization and range checks run before the admission check (`run-watch.ts:13-14`).

### 4. Event and Snapshot sizes

**Measured** [probe `scratchpad/watch/frames.ts`].

Each frame was encoded through the real `RunWatchFrame` schema and wrapped in the NDJSON `Chunk` envelope with `rechunk(1)`.

| Frame | UTF-16 units | UTF-8 bytes |
| --- | --: | --: |
| Snapshot, near-maximal tags (4 KiB rule), ids at 200 | 5,136 | 5,136 |
| Log/Progress, 8 KiB canonical payload (`telemetry` cap) | 8,393 | 8,393 |
| CancellationRequested, 8,192-unit reason of U+FFFF | 8,459 | 24,843 |
| CancellationRequested, 8,192-unit reason of `\u0001` or lone surrogates | 49,419 | 49,419 |
| AttemptStarted, one graph, depth 16, 200-unit ids and item keys of `\u0001` | 26,268 | 26,268 |
| AttemptStarted, 10 child-workflow hops of the above | 259,937 | 259,937 |
| AttemptStarted, 80 hops | 2,077,487 | 2,077,487 |
| AttemptStarted, 10,000 hops, ids only | 2,050,287 | 2,050,287 |

Where each bound comes from [source]:

- `appendEvent` limits its payload to 8 KiB (`host-store.ts:738`), and so does `telemetry`.
- The following call the internal `event()` directly, with no size check: `AttemptStarted` and `NeedsAttention` (`host-store.ts:702,715`), `WaitOpened` (`:1204`) and `CancellationRequested` (`:506`).
  - Their `nodeId` is `JSON.stringify(invocationPath)` (`graph-execution.ts:42`).
  - Within one graph, depth is limited to 16 (`core/src/workflow.ts:325`).
  - Item keys are at most 200 UTF-16 units (`interpreter.ts:660`).
  - `executeChild` adds one path segment per child workflow (`interpreter.ts:748`). The only limit on child chains is acyclicity over at most 10,000 definitions (`application.ts:146`, `definition-discovery.ts:60`).
- `LogListRequest.nodeId` and `OutputListRequest.nodeId` already cap the filter at 8,192 units. Node IDs longer than that are therefore already not filterable.

**Conclusion.** The largest frame from a realistic single workflow is about 26 KiB, and the cancellation reason bounds out at about 49 KiB. 2 MiB covers every single-definition path. It does **not** cover all valid repositories: the 80-hop case is within 20 KiB of the limit, and 81 hops exceeds it.

### 5. What `maxBufferSize` measures

[source] `RpcSerialization.makeNdjson` compares `buffer.length` (UTF-16 code units after `TextDecoder`), not bytes. It throws `MaxBufferSizeExceeded` both for an oversized complete line and for an oversized unterminated tail. Lines that fail to parse as JSON are dropped silently (`catch {}`). On the server that is harmless only because the request is pre-validated, as the content route already does.

### 6. Prompt first frame

[source, probe] For a framed serialization, `httpEffect` sends headers after the first `Queue.takeAll`, and the watcher always emits its initial Snapshot first. In the probe the first frame arrived in under 10 ms.

### 7. Separate WatchPlane and route

**Accepted as the simplest sound reuse.** Two alternatives are worse:

- **Switching `/rpc` to NDJSON** breaks old clients. Their unframed client parses a single JSON array from `response.text`.
- **Merging RunWatch into `/rpc/content`** requires per-tag admission, because downloads have 4 permits and watch has 16, decided before the adapter runs. It also ties a run capability to `lake.bytes.v1` naming.

A one-method group on its own route reuses all of these unchanged:

- the bounded pre-adapter reader (`contentRequest`)
- request-scope permits (`makeContentHandler`)
- `RpcServer.toHttpEffect({ streamBufferSize: 4 })`
- `rechunk(1)`
- the client's `connectContent` shape

A **suggestion**, not a requirement: declare the `RunWatch` Rpc once and include that same value in both `ControlPlane` and `WatchPlane`. Redeclaring it risks the two schemas drifting apart. That `Rpc.make` values can be shared across groups is [inference]; I did not probe it.

### 8. The 16 producer permits on the route

**Accepted** [source].

- Bun's `inFlight` gate (`daemon.ts`) is released when the `Response` object is returned, not when the body finishes streaming.
- The observer counter is released when the handler's stream ends, which can be before the HTTP body drains.

Only an HTTP-scope permit bounds response bodies that linger behind slow readers. It is an additional guard, not a second allowance of observers, and the draft states this correctly. The "release is not atomic" wording matches binary round 4 S1, which is correct.

### 9. Shutdown ordering

[source; inference for the new route] `serve` builds `serviceContext` before `RpcServer.toHttpEffect`, `contentHandler` and `Bun.serve`, all in one program Scope. The reverse release order closes the RpcServer scopes, interrupting handler fibers, before services release. Building the watch handler in that same Scope, after `serviceContext`, inherits this ordering. The draft's acceptance item already requires proving it.

### 10. CLI preflight

**Accepted.**

- `connectWatch`, modelled on `connectContent`, performs `SystemHello` plus a `SystemStatus` capability and instance check. It makes no request to `/rpc/watch` until `RunWatch` is pulled: the HTTP protocol is lazy [source, `RpcClient.makeProtocolHttp`]. Calling it before `TaskRun`/`WorkflowRun` is therefore exactly the preflight that is needed, and it costs no extra round trip to the watch route.
- An old daemon would answer `/rpc/watch` with 404 after authentication. Preflight means a new CLI never reaches that.
- Check-then-submit has a time-of-check gap: the daemon could be replaced between the check and the submission. That only leads to the draft's "admitted run ID plus resume command" path, which is the correct handling.
- Requiring the capability for non-JSONL `run watch` too is reasonable. Otherwise a new CLI would keep using the buffered route, with its heartbeat accumulation, against new daemons. That remains a public compatibility choice for the user, as the draft already says.

## Required corrections

### R1. Replace the 2 MiB proof obligation with measured bounds and an explicit oversize behaviour

The obligation as written cannot be discharged (§4). The smallest coherent correction stays inside this slice and changes no authoring API.

1. State the limit precisely:

   > "Client NDJSON line limit 2,097,152 UTF-16 code units (Effect `maxBufferSize` semantics)."

2. Record the measured bounds:

   > "Snapshot ≤ ~5 KiB, telemetry and `appendEvent` Events ≤ ~8.4 KiB, cancellation ≤ ~49 KiB, single-workflow `nodeId` Events ≤ ~26 KiB. Child-workflow chains are not bounded by a constant."

3. Add a server-side guard on the watch route:

   > "Before emitting a frame whose encoded `Chunk` line would exceed the limit, the watch stream fails with typed `OperationError` `LimitExceeded`, naming that Event's sequence. Earlier frames are delivered. Nothing is truncated, skipped or reshaped. The CLI reports `run events <id> --after <seq-1>` as the way to read it."

Why it matters: without the guard, the client fails with an untyped `RpcClientError` decode defect. The JSONL path then prints `Resume … --after-sequence N`, and resuming hits the same frame again: an endless resume loop.

The guard costs one extra `JSON.stringify` per frame, which is acceptable at these sizes. It must also cover the encoded failure and defect line, or else bound the length of `OperationError.message`.

**Alternative, which is a user decision and outside this slice:** cap the invocation path at runtime, for example at 8,192 units to match the existing `nodeId` filter limit. That is an authoring-visible behaviour change for deep child chains, so it should not be decided silently here.

### R2. Commit to `bunServer.timeout(request, 0)` for watch connections and drop the "or verify heartbeats" alternative

[probe `scratchpad/watch/rpc.ts`, case B; `scratchpad/watch/slow.ts`]

- **Silence.** With `idleTimeout: 2`, a streamed response that went silent for 3 s was reset (`RpcClientError: HttpError`). With `timeout(request, 0)` the same stream completed.
- **Stalled reader.** A reader that stalls under backpressure is also reset after the idle timeout (ECONNRESET at 4.0 s), even though the producer has data ready. The daemon's effective default is 10 s.

So a JSONL consumer that pauses, such as `| less`, a full pipe or a debugger, would be disconnected despite 5 s heartbeats.

Replace the sentence with:

> "Watch connections disable Bun's idle timeout, as content does. Cancellation, peer close and shutdown own cleanup. A stopped but connected client holds one observer and one producer permit, as on the legacy route."

Add to the proofs: "a stalled reader for more than 10 s, with a waiting run that is only heartbeating, keeps its connection and resumes without loss."

### R3. One construction site for the shared watcher, and the permit/observer order

1. **Single construction.** Replace "Factor … into one daemon-owned service/Layer" with:

   > "`RunWatcher` is a Context service built exactly once in the daemon's `serviceContext`, provided with `provideMerge` beside `controlPlaneLayer`. `controlPlaneLayer` and the watch handler both obtain it from that context, as `contentHandler` obtains `Lake`. No path builds a second instance through a separate `Layer.build`."

   Layer memoization holds only within one build. The watch handler is currently created by a separate `Effect.provideContext(serviceContext)` step, so the text needs to rule out a second build.

2. **Order of rejections.** State it as: authenticate → bounded envelope (one `RunWatch` `Request`, ≤16 KiB, no excess properties) → HTTP producer permit → run authorization and sequence range → observer admission.
   - A request rejected by the permit therefore fails `LimitExceeded` before run authorization. That is fine, because there is a single principal, but the order should be documented.
   - Use distinct messages, for example "16 watch connections active" and "Repository observer limit reached (16)", so tests and operators can tell which limit applied.

## Should fix (optional before presentation)

- **S1.** Add one sentence on the existing ordering caveat in §2: a terminal or Waiting Snapshot may precede the remaining Events. JSONL completion is stream end.
- **S2.** Document the legacy limitation in §1: blocked legacy watchers buffer heartbeats in an unbounded queue until termination or disconnect.
- **S3.** Name the specific `/rpc/watch` envelope rejections in the proofs:
  - a two-line batch
  - `Ack`, `Interrupt` and `Eof` messages
  - other tags (`TaskRun`, `LakeDownload`)
  - excess properties
  - more than 16 KiB
  - invalid UTF-8

  Each must leave `SystemStatus.observers` unchanged.

- **S4.** Reuse one `RunWatch` Rpc value in both groups (§7).

## Required proofs

These are in addition to the draft's list. Any item the draft already has is repeated here only where it needs to be sharper.

1. The real-daemon live JSONL case from the draft, plus the R2 stalled-reader and idle case on a waiting run lasting more than 10 s.
2. **Shared count across routes.** With 8 legacy `/rpc` and 8 `/rpc/watch` observers active, the 17th observer on either route fails `LimitExceeded`, and `SystemStatus.observers` is 16.
3. **Permit exhaustion.** Separately, exhaust the HTTP producer permits with slow readers whose streams have already ended. The next request is refused with the permit message, and download capacity is unaffected.
4. **Abort.** Client abort, foreground `takeUntil`, and Ctrl-C on JSONL. Wait for **both** the observer release and the permit release, and assume no order between them.
5. **Oversize (R1).** A test-only event whose line exceeds the limit. Earlier frames arrive, then a typed `LimitExceeded` carrying its sequence, with no `RpcClientError` decode defect and no resume-loop guidance.
6. **Shutdown during an active watch.** The observer finalizer and the handler fiber finish before the `HostStore` Layer releases; no store call runs after close.
7. **Old daemon (fake, without `run.watch.stream.v1`).** `run watch`, with and without `--jsonl`, and foreground run fail `Unavailable` before any `TaskRun`/`WorkflowRun` is sent. `--background` succeeds.
8. **Resume** after the last written Event across a daemon restart; the new port is read from `daemon.json`. No Events are skipped, and duplicates are allowed only when the write outcome was uncertain.

## Accepted choices (no change requested)

- Keep `/rpc` and its legacy `RunWatch` unchanged.
- Introduce the new capability `run.watch.stream.v1`, distinct from `run.watch.v1`.
- No silent fallback and no polling.
- `connectWatch` owns its client in the caller's Scope.
- `rechunk(1)` and `streamBufferSize: 4`, with no promise beyond producer-side bounds. The probe saw about 1.1 MiB accepted by Bun and the kernel during a 6 s stall with 64 KiB writes. This is consistent with the draft's disclaimer.
- No new frame variants, flags, auto-reconnect or retention policy.
- Waiting workflows acquire no new resource Scope: the watcher only reads `HostStore`.
- Accepting the `/rpc/watch/` trailing-slash form, as content does. Which form Effect's `post("")` emits is [inference]; it is harmless either way.

## Public choices for the user

The draft already flags the first two; this review adds the third.

1. A new CLI refuses `run watch` and foreground run against a daemon lacking `run.watch.stream.v1`.
2. Non-JSONL `run watch` also requires the new capability.
3. **(R1 alternative only)** Whether to cap invocation-path length at runtime instead of, or in addition to, the typed oversize failure.

## Evidence files

All are in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/3634fd65-eba1-4084-89d1-84a7181deff9/scratchpad/watch/`, outside the checkout, and import the checkout's pinned `effect@4.0.5` through a symlinked `node_modules`.

- `frames.ts` — encoded frame sizes (§4)
- `rpc.ts` — NDJSON first-frame latency, release on `take(1)`, Bun idle timeout with and without `timeout(req, 0)` (§2, R2)
- `slow.ts` — idle reset of a backpressured stalled reader (R2)
- `legacy.ts` — unframed JSON buffering past the idle timeout (§1)
