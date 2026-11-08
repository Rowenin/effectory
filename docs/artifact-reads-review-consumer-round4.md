# Artifact reads: consumer design critique, round 4

Reviewer: Claude, reviewing through the consumer and developer-experience lens. This is a narrow check of the frozen [draft 3](artifact-reads-api-draft.md) against [consumer round 3](artifact-reads-review-consumer-round3.md) K1–K5 and [Effect round 3](artifact-reads-review-effect-round3.md) G1–G5.

**This is reviewer feedback, not user approval.** `ArtifactReader` is neither approved nor implemented. The lake query candidate optimization is a separate internal change, and nothing here relies on it. The report scale and projection evidence is research only. I did not reopen the accepted methods, error tags, first-access boundary, fixture direction or retention amendment.

Scope: the binary admission paragraphs (draft lines 106, 144–152, 449, gate 4) and the small fixture and reporter corrections (lines 175, 194–196, 213). No production file, other doc or commit was changed, and I ran no repository suite.

Labels:

- **[Fact]**: read from source in this checkout.
- **[Probe]**: run for this review outside the checkout with pinned Effect 4.0.5 and Bun 1.4.3. The admission pool, invocation groups and readers are a **labelled stand-in**. The writer pool is a real `Semaphore.makeUnsafe(4)`, as in `lake-binary.ts:223`.
- **[Correction]**: an exact text change. None needs another review round.
- **[Advisory]**: optional.

Probe: `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/bb96cd96-455d-4903-8777-008efebb718a/scratchpad/probe4/shared.ts`, log `shared.log`. The stand-in models grant order, reuse within an invocation, and release with hand-off. It does not model interruption, close or local read limits; Effect round 3 already covered those.

## Verdict

**Conditional approval for presentation. No repeat round is needed** once the four text corrections below (L1–L4) are made.

- K1, K2, K4 and K5 are adopted. K1 needs one word, because a default timestamp can still invert a history (L1).
- K3 and JSON exclusion are adopted accurately.
- The G3 shared-admission alternative does what it claims. Ordinary copy pipelines and finite bytes fan-out never fail Busy, whatever the load, and the reader/writer inversion is gone (probe W).
- The cost falls on existing write-only users. The draft states it, but too abstractly for a user decision (L3, L4). It also creates one harness/production divergence that the draft does not mention (L2).

| # | Correction | Area |
| --- | --- | --- |
| L1 | A default `committedAt` follows the **greatest** preceding timestamp, not the immediately preceding row. | Fixtures |
| L2 | A publication's source reads count as local binary reads. `Task.test` must mirror the four-writer bound, or copy fan-out fails only in tests. | Admission / harness |
| L3 | Name the concrete effects on write-only tasks in the tradeoff paragraph. | Admission wording |
| L4 | The decision list shows the rejected fail-fast alternatives and what each would cost. | Decision list |

## 1. Round-3 items

| Item | Draft 3 | Result |
| --- | --- | --- |
| K1 timestamps | Line 196: +1 ms after the preceding row; backwards seeded histories rejected; explicit and defaulted are distinguished; no wall clock. | **Adopted, one gap (L1).** |
| K2 digest aliases | Line 213: allocate after the highest seeded alias of each kind. | **Resolved.** The threaded second producer now mints `test-artifact-2`/`test-digest-2`. Compatibility without fixtures is unchanged. |
| C5 wording | Line 175: "Otherwise treat the read as an ordinary external read: it pins and counts." | **Resolved.** |
| K3 local queuing | Line 147: finite reads wait. Fail fast only when all four are open streams. Re-evaluate on admission or a state change. Local waiters are served before the slot is returned. | **Resolved.** The added re-evaluation clause closes a hole I had not named: a waiter stuck behind streams that opened after it queued. |
| K4 ownership and FIFO | Lines 148–149: invocation-owned acquirer, hand-off queue, withdraw when no pending operation remains, idle re-enters at the tail, interruptible wait, masked install only. | **Resolved.** Matches Effect G1/G2. |
| K5 honest claims | Line 151: attempt-deadline charging, lease retention, no preemption, 256 MiB and "not a process-memory guarantee". | **Resolved.** [Fact] Writer buffers are one 64 KiB block per publication (`lake-binary.ts:30`), so "before … writer buffers" is honest and small. |
| JSON exclusion (G4) | Line 144: no slot; one synchronous step of at most 1 MiB; tied to the current implementation. | **Resolved.** The reporter example's `forEach(page.rows, get)` and any unbounded JSON fan-out are now load-independent. JSON gets still pin, and their ≤250 ms pin retry holds no slot. |
| Pin before lease (G5) | Line 150. | **Resolved.** A pin retried inside a publication's source keeps that publication's writer permit for at most 250 ms. That is bounded and stated. |
| Reporter `revision` advisory | Still `"fixture-revision"`. | Not adopted. It is advisory and does not block. |

### L1. Mixed timestamps across identities [Correction]

"One millisecond after the preceding seeded or published row" uses the preceding row in sequence order, which may belong to another identity. Example:

1. Fixture X v1 is explicit `2026-01-01`.
2. Fixture Y v1 is explicit `2020-01-01`.
3. The test then publishes X v2. Its default is `2020-01-01T00:00:00.001Z`, which is earlier than X v1.

`orderBy committedAt desc` inverts X's history again. The seeding check does not catch this, because it applies only to seeded histories. Replace the clause with:

> A default committedAt is one millisecond after the greatest committedAt among preceding seeded or published rows (epoch plus one millisecond for the first row).

The defaults are then monotone, and the existing rejection rule only needs to cover explicit seeded timestamps.

## 2. The G3 shared-admission resolution

### 2.1 What it preserves [Probe]

`shared.ts` scenario W uses 16 invocations:

- Eight run `publish(B, reader.stream(A))`, with the read opening after the writer permit is taken.
- Eight hold an open stream and publish a bytes artifact per chunk.

| Model | Result |
| --- | --- |
| Separate reader group pool (4) and writer `Semaphore` (4), as in draft 2 | **Stall**, with no progress in 2 s. |
| Every publication takes the shared slot before the writer permit (draft 3) | **All 16 complete in 130 ms.** |

The reasoning holds beyond the probe:

- Every writer holder already holds its invocation's slot, and nested reads reuse that slot. A writer holder therefore never waits for a global slot.
- [Fact] The only path into binary publication is the invocation bridge: `interpreter.ts:119` → `lake.ts:490` → `lake-binary.ts:256`. "Every bytes publication" is therefore enforceable, and no host-internal writer bypasses the order.
- Execution, workflow-path and report permits are taken before the handler (`interpreter.ts:334-341`). They stay outside the cycle.

From the consumer's side:

- **Ordinary stream copy** queues and never fails Busy. The source read reuses the publication's slot.
- **Finite bytes fan-out** queues locally (K3) and never fails Busy.
- **Copy fan-out** `forEach(refs, r => publish(Def, reader.stream(r)), { concurrency: n })` works for any `n` in production. A publication opens its source only after it has a writer permit, so at most four source streams are open. That is exactly the local limit.
- **No publication error widening.** That is the main advantage over Effect's alternative (a).

The "every" is necessary. A narrower variant in which only invocations that are already reading take the slot first fails:

1. A write-only invocation takes a writer.
2. Its lazily opened source then requests a slot while holding the writer.
3. That reproduces W.

A second variant, where a read pulled inside a writer permit is admitted by that permit, would rely on fiber-local marking. Queue-fed or pre-forked sources escape that marking. I agree with not pursuing either, and neither needs a new API.

### 2.2 L2: source reads and the harness [Correction]

Line 147 ends: "Publications do not consume these four read positions." That is true of the publication itself. Its source `reader.stream` is a binary read, however, and does count, including toward the all-open-streams fail-fast rule. Say so.

This exposes a divergence. [Fact] `Task.test`'s `publishBytes` (`task.ts:632-636`) drains the source with no writer bound. In the harness, a copy fan-out with `concurrency: 8` opens eight source streams, and the fifth fails `ConcurrencyLimit`. In production the same code succeeds, because the four-writer pool serialises the source opens.

This is the reverse of the usual harness gap: the test fails where production succeeds. Authors would then lower concurrency for no reason. Add to line 147 and line 152:

> A bytes publication's source reads count as local binary reads. Task.test bounds its own bytes publications to four concurrent writers, without global competition, so the source-open order matches production.

One residual load dependence remains, and it is acceptable. Take an invocation that holds one extra open stream and also fans out copies at `concurrency ≥ 4`. It fails `ConcurrencyLimit` when writers are idle and may succeed when writers are busy elsewhere. The failing case is the idle one, which the harness reproduces once it mirrors the writer bound, so tests catch it. No text is needed beyond L2.

### 2.3 Effect on existing write-only users [Probe]

| Scenario (stand-in) | Today: writer pool only | Shared admission |
| --- | --- | --- |
| Four invocations each hold a 300 ms read. A fifth publishes five 5 ms bytes artifacts sequentially. | 31 ms | **326 ms** |
| Four invocations each publish 20 items at concurrency 2. A fifth publishes five items sequentially. | 150 ms | **91 ms** |

Both directions are real:

- **Long readers now delay writes.** A task that only publishes can now wait for, or time out behind, unrelated long-lived streams. Today it cannot.
- **Fairness among writers improves.** Today's `Semaphore` lets fan-out publishers barge (Effect G1). The FIFO slot queue gives the sequential publisher a turn earlier.
- **Sequential publish loops re-queue per item** when slots are saturated, because each publication's release leaves the invocation idle. This is new for write-only tasks.
- **A queued writer holds a scarce slot.** An admitted invocation waiting for a writer permit keeps its shared slot, and inside the writer pool barging remains possible among the four admitted invocations. A writer-starved invocation therefore also occupies read capacity. [Advisory] Using the same private hand-off queue for the writer permit costs nothing publicly and removes that starvation. It is not required.

The draft says "can delay all later binary reads **and writes**" (line 151). That is accurate but abstract. Users approving this need the concrete consequences for code they already have.

### 2.4 L3: tradeoff wording [Correction]

Append to line 151:

> Existing tasks that only publish bytes are affected without code changes: they can wait for, or time out behind, other invocations' long-lived binary reads, and a sequential publish loop re-enters the queue for each publication while slots are saturated. An admitted invocation keeps its slot while waiting for a writer permit. In exchange, invocations are admitted to binary I/O in FIFO order, which today's writer semaphore does not provide.

### 2.5 L4: decision list [Correction]

Line 449 asks the user to "accept the queueing/fairness and buffering tradeoffs". The user cannot weigh the choice without seeing what it replaces. Add:

> Alternatives not taken (both keep write scheduling unchanged): (a) an invocation holding a read never waits for a writer, so read-then-publish fails fast under writer saturation, which needs either a typed publish-side Busy or acceptance as a host failure; (b) a read started while holding a writer never waits for a slot, so `publish(Def, reader.stream(...))` fails ArtifactUnavailable/Busy under reader saturation. Shared admission instead makes both wait, at the cost that long readers can delay existing bytes publishers.

Remaining user choices for this item, all present once L3/L4 are applied:

- shared admission versus (a) or (b);
- 4 × 4 plus four writers;
- K3 local queuing;
- attempt-deadline charging and no preemption;
- 256 MiB buffering.

The "arbitrary user dependency cycles and nested writes while all writers are held are not solved" clause is honest. It is also not new: today, four publications whose sources each publish again already deadlock the writer pool.

## 3. Timeout, memory and harness bounds

- **Timeouts.** Queueing is charged to the attempt deadline for reads and now for writes. Waiting adds no new error tag, so `retry.when: ["ArtifactUnavailable"]` does not retry saturation. Authors retry on their timeout policy. This is stated.
- **Memory.** The draft reports 256 MiB of whole-byte buffers and does not claim a process bound. Shared admission adds nothing material: four writers × 64 KiB.
- **Harness.** Line 152 is correct about global fairness and timeouts. It needs L2 for the writer bound. Without it, the harness is stricter than production for copy fan-out.

## 4. Proof-gate deltas (gate 4)

- `Task.test` and the real host agree on `forEach(refs, copy, { concurrency: 8 })`: both succeed (L2).
- A write-only invocation queued behind four long readers waits, and fails with the attempt timeout if its deadline expires. It is never Busy, and it leaves no slot or writer permit behind.
- FIFO across mixed read and publication arrivals: a publication arriving after a queued reader invocation never overtakes it.
- A publication interrupted while queued for the shared slot completes its interruption promptly, without waiting for a grant. Closing the invocation while a publication waits for the slot keeps `TaskRuntimeError`/`InvalidBoundary` and never surfaces reader `Closed`.
- K1/L1: an explicit-later fixture, then an explicit-earlier fixture of another identity, then a defaulted publication of the first identity still orders after its own v1.

## 5. Status

**Consumer reviewer: approve for presentation, conditional on L1–L4 as worded above.** No further consumer round is requested. Every item in §2.5 and the draft's decision list remains the user's to approve.
