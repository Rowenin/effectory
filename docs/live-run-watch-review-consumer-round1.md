# Live run observation — consumer review, round 1

Reviewer: Claude consumer review, from the developer and operator point of view. Scope: `docs/live-run-watch-api-draft.md` as written. The draft was frozen during this review; I changed no production code. A separate Claude Effect review owns Layer and Scope ownership, the parser and producer bounds, and the proof of the frame-size limit. I comment on those only where a consumer would see the result.

**Reviewer approval only permits presentation. It is not user approval and does not authorize implementation.**

Evidence labels used below:

- **[code]**: read from source at the stated location.
- **[probe]**: a scratch probe I ran outside the checkout against the current sources and Effect 4.0.5.
- **[inference]**: my reasoning, not verified by running anything.

## Verdict: NOT ready for presentation — one blocker (B1) plus four small text corrections (R1–R4)

The overall direction is sound and easy to explain:

- keep the commands, flags and frames;
- add a separate streaming route;
- leave old clients on `/rpc`;
- refuse an old daemon before any mutation.

The draft's main diagnosis is correct. I reproduced it: foreground `workflow run` of the greeting example was still running after 25 seconds at its approval wait.

However, fixing the transport makes a currently unreachable code path live. The draft does not notice that this path also fires on durable timers and retry backoff (B1). This is a public behavior choice that the user must make before presentation.

## Blocker

### B1. Foreground run would exit 4 ("Waiting") at every durable sleep and retry backoff

Facts:

- **[code]** `packages/cli/src/main.ts:156-176`: `observe(..., untilWaiting=true)` stops at the first Snapshot whose status is `Waiting` or `NeedsAttention`, prints it and exits 4.
- **[code]** `packages/platform-bun/src/interpreter.ts:336-341` (retry backoff after `RetryScheduled`) and `:927-929` (`graph.sleep`) both use `DurableClock.sleep({ inMemoryThreshold: 0 })`. Every timer therefore suspends the engine.
- **[code]** `packages/platform-bun/src/runner.ts:97-100` projects any `Suspended` engine result as `Waiting`. `Retrying` exists in `RunStatus` but nothing projects it (only `lake.ts:244` and `host-store.ts:974` read it).
- **[probe]** A workflow with `graph.sleep("nap", "4 seconds")` and one task, submitted with `--background`, reported `Waiting` from about 0.6 s until it reached `Succeeded` at about 4.5 s.
  - Script: `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/bf6a34c4-1ca4-435b-911d-8c5ab5d6b2b4/scratchpad/sleep-probe.mts`
  - App: `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/bf6a34c4-1ca4-435b-911d-8c5ab5d6b2b4/scratchpad/sleep-app.ts`

**[inference]** Today, buffering hides this, because foreground run waits for the terminal state. Once Snapshots stream, any foreground workflow with a sleep step, and any task or workflow whose retry policy schedules a backoff, will print a non-terminal run and exit 4. The draft states the opposite: "Foreground workflow/task run continues to return at Waiting/NeedsAttention … as its existing code intends", and its acceptance list tests only approval. For a CI script, `workflow run x && deploy` would fail on a five-second retry delay.

The documentation is ambiguous:

- `docs/daemon-rpc.md:73` and `docs/cli-server-api.md:161` say "until terminal or **fully** Waiting" and point at `run waits`, which implies human or external interactions.
- The code stops on any `Waiting`.

Swamp's in-process stream stops at `approval_requested` or `suspended` for signals and child waits (`vendor/swamp/src/libswamp/workflows/run.ts:149, 275-290`), not at its own timers. **[inference from the event names; I did not trace Swamp's sleep handling.]**

User decision needed. Present it in the draft as an explicit choice:

1. **(Recommended)** Foreground observation stays attached through timer and retry suspension. It returns exit 4 only for `NeedsAttention` or for `Waiting` with at least one open host wait (approval, input or signal). Implement this with the existing API: on a `Waiting` Snapshot, query the existing wait listing (`WaitListRequest`), or track `WaitOpened`/`WaitSettled` Events already in the stream. Add no new frame, flag or status. Pretty `run watch` and `--jsonl` are unaffected.
2. Return at any `Waiting`, as the code does today, and document that sleeps and retry backoffs end foreground observation with exit 4. Then add sleep and retry cases to the acceptance list.

Both options change what users see today. Today foreground run blocks until the terminal state, even through approvals. The draft's compatibility section should say plainly that foreground run will begin returning before the terminal state. Add a sleep or retry foreground case to the acceptance evidence whichever option the user picks.

## Required text corrections (small)

### R1. Cover every observation failure after admission, not only "disconnect", and keep daemon shutdown out of exit 130

Facts:

- **[code]** `main.ts:296-321`: only the `TaskRun`/`WorkflowRun` call has delivery-uncertainty guidance. `observe` (`:156-176`) prints nothing on failure.
- **[code]** The observer limit is checked when the watch is opened (`run-watch.ts:14-30`), so it is reached only _after_ admission in foreground mode. A seventeenth observer makes a foreground run fail with `LimitExceeded`: exit 5, message "Repository observer limit reached (16)". The run ID is never shown, although the run was admitted.
- **[code]** The `observeJsonLines` resume hint is printed only when the error is not an `OperationError` (`main.ts:193-201`). CLI teardown maps interrupt-only causes to 130 (`main.ts:1361`).
- **[probe]** On a minimal Effect 4.0.5 NDJSON HTTP RPC server, closing the server's scope while a stream was active failed the client stream with an **interrupt-only cause**. Stopping the Bun server first produced an `RpcClientError`.
  - Scripts: `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/bf6a34c4-1ca4-435b-911d-8c5ab5d6b2b4/scratchpad/shutdown-probe.mts` and `shutdown-probe2.mts` in the same directory.
  - **[inference]** Which outcome the daemon produces depends on its finalizer order and on how drain ends handler fibers. If the cause is interrupt-only, `daemon stop` during a watch exits **130**, which the docs define as "interrupted observation" (Ctrl-C), and prints **no resume line**. That would break the draft's reconnect guidance.

Replace "provide the admitted run ID plus a watch-resume command if observation disconnects after a successful admission" with:

> After a successful admission, any observation failure — transport loss, daemon stop or restart, `LimitExceeded`, or `Unavailable` while draining — prints to stderr: `Run <run-id> was accepted; observation ended (<reason>). Inspect with run get <run-id> or reattach with run watch <run-id>.` It does not suggest retrying the submission. A remote interruption (daemon shutdown) maps to exit 3, not 130. Exit 130 is reserved for local Ctrl-C/SIGINT. JSONL watch prints its `--after-sequence` resume line for the same remote-ended cases.

Add to the acceptance list: "`daemon stop` during an active JSONL watch and during a foreground observation exits 3 and prints the resume line; Ctrl-C exits 130 without it."

### R2. State the refusal precisely, and give the operator the way out

The pre-mutation refusal is right, and it follows the existing precedent: `--tag` already calls `SystemStatus` and refuses before submission (`packages/cli/src/tags.ts:53-59`) **[code]**. The wording "upgrade and restart the daemon" is wrong for the common case, though. A fresh CLI talking to an old daemon happens because the binary was upgraded while the old daemon kept running. The CLI is already upgraded; the daemon only needs a restart. `SystemHello` sends `clientVersion: "0.0.0"` and checks only `protocolMajor` (`client.ts:63-67`) **[code]**, so nothing else catches this mismatch.

Specify:

- The exit code: `Unavailable` → 3 (`main.ts:1347-1350`).
- The message: `The running daemon does not support run.watch.stream.v1. Restart it with this binary (effectory daemon stop, then effectory daemon start). To submit without observing, use --background.`
- The order: perform the capability check after input parsing, together with the existing tag `SystemStatus` call where that call runs (one status read is enough), and before `TaskRun`/`WorkflowRun`.

### R3. Narrow the Swamp comparison and state the scope boundary

Facts:

- **[code]** The citations are accurate. `vendor/swamp/src/cli/commands/workflow_run.ts:736` creates `workflowRun(...)` and `:776` calls `consumeStream`.
- **[code]** Swamp's stream is an in-process async generator (`src/libswamp/workflows/run.ts:752`), rendered live during a _foreground_ run.
- **[code]** `workflow_history_logs.ts` does use `consumeStream` (`:87, :122`), but over recorded history. It has `--tail <lines>` (`:60`), not a follow mode, so it is no evidence of live observation.

**[inference]** After this slice, Effectory's foreground run and pretty `run watch` still print nothing until they return. Only `run watch --jsonl` is live. That is a reasonable slice, but the comparison paragraph implies more than it delivers.

Change the paragraph to say:

- Swamp renders live events during a foreground in-process run, and its history-log stream is not live.
- This slice makes `run watch --jsonl` live and makes foreground return at waits.
- A live human-readable renderer for foreground run and pretty watch is out of scope and remains a later user decision.

Drop "Its history-log command also uses consumeStream" or qualify it.

### R4. Decide the idle behavior and publish the line bound

These are consumer-visible items in the "Ownership and bounds" section.

- **Idle behavior.** "Disable implicit content-route idle behavior … or verify existing heartbeats keep it consistent" leaves a visible behavior undecided. A paused reader (for example, piping into `less`) is either disconnected by Bun's idle timer or not. Pick one. I recommend `bunServer.timeout(request, 0)`, as the content route does (`daemon.ts:186-195`) **[code]**. Heartbeats then cover healthy connections, and cancellation or shutdown owns stalled ones. Say which.
- **Line bound.** Add one sentence for script authors: "Each JSONL line is one frame. Lines are at most <bound> bytes." **[code]** Event payloads are capped at 8 KiB by `appendEvent` (`host-store.ts:729-740`) and the telemetry path (`:376-388`). The other paths I found carry small fixed payloads, except two:
  - `ArtifactPublished`, whose payload is normalized lake metadata (`lake.ts:363-374`);
  - `CancellationRequested`, whose `reason` is at most 8192 characters (`protocol.ts:133`).

  2 MiB looks very generous for consumers. The proof belongs to the Effect review, but the published number should be the proven one.

## Accepted choices (no change requested)

- **Compatibility.** No new flags, frames or automatic reconnect. `/rpc` and its legacy `RunWatch` stay unchanged for old CLIs, and `--background` is unaffected. The existing `--after-sequence` meaning is preserved: the bound is exclusive (`sequence > after`), and an out-of-range value is rejected with `InvalidInput` → exit 2 (`host-store.ts:1110-1120`) **[code]**.
- **Resume cursor.** The resume cursor is the last Event written to stdout, matching `main.ts:184-192` **[code]**. "Snapshot.lastSequence is not an acknowledgement" is the correct warning for custom consumers.
- **Heartbeats.** "Five-second idle cadence" matches `run-watch.ts:54-60` (a 100 ms poll; Heartbeat after 5 s with no frames) **[code]**. While a run is Waiting with no new events, consumers see Heartbeats only, with no repeated Snapshots. The draft's "subsequent Snapshots" follows events, which is accurate.
- **Pretty watch.** Pretty `run watch` still prints only the final Run. Requiring the new capability for pretty watch too is stricter than necessary, because it works today against an old daemon by buffering. I accept it: one transport and one rule are simpler to explain, and the remedy is a restart. The draft already marks it as a choice for the user.
- **Observer count.** One shared observer count across both routes, with `SystemStatus.observers` unchanged (`control-plane.ts:186, 354`) **[code]**, keeps the operator's view consistent.
- **Custom clients.** `connectWatch(repository)`, scoped like `connectContent` (`client.ts:79-120`) **[code]**, is the expected shape for them.

## Notes outside this slice (not required)

- `run watch <id> --after-sequence N` without `--jsonl` silently ignores the flag (`main.ts:491-501`) **[code]**. This is existing behavior. Consider rejecting the flag or documenting it later.
- **[code]** The docs promise wait instructions at foreground Waiting (`cli-server-api.md:161`: "use `run waits <run-id>`"), but `observe` only prints the run. This path becomes reachable for the first time, so either print a stderr hint (`Run <id> is Waiting; inspect with run waits <id>`) or make the acceptance item check the current output against the docs. This item is small; the parent may fold it into B1's wording.

## Evidence summary

All probe scripts are in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/bf6a34c4-1ca4-435b-911d-8c5ab5d6b2b4/scratchpad/`. Each used a temporary repository, killed its own processes and removed the repository.

| Claim in draft | Status |
| --- | --- |
| Buffered `/rpc` blocks live JSONL | Confirmed by source (`daemon.ts:151` `layerJson`). The research-queue probe agrees. I did not rerun it. |
| Foreground run blocks at a durable wait | **[probe]** `fg-probe.mts`: still running after 25 s. `run list` showed `Waiting`. |
| Foreground "returns at Waiting as existing code intends" | Correct for approvals; **misses timers and retries** (B1). |
| Swamp `workflow_run.ts` ~736/~776 | Accurate; the history-log citation is not live (R3). |
| `--after-sequence` exclusive; reconnect from last written Event | Confirmed (code). |
| Old-daemon refusal before mutation | Consistent with the `--tag` precedent. The message and exit code need R2. |
| Error/reconnect guidance | Incomplete for typed post-admission failures and shutdown interrupts (R1). |
| Shared 16-observer count | The current counter is closure-local in `createRunWatcher` inside `controlPlaneLayer` (`control-plane.ts:186`). Sharing it needs the proposed factoring. The Effect review owns this. |

Re-review is needed after the user decides B1 and R1–R4 are applied. That re-check can be narrow.
