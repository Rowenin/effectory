# Live run observation — consumer review, round 3 (oversized-event recovery only)

Reviewer: Claude consumer review. Scope: the **new** oversized-event recovery text in `docs/live-run-watch-api-draft.md` revision 2 ("Line limits and oversized events", the proposed recovery message, and the parts of "Compatibility and admission" and the acceptance list that it affects). Round-2 C1–C3 are merged and are not re-reviewed. The foreground return rule, binary artifacts, the observer and permit bounds, and the Effect interruption proofs are out of scope. I changed no production code and did not edit the draft.

**This review only approves text for presentation. It is not user approval of live-watch changes, and it authorizes no implementation.**

Evidence labels: **[code]** means read from source in this checkout. **[inference]** means my reasoning, not checked by running anything. **I ran no scratch probes this round.** The draft's own guarantees (2,097,152-unit guard, rechunking so earlier frames are delivered) are **untested implementation claims**; I take them as given and say where a conclusion depends on them.

## Verdict: approve for presentation after four small text changes (C4–C7), plus one user decision (D1)

The core is sound. The design guards on the wire, raises a typed failure, never skips automatically, leaves stored history unchanged, and offers a skip only as an explicit, lossy opt-in. Four things need fixing:

- The skip only works through JSONL. Foreground and non-JSONL `run watch` always replay from sequence 0. The accepted-run hint "reattach with `run watch <run-id>`" would fail again on the same event, which is a loop (C4).
- The CLI has no structured way to learn N (C5).
- The "undelivered earlier events" clause is vague. It can be replaced with a concrete cursor fact (C6).
- One compatibility sentence is needed for scripted consumers (C7).

## What I checked

### Command names and cursors — correct

- **[code]** `run get <id>`, `run events <id> [--after-sequence N]` and `run watch <id> [--jsonl] [--after-sequence N]` all exist, with a positional id (`packages/cli/src/main.ts:63`, `:426-430`, `:470-489`, `:490-502`). The commands in the proposed message are spelled correctly.
- **[code]** `--after-sequence` is exclusive. The watcher starts from `state.after` and advances to the last emitted sequence (`packages/platform-bun/src/run-watch.ts:33-51`). Skipping with `--after-sequence N` therefore resumes at N+1. This is the intended, lossy skip of exactly event N, not a skip of N+1.
- **[code]** Sequences are dense per run. They are allocated as `lastSequence + 1` (`host-store.ts:318`, `lake.ts:363`), and the watcher emits every stored event in order (`run-watch.ts:44-46`).
- **[inference]** Combined with the draft's rechunk guarantee (untested), when JSONL fails on event N, the last Event written to stdout is N−1, or the user's starting cursor if N is the first event after it.

### "This event also exceeds the run events page limit" — true

- **[code]** `eventPage` sums `Buffer.byteLength(JSON.stringify(item))`. It stops at 1,048,576 bytes, and it throws `LimitExceeded` "Event exceeds page byte limit" when the first candidate event alone exceeds that (`packages/platform-bun/src/inspection.ts:94-110`).
- **[inference]** A string's UTF-8 byte length is never smaller than its UTF-16 unit count. An Event whose encoded watch line exceeds 2,097,152 units therefore exceeds 1 MiB as a page item by a wide margin, even after subtracting the small envelope. `run events` either stops before N or fails on N. The claim and the decision to promise no reader both hold.
- Pre-existing and out of scope: events between about 1 MiB and 2,097,152 units stream through watch but cannot be paged. No change requested.

### Exit code and printing — consistent with the draft

- **[code]** Every `OperationError` other than `InvalidInput`/`Unavailable` exits 5 (`main.ts:1345-1351`). So typed `LimitExceeded` gives exit 5, as the draft says.
- **[code]** The top-level handler already prints `OperationError.message` verbatim to stderr (`main.ts:1328-1334`).
- **[code]** `observeJsonLines` currently prints no resume hint for typed errors (`main.ts:194-201`). Any oversized-event guidance is therefore new CLI or server text. Nothing has to be suppressed.

## Required text changes

### C4. Foreground and non-JSONL watch cannot skip; do not tell them to reattach with plain `run watch`

**[code]** `observe()`, which foreground `task run`/`workflow run` and non-JSONL `run watch` both use, always calls `RunWatch({ runId })` with no `afterSequence` (`main.ts:155-158`). Non-JSONL `run watch` parses `--after-sequence` but never passes it on (`main.ts:493-501`).

**[inference]** The server guard fails on every frame, whether or not the client ignores Events. So once a run contains an oversized event, every later plain `run watch <id>` replays from 0 and fails with exit 5 at N, even after the run ends.

The round-2 accepted-run text (`… or reattach with run watch <run-id>`) is therefore a loop for this case. That conflicts with the draft's own "must not loop" rule (draft §Compatibility, last sentence).

Replace the recovery paragraph's single message with a mode-specific tail. Add to the draft:

> For an oversized-Event failure, the accepted-run line omits the `run watch <run-id>` reattach suggestion and ends `Inspect with run get <run-id>.` Plain `run watch` and foreground observation always replay from sequence 0, so they cannot get past that event. The only continuation is the explicit JSONL skip. Do not suggest `--after-sequence` without `--jsonl`, because non-JSONL `run watch` ignores it.

Add one acceptance case: after an oversized event, plain `run watch <id>` exits 5 with guidance that names `run get` and the JSONL skip, and never names plain `run watch`.

### C5. Say how the CLI obtains N

**[code]** `OperationError` carries only `code` and `message` (`packages/runtime/src/protocol.ts:110-130`). `LimitExceeded` is also used for oversized non-Event frames and for unrelated limits. The CLI cannot fill `<N>` without parsing message text, and parsing text is fragile.

Smallest fix with no protocol change: **the daemon authors the full message**, including N and the skip command, for oversized Events only. The CLI prints it verbatim through the existing handler, and adds only the accepted-run line (C4) and the cursor line (C6). Oversized non-Event frames get a message without a skip sentence.

The cost is that the daemon text names CLI syntax. That is acceptable for a bounded, human-facing message. A structured sequence field would change the public error schema, which is outside this slice.

Add to the draft: "The oversized-Event `OperationError.message` is authored by the daemon and includes the run ID, N and the skip command. The CLI does not parse it."

### C6. Replace the "undelivered earlier events" clause with a concrete cursor

"undelivered earlier events may require separate replay first" leaves the user guessing what was missed. With dense sequences and the rechunk guarantee, nothing earlier is missed by a JSONL run that reaches N. Replace it with:

> JSONL also prints `Last event written: <L>.` (the R1 cursor). Normally L = N−1, so skipping loses only event N. Foreground and plain `run watch` write no events. A consumer that needs events before N can replay them with `run watch <id> --jsonl --after-sequence <start>`. That replay re-delivers them and then fails again at N.

Do not point to `run events` for this replay. Events between about 1 MiB and the watch limit cannot be paged (see above).

Add an acceptance assertion that the last Event written before the oversized failure has sequence N−1.

Resulting JSONL stderr, for presentation:

```
Event <N> of run <id> exceeds the live watch limit and remains stored. It also exceeds the run events page limit; this release has no reader for it. Inspect run state with run get <id>. To intentionally skip it and continue, use run watch <id> --jsonl --after-sequence <N>.
Last event written: <L>.
```

For foreground, the first line is the same. It is followed by the accepted-run line without the reattach suggestion (C4).

### C7. One compatibility sentence for scripted consumers

Add this to the compatibility text: "Exit 5 from observation is not resumable from the same cursor. A run that contains an oversized event makes foreground exit 5 whatever the run's outcome. Scripts must read the outcome with `run get`." This is the consumer-visible change behind the existing "LimitExceeded remains exit 5" sentence. Without it, a CI wrapper that retries `--after-sequence L` would loop.

## Unresolved consumer decision for the user

**D1. Is permanent failure of plain `run watch` acceptable in this slice for runs that contain an oversized event?**

- **(a) Recommended for this slice: accept it.** Plain watch and foreground exit 5 with the C4/C7 guidance. The user reads outcomes with `run get` and continues streaming with the explicit JSONL skip. This needs no new behavior and matches "no automatic skip".
- **(b) Follow-up: non-JSONL observation consumes only Snapshots, so it could start after the run's current `lastSequence` (one RunGet first).** Reattaching would then avoid replaying history. It changes what plain watch requests, and it still fails on an oversized event produced during observation. It needs its own small design and must not be folded into this slice.

No other consumer decision is open. The lossy skip being explicit and opt-in, and the absence of an export API in this slice, are already framed correctly as requiring user approval.

## Unchanged

The settled foreground rule, round-2 C1–C3, the line-limit units (UTF-16 bound, conservative UTF-8 bound, no "2 MiB" wording), and the non-Event oversized-frame behavior ("names its kind without inventing a sequence") read correctly. They need no consumer change.
