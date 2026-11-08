# Human-readable live execution — proposal

Status: **revision 2; user-approved, implemented and verified**. See the dated verification in [implementation status](implementation-status.md#human-readable-live-console) and the current [operator documentation](live-run-observation.md). This document preserves the approved design and its pre-implementation source analysis. Examples below illustrate the contract; executable tests supply the implementation evidence.

## Gap and source evidence

Swamp feeds workflow events to consumeStream in `vendor/swamp/src/cli/commands/workflow_run.ts` (around lines 736–776), with a console renderer in `vendor/swamp/src/presentation/renderers/workflow_run.ts`. Its renderer includes task output, progress, wait hints and nested work. Swamp human mode writes to stdout instead of JSON and uses repeating heartbeat timers and per-step maps. This proposal deliberately keeps final JSON on stdout and human progress on stderr, without timers or per-node maps. Effectory now streams JSONL, but plain watch and foreground execution still print only the final run JSON. This slice adds a simpler append-only display; it does not claim parity with Swamp's interactive layout, quiet/verbose options, reports or JUnit output.

Current source: `packages/cli/src/main.ts` print always writes JSON to stdout (indented unless --json); observe uses the streaming client but discards frames until its stop condition. `observation.ts` owns the existing foreground stop rule and interruption classification. `history-protocol.ts` has Snapshot/Event/Heartbeat frames; Event payload is Schema.Json, not a discriminated schema per tag. WaitOpened contains nodeId and waitId, but not kind/prompt. There is no general AttemptSucceeded event. Do not invent lifecycle events or infer successful attempts from silence.

## Recommended public behavior

No new command, flag, RPC, authoring service, exported renderer or event schema.

- Foreground `task run` and `workflow run`, and plain `run watch`, show live append-only human text on stderr by default, whether attached to a terminal or redirected. The final run JSON on stdout stays unchanged.
- `--json` suppresses this human progress; it still prints the final compact JSON. Existing diagnostic errors and exit-4 action hints remain on stderr.
- `run watch --jsonl` keeps its existing exact stdout frame stream and diagnostics. It emits no human progress, even without --json. If both JSON flags are passed, existing JSONL behavior wins.
- Background submissions remain one durable receipt, with no observer/display.
- No ANSI controls, cursor motion, color, spinner or periodic display timer. Quiet Heartbeats are consumed but not printed. The first Snapshot arrives promptly, so there is an initial indication of the observed run.

This deliberately adds stderr output for existing non-JSON commands, including redirected stderr. Consumers that need silence during observation use --json. This compatibility change needs user approval. In particular, successful `cmd 2>&1 | jq` and `out=$(cmd 2>&1)` will now include progress; use --json or stop merging stderr into stdout. An alternative is TTY-only progress, but it hides useful progress in CI and requires separate behavior to test; do not adopt that silently.

Proposed example (stderr):

```text
Run abc — workflow release — snapshot Running at #4
#1 2026-11-05T16:00:00.000Z RunAccepted
#2 2026-11-05T16:00:00.010Z RunStatus Running
#3 2026-11-05T16:00:00.020Z AttemptStarted node=[...] attempt=1
#4 2026-11-05T16:00:00.100Z Log Info node=[...] "Fetching release"
#5 2026-11-05T16:00:00.200Z RetryScheduled node=[...] nextAttempt=2 deadline=2026-11-05T16:00:01.200Z
#6 2026-11-05T16:00:01.300Z Log Info node=[...] "Release fetched"
#7 2026-11-05T16:00:01.400Z RunStatus Succeeded
```

A Snapshot describes current state, while numbered events can be historical replay. Label the first line explicitly as a snapshot with its sequence; event timestamps and sequence numbers show their original order. Do not relabel replayed RunStatus Running as current state. Print a new snapshot line only when its status differs from the last printed snapshot. The daemon sends a Snapshot after every nonempty page of at most 16 events, so a current status can precede the tail of recorded logs. No per-node tracking maps or history accumulation are needed.

Use the existing foreground eligibility rule (terminal/NeedsAttention or Waiting with an open outside action), but while progress is enabled drain a **fixed stop barrier** before returning. Track the last Event successfully displayed, initially the requested cursor. When the first Snapshot qualifies to stop, capture its lastSequence once. Keep rendering through that sequence, then return and perform the existing final RunGet/exit mapping. Do not move the barrier on later snapshots: unrelated branches can keep producing events while an outside action is open. Events after that barrier are not displayed. Once captured, do not re-evaluate stop eligibility or call WaitList again. If a wait settles while draining, final RunGet can report a newer state, as in the existing observation race; this is not an atomic blocked-state guarantee. Draining adds the backlog and stderr backpressure to the race window; a paused reader can extend it indefinitely. If the wait settles in that interval, exit 4 can accompany a final RunGet showing Running.

Plain watch of an already-terminal run therefore replays through its initial terminal snapshot's lastSequence before printing the final Run. A 40-event burst must show its last log and final status event, rather than stopping after the first 16-event page. The fixed barrier may stop on an Event frame, not necessarily a Snapshot. Display a triggering snapshot before evaluating its stop eligibility.

When progress is suppressed (--json), preserve the existing immediate eligibility rule. JSONL still drains its complete stream. Foreground submissions start at cursor 0. **Honor the existing plain run watch --after-sequence flag** by passing it to RunWatch and initializing displayedThrough with it, both with and without --json; this fixes a previously ignored flag and requires user approval. A value beyond the recorded history now fails InvalidInput/exit 2 instead of being ignored, in both modes. No server/capability/schema changes or new flags. No status-projection fix or actually-awaited marker.

## Event presentation and boundary

Render one bounded line per Event. Always include the event's sequence, stored timestamp and tag. For known payloads, add useful fields only:

- RunAccepted: tag only (run identity is in the snapshot).
- RunStatus: status when a string.
- AttemptStarted: nodeId and attempt.
- Log: level, nodeId, JSON-formatted message, plus a non-null error value for Error/Fatal under the same line cap. No annotations dump.
- Progress: nodeId, message, optional finite completed and total counts (`Task.Progress` in task.ts; interpreter.ts adds nodeId and attempt). Show counts as recorded; do not infer percentages or task completion.
- WaitOpened/WaitSettled: WaitOpened has waitId and nodeId; WaitSettled has waitId and status (host-store.ts), without a nodeId. Say “wait opened”, not “workflow blocked”; do not fabricate its kind or prompt. Existing exit-4 inspection guidance remains authoritative.
- ArtifactPublished: artifactId and version from the stored publication metadata (lake.ts inserts that metadata as the event payload). No content dump. Always label the event sequence, not the payload's lake sequence; any node label comes from invocationPath.
- RetryScheduled: nodeId, next attempt and valid deadline as ISO.
- NeedsAttention: nodeId.
- CancellationRequested: actor and reason.
- FinalizationStalled: message.
- DeadlineStarted: name.
- TelemetryTruncated: indicate that stored telemetry was truncated.
- Unknown or malformed known payload: tag-only line; never crash observation because an optional display field cannot be decoded.

Pin these mappings in formatter tests. Decode each optional display field independently with Schema.decodeUnknownOption; reject malformed counts with Schema.Finite without dropping the message or other valid fields. A non-object payload gives a tag-only line. This is presentation decoding, not a change to the stored/wire Event contract.

After JSON formatting, escape the Unicode code-point class `[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]` in every server/user-supplied string (including event tags and IDs), so one event stays one physical line and cannot emit terminal control sequences. Limit each human line to 2048 Unicode code points plus newline after escaping, including a visible truncation suffix when needed; do not split surrogate pairs or escape tokens. This also escapes ZWJ in emoji sequences. Large node paths and messages are intentionally truncated for display, while JSONL preserves the complete frame within its transport bound. The transport's oversized-event typed error/skip behavior stays unchanged, but human-mode draining can newly reach such an event after an eligible snapshot. **Proposed choice for user approval: retain exit 5 if it is encountered**, including for a run that already succeeded; final stdout is then not printed. --json can stop at the eligible snapshot instead, and run get returns the actual outcome. The explicit skip command (or the now-honored plain after-sequence cursor) can continue past the oversized event. This is a failure of history observation, not a failed workflow. The alternative suggested by the Effect reviewer is to end an oversized tail drain with a warning and still print the final result; that is not the selected recommendation. Keeping exit 5 is the consumer review's documented option and the Effect review's allowed alternative. Do not parse an OperationError message or suppress other stream failures to infer an oversized Event; no structured error discriminator is added.

The example is illustrative: actual node paths are currently JSON invocation paths, not necessarily concise task names. Do not make additional catalog or WaitGet requests per event just to prettify them.

## Effect ownership and output failure

Implement a private pure formatter plus a small per-observation reducer tracking the last printed snapshot status, displayedThrough, one optional fixed barrier and whether the display is enabled. Consume through the existing scoped stream using sequential Effect writes, before the eligibility/barrier check so the triggering snapshot can be displayed. The RPC Scope and consumeObservation remain responsible for cancellation. No detached writer fibers, global mutable display state, new Layer or extra observer slot.

Reuse the JSONL writer's callback/backpressure approach for stderr, but keep formatting separate. Do not block the JS thread or queue unbounded lines. A slow stderr sink slows observation and holds its observer slot; it does not stop daemon execution. Local Ctrl-C still releases observation and exits 130. Remote failures retain the existing exit3/5 behavior and hints.

**Recommended sink policy, requiring user approval:** on the first failed progress write, disable only the human display and continue observing. Final stdout and run-derived exit code remain available. If a barrier has already been captured, stop on the same element as the failed display write, without another WaitList query; eligibility was already established. Otherwise use the existing immediate stop rule after degradation. Slow writes still apply backpressure; only a write error disables display. Do not retry callback writes or use that writer for hints after degradation; existing Console.error diagnostics remain. Never swallow formatter defects, RPC errors or parent interruption. This differs from round-1's hard-failure proposal and the Effect review's preference; consumer review recommends degradation because stderr is decoration and stdout is the result contract. JSONL stdout failure behavior remains unchanged.

Format outside the guarded write so formatter failures remain defects. The private text writer handles only output.write/callback errors and maps them to a private ProgressSinkError; degradation catches only that tag. Its failed write may leave one once-error listener for the pending Writable error event; with no subsequent writes after degradation this remains bounded. Reuse this private text writer beneath writeJsonLine, preserving JSONL bytes. Recovery hints for genuine observation failures remain on Console.error, best-effort with catchCause so a failing or defective hint cannot replace the original error. No new Console service or exported writer. Failure hints use the actual last Event displayed, or the requested cursor when none was displayed, rather than always suggesting sequence 0. In --json mode track the last Event consumed without claiming it was printed. Oversized-event hints retain their explicit skip guidance and do not suggest a resume loop.

No machine-readable stability promise for exact human wording beyond the command/mode/stream/exit contracts. JSON/JSONL remain the automation interfaces.

## Proofs before completion

- Real CLI: while approval is open, non-JSON foreground/plain watch displays stderr lines before resolution; stdout is still untouched until the existing final Run result. Foreground retains exit4 semantics.
- Redirected stderr behaves the same; --json and --jsonl suppress human lines; background admission starts no observer. Existing stdout snapshots remain byte-compatible.
- Real CLI fast task with 40+ logs: final distinctive log and RunStatus appear. Repeat with a wait after a burst, an initially terminal run, a nonzero plain cursor and --json suppression. A continuously publishing sibling must not move the captured stop barrier. Wait settlement during draining uses final RunGet without claiming an atomic guarantee.
- Formatter fixtures for every supported tag, unknown tags and malformed payloads. No invented successful-attempt or wait-kind claims.
- Escape/control/bidi handling review, Unicode truncation boundary, line cap, huge node paths, multiline log messages and non-string JSON messages.
- No retained history or per-node maps. Slow-writer backpressure, broken stderr disables progress while final stdout/exit remain correct; scoped interruption releases observers; concurrent observations do not share state.
- Existing remote/local interruption, typed oversized-frame skip and accepted-run hints remain tested. Add a terminal snapshot followed by an oversized tail event: human mode exits 5 without final stdout; --json can return the final result. Formatter defects must not disable progress silently. Sink failure after capturing the barrier stops without another WaitList call, and a nonzero cursor appears correctly in failure guidance.
- Full required typecheck, formatting/lint and test suite.

## Reviewer request

Review this proposal only. Verify field shapes and the source claims, assess whether automatic stderr progress is the most coherent consumer behavior, and check Effect Stream/Scope/backpressure ownership. Propose the smallest corrections, distinguish probes from implementation tests, and identify public decisions for the user. No production changes and no implementation authorization.
