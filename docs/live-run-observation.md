# Live run observation

The live transport uses Effect RPC over NDJSON at `/rpc/watch`. Existing `/rpc` clients retain their JSON transport. New clients require `run.watch.stream.v1`; restart an older daemon using the current binary before observing runs. Background submission remains available without this capability.

```sh
effectory workflow run <workflow-id> --input null --background
effectory run watch <run-id> --jsonl
effectory run watch <run-id> --jsonl --after-sequence 42
```

JSONL emits Snapshot, Event and Heartbeat frames while a run executes or waits. The cursor is exclusive: resume from the last Event successfully processed. A Snapshot's lastSequence may be ahead of events still being replayed. A terminal Snapshot is not the end of history; consume through stream completion. Disconnecting observation does not cancel execution. There is no automatic reconnect.

Plain `run watch` and foreground task/workflow commands show append-only progress on stderr, including when redirected. The final run remains JSON on stdout. `--json` suppresses progress and compacts that final JSON; `--jsonl` emits only machine frames and existing diagnostics. Background submissions produce no progress.

```sh
effectory run watch <run-id>                         # human progress + final JSON
effectory run watch <run-id> --after-sequence 42     # resume human display
effectory run watch <run-id> --json                  # final compact JSON only
```

Plain watch now honors `--after-sequence`, with or without `--json`. A cursor beyond recorded history fails with exit 2. Scripts combining stderr/stdout (`2>&1`) should use `--json` if they parse the result.

Human mode prints the current snapshot first, then numbered events with their original timestamps. A snapshot can be ahead of the replayed events. Once a run qualifies to stop, the display drains through that snapshot's fixed lastSequence before returning; later events are not displayed. This includes full replay when watching an already-finished run. The barrier never moves to chase a busy sibling branch. JSON mode retains immediate stopping; JSONL drains its stream.

Lines have no ANSI controls or redraw timers. Server-provided control/format characters are escaped, and each human line is capped at 2048 Unicode code points plus newline with a truncation marker. Exact human wording is not an automation interface. Use JSONL for full values within the transport limit.

A slow stderr sink applies backpressure to observation, not execution. A failed stderr write disables the human display and keeps observing; final stdout and the run-derived exit code remain available. If the stopping barrier was already captured, the observer returns immediately on that display failure. Formatter defects and RPC errors still surface.

## Foreground execution

Foreground task/workflow commands stay attached through durable sleeps and retry backoffs. They return at completion, NeedsAttention, or a Waiting snapshot with an open approval, input or signal wait. Terminal runs retain their existing success/failure exit codes. An external action or NeedsAttention returns exit 4 with inspection guidance.

Running includes task permit queues, Layer acquisition, executing handlers and resource cleanup, including after timers or retry backoffs wake. Foreground commands stay attached while that work drains, even with an open signal or sibling approval. Stop fences and manual-recovery holds retain priority.

Exit 4 does not prove a signal is being awaited. Signals can be registered before they are awaited, so a registered signal can still cause exit 4 during a durable sleep with no invocation work. Use background admission followed by JSONL watch when you want to keep observing independently of that rule. Human-mode draining extends the race window by the backlog and stderr backpressure: a wait can settle before the final lookup, so exit 4 can accompany a run that has returned to Running.

After successful admission, observation failures preserve the accepted run ID. Inspect that run rather than resubmitting. Remote disconnects exit 3 and show recovery guidance; local Ctrl-C exits 130. Typed limits exit 5. If admission itself is uncertain, reuse the submission's request key.

## Bounds and recovery

The daemon shares 16 observers across legacy and live routes. The live endpoint also allows 16 concurrent response producers; downloads have a separate pool. Stalled readers can hold capacity until disconnect or shutdown. The route disables the idle timeout. These limits bound producers and their queues, not bytes already buffered by the socket. The unchanged legacy JSON transport may retain an observer after client abort until server scope shutdown; the framed route releases it on disconnect.

Each encoded line is limited to 2,097,152 UTF-16 code units excluding its newline. This is not a 2 MiB byte limit. The conservative stdout bound is 6,291,457 UTF-8 bytes including newline. Deeply nested workflow paths can exceed the limit.

An oversized event produces a typed LimitExceeded naming the sequence. Earlier frames are delivered; the event remains stored. The daemon supplies a command to intentionally skip it:

```sh
effectory run get <run-id>
effectory run watch <run-id> --jsonl --after-sequence <oversized-event-sequence>
```

Skipping loses that event from your observation. JSONL errors also report the last Event written. This release has no CLI or RPC reader for the oversized event: `run events` has a smaller page budget. Backups still preserve the stored row. Human mode drains history and can encounter an oversized tail event after a terminal snapshot, exiting 5 without final stdout even when the workflow succeeded. `--json` can stop at that snapshot instead. Plain watch can explicitly skip the event using its now-honored cursor, just as JSONL can. Scripts must use `run get` to inspect the actual outcome after observation fails.

## Effect clients

`WatchPlane` is exported from `@effectory/runtime/watch-rpc`. The platform client's `connectWatch(repository)` returns a scoped client after validating daemon identity and capability. Its RunWatch method uses the existing request and frame schemas. Consume the returned Stream within the connection Scope; no new task service or workflow scope is needed.

The approved design and verification requirements are recorded in [the transport contract](live-run-watch-api-draft.md).

Human display behavior and review history: [approved console contract](live-console-api-draft.md).
