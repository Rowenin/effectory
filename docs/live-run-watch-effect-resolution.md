# Live run observation — Effect review resolution

Status: **historical resolution input; not user-approved**. The merged revision-2 proposal is in [the main draft](live-run-watch-api-draft.md); its line units and recovery behavior supersede earlier alternatives here. This delta applies the original Effect review's R1–R3 and records one source-backed objection to its proposed recovery guidance. The main draft and consumer-resolution delta remain frozen for the ongoing consumer re-check. Merge these resolutions only after that review completes. No production changes are authorized.

## R1: measured line units and typed oversized-event failure

Effect 4.0.5 `RpcSerialization.makeNdjson` compares decoded JavaScript string lengths. The proposed parser bound is **2,097,152 UTF-16 code units per NDJSON line, excluding its terminating newline**, not 2 MiB of bytes. One stdout JSONL line contains one logical frame and is also bounded to 2,097,152 UTF-16 code units excluding newline. UTF-8 encoding can require up to three bytes per code unit: a conservative byte ceiling is 6,291,457 bytes including the newline. Do not reuse "2 MiB per line" as a byte claim. The 16 KiB request-body limit remains a separate UTF-8 byte limit.

The review measured encoded Chunk lines of about 5 Ki units for large Snapshots, 8.4 Ki for telemetry, 49 Ki for escaped cancellation reasons and 26 Ki for one workflow's node-path event. These are measured fixtures, not universal schema bounds. Deep child-workflow chains can exceed the proposed line cap. This slice does not add an invocation-path length cap or change task/workflow authoring.

Before transmitting a frame whose encoded RPC Chunk line would exceed the cap, fail with typed OperationError/LimitExceeded. Include the run ID and offending Event sequence in its bounded message; do not truncate, automatically skip or reshape the event. Deliver preceding frames normally. The guard must account for the real Schema JSON encoding, RPC envelope and request ID, not merely JSON.stringify(frame). Rechunk before per-frame guarding and at the RPC boundary so a later rejected frame cannot discard preceding frames from a shared upstream chunk. Bound generated failure/defect responses too; no untyped parser error may replace the deliberate guard failure.

### Source objection to the suggested `run events` fallback

The original review suggests `run events <id> --after <sequence-1>` to retrieve the offending event. There are two problems:

- The actual CLI flag is `--after-sequence`, not `--after` (`main.ts` run events command).
- `inspection.ts:eventPage` caps the entire page at **1,048,576 UTF-8 bytes** and throws LimitExceeded if its first event alone exceeds that budget. An event over the watch cap will also exceed this smaller page cap. Therefore the proposed fallback cannot retrieve it.

Recommend an honest bounded failure, without widening event-page APIs in this slice:

> `Event <sequence> exceeds the live watch limit. Earlier events were delivered; this event remains stored. Inspect run state with effectory run get <run-id>. The event also exceeds the run events page limit. To intentionally skip this event and continue observing, use effectory run watch <run-id> --jsonl --after-sequence <sequence>.`

Do not print the ordinary reconnect line using the previous cursor, which would loop on the same event. The operator's explicit resume at the offending sequence skips exactly that event relative to a fully delivered earlier cursor; if transport failed before earlier frames reached stdout, those earlier undelivered events also need replay first. Do not promise automatic lossless recovery through a frame the route intentionally rejects. No current CLI/RPC content reader is promised for the oversized event; a future export or path-bound API needs separate user discussion. Retained history and workflow execution are unaffected.

The alternative is an authoring-visible invocation-path bound, as the review noted, or a new oversized-event export API. Neither is silently included. The user must approve the typed failure/manual-skip behavior in the final presentation.

For an oversized non-Event frame, return a bounded message naming its frame kind and run ID and direct the operator to run get. Do not invent an event sequence. Snapshot and heartbeat fixtures should fit comfortably; corrupted persisted state is not evidence for a schema guarantee.

## R2: idle and delivery semantics

Set `bunServer.timeout(originalRequest, 0)` on the watch route. Cancellation, peer disconnect and daemon shutdown own cleanup. A stalled active producer can hold observer/producer capacity; a completed response buffered in Bun/kernel may have already released both. Heartbeats cannot substitute for disabling the timeout under backpressure. No new idle setting is added.

JSONL completion is successful stream completion, not the first terminal Snapshot: a Snapshot may precede the remaining event batches. Keep legacy `/rpc` unchanged, while documenting that its unframed queue accumulates heartbeat frames for as long as an observer remains attached. Sixteen observer slots bound the count of streams, not their retained heartbeat memory over time.

## R3: construction and rejection order

Create RunWatcher exactly once in the daemon's serviceContext. Its ordinary Context service is supplied alongside the control-plane Layer using the same Layer build. Both the legacy handler and new watch handler obtain that instance from serviceContext. Do not rely on memoization across separate Layer.build calls. SystemStatus/doctor observe the same instance.

Check in this order: authentication → bounded validated single-request envelope → HTTP producer permit → run authorization and sequence validation → shared observer admission. Distinguish `16 watch connections active` from `Repository observer limit reached (16)`. Producer admission can precede per-run authorization, as it does not reveal another principal's run. No new public service export is needed for the internal watcher service.

Declare the RunWatch Rpc once and include it in both groups if supported by pinned Effect; otherwise share its schema inputs explicitly without changing wire shape. Test 8 old + 8 new observers and refusal on either route, independently exhaust watch producer permits, and await both finalizers after cancellation without assuming their order. Preserve the separate download pool.

## Narrow re-check request

The original Effect reviewer did not read the consumer findings. Read the consumer-resolution delta's R1 too: it proposes using a scoped child fiber plus Fiber.await to distinguish remote stream interruption from local parent SIGINT. Prove this against pinned Effect without changing CLI production code. Local Ctrl-C should remain 130; daemon stop is Unavailable/3 with resume guidance. Typed capacity failures remain their existing code, with accepted-run guidance after admission.

Re-check only:

1. Correctness of the units and encoded-envelope guard, including no dropped preceding frames.
2. The source objection and whether typed failure plus explicitly lossy manual skip is the smallest truthful current-API remedy.
3. Feasibility of the remote/local interruption distinction with ordinary Effect Scope/fibers.

Write only `docs/live-run-watch-review-effect-round2.md`. No production/draft edits, commits or subagents. Scratch probes outside the checkout are welcome. Review approval permits presentation only; user approval is still required. Consumer foreground policy is being reviewed separately.
