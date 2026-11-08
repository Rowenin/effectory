# Live run observation — proposed transport correction

Status: **revision 2; user-approved and implemented**. Consumer foreground and recovery corrections are incorporated. The [focused Effect review](live-run-watch-review-effect-round2.md) approves the current text and records standalone Effect/Bun feasibility probes, not tests of an Effectory implementation. Implementation verification is recorded in [implementation status](implementation-status.md); the historical probes remain separate from those tests. Binary artifacts are a separate approved implementation. This slice fixes the confirmed live-observation transport gap without changing workflow/task authoring or JSONL frame shapes.

## Problem and Swamp comparison

Swamp consumes workflow execution events as a stream: `vendor/swamp/src/cli/commands/workflow_run.ts` creates its workflowRun event stream around line 736 and passes it to consumeStream around line 776. Swamp renders those events live during foreground execution. Its history-log stream reads recorded history, not a live follow mode. This slice makes Effectory JSONL watch live; a live human-readable foreground/watch renderer remains out of scope.

Effectory already defines RunWatch as a streaming Effect RPC and has Snapshot/Event/Heartbeat schemas and replay by sequence. However, `/rpc` uses `RpcSerialization.layerJson`, which collects the stream before sending a response. The existing live CLI probe received no snapshot while a workflow waited for approval. `run watch --jsonl` cannot currently show progress before termination; ordinary foreground task/workflow execution can also remain blocked at a durable wait, because observe waits on the same transport. See the [research evidence](runtime-research-queue.md).

## Proposed public surface

Keep existing commands and flags:

```sh
effectory run watch <run-id> --jsonl
effectory run watch <run-id> --jsonl --after-sequence 42
effectory workflow run <workflow-id> --input null
```

JSONL emits its initial Snapshot promptly, followed by recorded Events and subsequent Snapshots while the run remains active or waiting. Heartbeats retain the existing five-second idle cadence. `--after-sequence` remains exclusive and concerns Event.sequence. Snapshot.lastSequence is not an acknowledgement that those Events have been consumed. CLI reconnect guidance uses the last Event successfully written to stdout, or the requested afterSequence (default 0) if none was written. A terminal or Waiting Snapshot can precede remaining event batches; successful stream completion, not that Snapshot, marks JSONL completion. No automatic reconnect, new flags, frame variants or task-context service are added.

The non-JSONL watch command continues to print the final Run after termination; it does not become a live pretty renderer. Background admission remains independent of observation.

**Recommended foreground rule, requiring user approval:** stay attached through timer/retry-only suspension. Return at terminal status, at NeedsAttention, or at a Waiting Snapshot when `WaitList({ runId, status: "Open", limit: 1 })` finds an open approval, input or signal wait. Evaluate every Waiting Snapshot, including the initial one; do not check only a transition into Waiting. NeedsAttention requires no wait query. After deciding to return, read RunGet: terminal status determines the existing 0/1 result, otherwise exit 4 and print a run-waits/run-get hint. This is a best-effort observation of changing state, not an atomic guarantee that the interaction is still open when the command exits. It avoids reporting exit 4 if RunGet already shows a terminal result.

**Exit 4 describes an available outside action or NeedsAttention; it does not claim all runnable work is blocked.** SignalRegistration opens an endpoint before AwaitSignal. Also, current status projection leaves a run Waiting after a timer/retry wakes while later tasks execute. Thus `sleep → SignalRegistration → task → AwaitSignal` can return exit 4 while the task is running. Pair registration and awaiting with a plain signal node where appropriate, or use `--background` plus `run watch` to stay attached independently of this return rule. Fixing stale Waiting projections and exposing actually-awaited waits is a separately reviewed follow-up. The alternate return-at-every-Waiting policy would also end foreground observation at ordinary sleeps/retries and is not recommended.

Compared with today's buffered behavior, foreground runs will start returning before terminal completion when this interaction-availability rule matches. No new frames, statuses or flags are introduced.

Add a `WatchPlane` RPC group exported from `@effectory/runtime/watch-rpc` with the existing `RunWatch({runId, afterSequence?})` method, RunWatchRequest, RunWatchFrame and OperationError. Serve it at authenticated `POST /rpc/watch` (also accept `/rpc/watch/`, matching Effect HTTP client behavior), using Effect NDJSON. Keep `/rpc` and its legacy RunWatch registration unchanged for old clients; their buffering remains a legacy transport limitation. Keep `/rpc/content` dedicated to byte downloads.

Add capability `run.watch.stream.v1`, distinct from today's `run.watch.v1`, so an old daemon cannot claim the corrected transport. Add `connectWatch(repository)` alongside connectContent in the platform client module, returning a scoped Effect RPC client. It checks the same loopback origin, credentials, repository/protocol identity, daemon instance and capability before connecting to the watch route. The helper's Scope owns the client connection; reusable observers compose ordinary Effect Streams.

For custom clients:

```ts
const consume = Effect.scoped(
  Effect.gen(function* () {
    const client = yield* connectWatch(repository);
    yield* client
      .RunWatch({ runId, afterSequence: 42 })
      .pipe(Stream.runForEach(handleFrame));
  })
);
```

This fragment describes proposed transport usage, not implementation/typecheck evidence. Existing RunWatch payload and frame schemas remain the API boundary.

## Compatibility and admission

A new CLI requires run.watch.stream.v1 for run watch and foreground task/workflow run. Missing capability fails Unavailable/exit 3: `The running daemon does not support run.watch.stream.v1. Restart it with this binary (effectory daemon stop, then effectory daemon start).` For submission commands add `To submit without observing, use --background.` For run watch instead point to `run get <run-id>`.

Parse input, then preflight capability and instance using one SystemStatus read shared with tag checks where applicable, **before TaskRun/WorkflowRun**. This does not reserve an observer slot. Background admission and unrelated commands retain their existing compatibility. No silent buffered fallback or polling is added. This compatibility choice requires user approval.

After a known successful admission, any observation failure prints the accepted run ID and run-get/watch guidance to stderr, including typed refusal, transport loss, shutdown, draining and final RunGet failure. Never suggest resubmission in that case. Uncertain admission retains request-key retry guidance. Remote interruption maps to Unavailable/exit 3; typed LimitExceeded remains exit 5. Local Ctrl-C/SIGINT remains exit 130 without a misleading remote-disconnection hint. JSONL remote-ended cases show the last-written-event resume cursor described above, except the deliberate oversized-event failure below, whose remediation must not loop on the same event.

For typed LimitExceeded, the accepted-run hint ends with `Inspect with run get <run-id>.` and adds no generic reattach command. The daemon's message supplies any specific recovery command; the CLI does not parse message text to distinguish capacity limits from oversized frames. An oversized-event exit 5 cannot be resolved by resuming from the same cursor. A foreground observer that reaches that event exits 5 independently of the run's eventual outcome; scripts must read the outcome with `run get`.

Consume the stream in a scoped child fiber and inspect its Exit with Fiber.await, preserving parent-local SIGINT separately from a remote interruption of the child. Standalone pinned Effect/Bun probes verified this distinction; Fiber.join would erase it. Preserve typed failures unchanged and keep final RunGet outside that child. Tests against the real daemon and CLI remain required. A simultaneous local interrupt and remote failure can report either cause.

## Ownership and bounds

Construct a RunWatcher Context service exactly once in the daemon's serviceContext, alongside the control-plane Layer in the same build. Both RPC handlers read that instance; no separate Layer.build constructs another watcher. SystemStatus/doctor report its shared count. Reuse one RunWatch Rpc declaration across groups if supported, otherwise share the exact schemas explicitly. Waiting durable workflows acquire no new resource Scope: the live observer owns its resources.

The watcher has one global 16-observer limit across both routes. The watch endpoint separately uses 16 HTTP request-Scope producer permits, with server streamBufferSize 4. Downloads retain their four-producer pool. These bounds do not cover bytes already buffered by Bun/kernel. On abort, producer-permit release and observer finalization need not be atomic; await both in tests. A stalled active reader can hold observer/producer capacity until disconnect or shutdown; a completed socket-buffered response may have released them already.

Rejection order: authentication → bounded validated envelope → producer permit → run authorization and sequence validation → shared observer admission. Use distinct messages `16 watch connections active` and `Repository observer limit reached (16)`. Accept one RunWatch Request envelope of at most 16 KiB UTF-8 bytes before the RPC adapter reads it. Reject batches, other tags, Ack/Interrupt/Eof messages, excess properties and invalid UTF-8 without opening an observer. Set `bunServer.timeout(originalRequest, 0)` for watch connections. Heartbeats do not prevent timeout under backpressure; no public idle-timeout setting is added.

Legacy `/rpc` stays unchanged. Its unframed queue buffers heartbeats until completion/disconnect; limiting observer count does not bound that accumulation over time.

### Line limits and oversized events

Pinned Effect's maxBufferSize counts **UTF-16 code units**, not bytes. Set the watch parser bound to 2,097,152 units per encoded NDJSON line excluding its newline. Each stdout JSONL line is one frame and has the same unit ceiling; a conservative UTF-8 bound is 6,291,457 bytes including newline. Do not advertise this as a 2 MiB byte limit. Requests keep their independent 16 KiB byte cap.

Reviewer probes measured roughly 5 Ki units for large Snapshots, 8.4 Ki for telemetry, 49 Ki for escaped cancellation reasons and 26 Ki for single-workflow node-path events. These are fixture measurements, not universal maxima: deep child-workflow paths can exceed the cap. This slice adds no authoring path-length limit.

Guard the real Schema-encoded Chunk line, including envelope/request ID, before emission. Rechunk before per-frame guarding and at the RPC boundary so a rejected frame does not discard preceding frames in an upstream batch. An oversized Event fails with bounded typed OperationError/LimitExceeded naming its run ID and sequence. Earlier frames are delivered, nothing is truncated or automatically skipped, and stored history is unchanged. Keep generated error/defect lines bounded too. An oversized non-Event frame names its kind without inventing a sequence.

**Proposed recovery behavior requiring user approval:** do not suggest replay from the same previous cursor or claim run events can retrieve this event. `inspection.ts:eventPage` has a smaller 1,048,576-byte page cap and rejects an oversized first event. The daemon authors the complete bounded OperationError.message, including the run ID, sequence and command; the CLI prints it unchanged without parsing it:

```text
Event <N> of run <id> exceeds the live watch limit and remains stored. It also exceeds the run events page limit; this release has no CLI or RPC reader for it. Inspect run state with run get <id>. To intentionally skip it and continue, use run watch <id> --jsonl --after-sequence <N>.
```

JSONL also prints `Last event written: <L>.`, using the last Event successfully written or the requested starting cursor if none was written. With ordered delivery of preceding frames, L is N−1. The explicit skip loses event N. Foreground and plain watch write no events; consumers needing earlier events can replay with `run watch <id> --jsonl --after-sequence <start>`, which delivers those events and then fails again at N. Do not suggest run events for that replay: some events that fit the watch limit still exceed its page limit. Oversized non-Event failures have no skip command or invented sequence.

**User decision D1 — recommend accepting this limitation in this slice:** plain run watch and foreground observation replay from sequence 0 and fail if they reach an oversized event. They may stop sooner at a terminal snapshot, so reattaching after completion does not necessarily encounter it. Plain watch currently ignores its parsed after-sequence flag; only suggest the skip with `--jsonl`. Users can inspect outcomes with run get and explicitly skip through JSONL. Starting plain watch at the current last sequence is a possible separate follow-up, and would still encounter newly produced oversized events. No existing CLI/RPC reader is promised for the oversized event in this slice. A new export API or authoring-visible path bound would need separate design and user approval.

## Acceptance evidence required

- Real daemon and CLI: submit greeting in background, wait for its approval, receive an initial Snapshot and a new intermediate Event through JSONL **before** answering approval; then finish and receive terminal state.
- Foreground: timer only; retry backoff only; sleep → task → approval; signal registration before and after sleep; plain signal; input; NeedsAttention; and a wait settling between WaitList and final RunGet. Timer/retry-only stays attached, and matching external interactions return exit 4 with the documented caveat/hint.
- Remote daemon stop during foreground and JSONL observation exits 3 with accepted-run/resume guidance; local SIGINT exits 130. Capacity failure after admission retains the run ID and never recommends resubmission.
- A fresh CLI against a fake old daemon refuses observation, and foreground submission sends no TaskRun/WorkflowRun. Background submission still works.
- Real sockets: eight legacy plus eight new observers, typed 17th refusal on either route, independently exhausted producer permits, a reader stalled over ten seconds, release of both resources after cancellation/shutdown and rechunking. Separate download capacities remain unaffected.
- Measured frame fixtures and an oversized event: earlier frames arrive, then typed LimitExceeded with sequence and explicit skip guidance, never an untyped decode/resume loop. Test UTF-16 versus UTF-8 bounds, real envelope size, bounded failures, and the existing run-events page limitation. Malformed envelopes leave observer count unchanged.
- Oversized-event guidance: last JSONL Event written is N−1; daemon message is printed unchanged; plain watch exits 5 with run-get and explicit JSONL-skip guidance, never a generic plain-watch reattach hint. Foreground failures retain the accepted run ID.
- Resume after last delivered Event across disconnect and daemon restart, without skipped events; no full-response buffering. Consumers still handle possible replay if output delivery is uncertain.
- Enclosing daemon resources release after observer finalizers; scope ownership is explicit in implementation tests, not inferred only from wrappers.

## Reviewer task

Critique only this proposal, from Effect ownership and consumer compatibility perspectives respectively. Verify source claims, especially foreground waiting, shared observer counts, maximum event size and error behavior. Use pinned Effect 4.0.5. Write separate review files; change no production code or this draft. Distinguish code inspection, scratch probes and untested implementation claims. Request the smallest corrections and identify any public choices needing the user. Approval is for presentation only.
