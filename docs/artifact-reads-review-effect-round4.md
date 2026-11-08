# Artifact reads: Claude Effect design re-review, round 4

Status: a narrow Effect-perspective check of the binary admission paragraphs and small fixture corrections in frozen [draft 3](artifact-reads-api-draft.md). It is checked against [Effect round 3](artifact-reads-review-effect-round3.md) G1–G5 and [consumer round 3](artifact-reads-review-consumer-round3.md) K1–K5. **This is reviewer status, not user approval.** `ArtifactReader` is neither approved nor implemented.

The accepted reader methods, errors, first-access boundary and retention direction were not reopened. The existing lake query optimization is unrelated and was not re-examined. The report scale/projection evidence is research only and is not relied on here.

Labels:

- **[Fact]**: read from source in this checkout.
- **[Probe]**: executed for this review outside the checkout, with pinned Effect 4.0.5 and Bun 1.4.3.
- **[Wording]**: a small text fix this approval is conditional on.
- **[Advisory]**: recommended, not blocking.

Probe directory: `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/d9fe18a8-ec4b-4c13-934e-ac21d5028c4e/scratchpad/probe4/`

- `probe.ts` drives the **real** `createBinaryStorage` from `packages/platform-bun/src/lake-binary.ts`: its unchanged `Semaphore.makeUnsafe(4)` writer pool, real staging files and hashing, and an in-memory `bun:sqlite` database.
- `admission.ts` is a **labelled stand-in** for the admission owner: a FIFO hand-off slot pool and a per-invocation `Idle | Pending | Held | Closed` group whose reference count covers publications and binary reads. It also models the K3 local queue and close.
- The reader `stream`/`bytes` operations and both bridges are also **stand-ins**.
- Output is in `probe.log`.

No draft, production source or other dirty file was edited. No commits were made, no subagents were used, and the repository suite was not run.

## Verdict

**Conditional approve for presentation.** The approval depends on three wording fixes (§3). No further review round is needed. Once these sentences are in, the binary admission section can go to the user as a decision.

- **The G3 resolution works.** Putting the shared group before the writer pool removes the demonstrated cross-invocation cycle. Shown against the real writer pool, the old order stalls and the new order completes in both start orders (§2).
- **Both bridges can share the owner without widening publication errors.** This depends on the host constructing one owner per attempt and the `publishBytes` bridge wrapping the whole existing `binary.publish` call.
- **K3 local queuing and re-evaluation, coalesced cancellation and interruptible acquisition** behave as drafted in the stand-in.
- **Close ordering is the one remaining precision gap.**

## 1. Fixture and small corrections

| Item | Draft 3 | Result |
| --- | --- | --- |
| K1 timestamps | Line 196: default is 1 ms after the preceding row (epoch + 1 ms first). Backwards histories within an artifactId are rejected, and so is an unrepresentable next default. | **Resolved.** |
| K2 digest aliases | Line 213: allocate artifact IDs and digest aliases after the highest seeded alias of each kind. | **Resolved.** |
| Round-3 R7 wording | Line 194: "key = the definition's `id`". `test-owner` is distinct from the production `owner`. | **Resolved.** |
| C5 wording | Line 175: "Otherwise treat the read as an ordinary external read: it pins and counts." | **Resolved.** |
| G1 FIFO | Line 148: a dedicated hand-off queue; release grants to the oldest waiter; a grant racing cancellation is passed on; not a bare Semaphore. | **Resolved.** |
| G2 / K4 ownership | Lines 148–149: the invocation owns the acquisition; withdrawal happens when no pending operation needs it; synchronous handoff; interruptible wait with masked install only; a forked acquirer restores interruptibility. | **Resolved.** |
| G4 JSON | Line 144: no slot while the read is one synchronous ≤1 MiB step; metadata, latest and query take none. | **Resolved.** |
| G5 order | Line 150: authorize → pin (retries outside the transaction) → content lease → liveness re-check → I/O. The nested-in-publication exception is bounded. | **Resolved.** |
| K5 honesty | Line 151: queue time counts toward the deadline; leases are not rotated; 16 reads / 256 MiB is not a memory guarantee; user cycles are not promised away. | **Resolved.** |

## 2. G3: shared group before the writer permit

### 2.1 Why the order removes the cycle

[Fact] There are two global pools on the binary path:

- **S**: the proposed four invocation slots.
- **W**: the existing four writer permits. `lake-binary.ts:223` creates them, and `:256` takes `withPermits(1)` before it consumes the author's source stream.

Under draft 3, every wait for W happens while the publication's own reference holds its invocation group in S. A cycle would need some W holder to wait for S. That cannot happen:

- A W holder's group is `Held` for as long as that publication's reference lives.
- Any read or publication that the W holder's source starts therefore joins the held group and never queues on S.
- An invocation never queues on S while it holds S, because of coalescing.
- S holders do not wait on S.

So the order S → W is strict, and the only edges are S-holders waiting on W. The 32 execution slots and the report semaphore are still taken before the handler, never under S or W ([Fact] `interpreter.ts:334-341`).

The K3 local queue does not reintroduce an edge:

- A local waiter waits only on a finite `bytes` read, or on a pending group.
- A finite read needs neither W nor caller progress.
- A pending group holds no W, because a publication holding W would keep its group `Held`.
- Publications occupy no read position.

What remains is what line 151 already excludes: user-made dependencies between invocations, and a publish nested inside another publication's source while all writers are taken.

### 2.2 Probe against the real writer pool

| Scenario | Result |
| --- | --- |
| **W_old_Q_first** (existing bridge). Q1–Q4 each hold a stand-in S slot with an open stream and publish one bytes artifact per chunk. Then P1–P4 run `publish(B, reader.stream(A))` through the real `binary.publish`. | **Stalled.** No progress for 1.5 s. All 4 S slots were held, 4 waiters were queued, and P held the 4 real W permits while its sources waited on S. In production this lasts until the attempt timeout. |
| **W_new_Q_first** (draft-3 bridge: `reserve("publication")` around `binary.publish`). Same shapes and timing. | **Completed in 82 ms.** P queued on S holding nothing. Q's per-chunk publishes reused Q's group and took W. Ended with S free 4/4 and no waiters. |
| **W_new_P_first**: P starts first. | **Completed in 29 ms.** P's source readers reused P's held group under W. |

The cleanup warnings in the log come from interrupting the stalled old-order fibers after the timeout. They are not part of the result.

### 2.3 Sharing the owner across both bridges

[Fact] In production there is one call site per bridge. `interpreter.ts:68` `taskContext` builds a per-attempt `RuntimeContext`, and its `publishBytes` (`:119-133`) is the only route to `lake.publishBytes` → `binary.publish`. Report invocations reuse the same `taskContext` (`:239-264`). The future reader bridge sits beside it, so one owner created there, next to `active`, is naturally shared. Layer-acquisition reads use the same context.

The core does not care which fiber pulls the source. `publicationLifetime.run` forks a detached child (`publication-lifetime.ts`), and `binary.publish` consumes the source inside it. Group membership is per invocation, not per fiber, so a source read in that child still reuses the group. `Task.test`'s own bridge (`task.ts:632`) has no global pools, as draft line 152 says.

Publication errors are not widened:

- The group wait can only succeed, be interrupted, or end because the invocation closed.
- The bridge maps close to the existing `TaskRuntimeError`/`InvalidBoundary`. [Probe] Scenario C: a publication pending in the group at close failed `TaskRuntimeError`, and a coalesced read failed `Closed`.
- `ConcurrencyLimit` cannot reach a publication, because publications occupy no read position.

The one new consumer-visible outcome is that a bytes publication can now spend queue time against its attempt deadline. Line 151 already states this.

This holds only if:

- the publication reference wraps the entire existing `binary.publish`, including the writer wait, source consumption, install retries and writer release; and
- S is a single daemon-wide pool, like W.

Draft line 146 implies both but does not say either (W1).

## 3. Queue, cancellation and close checks

| Scenario | Result |
| --- | --- |
| **T**: a publication and a `bytes` read coalesced in one pending group while S is saturated; the publication is interrupted, then the read | Each interrupt returned in 1 ms; nothing waited for a grant. After the publication was withdrawn the group stayed `Pending` (pubs 0, reads 1, still queued). After the read was withdrawn: `Idle`, queue empty, slot free. Explicitly restoring interruptibility around the forked acquirer's wait works. |
| **R**: grant racing cancellation of coalesced publication/read groups, 400 iterations, varied windows | **0 leaked slots, 0 over-grants, every group ended `Idle`.** 239 real publications completed in the windows that let them. |
| **L1**: three open streams plus one 30 ms `bytes` read; a fifth `stream` | It waited 26 ms locally, then succeeded. |
| **L2**: four `stream` reservations awaiting admission; a fifth read queued locally; admission then completes | The waiter was re-evaluated on grant and failed `ConcurrencyLimit` 25 ms later, at the grant, not when the streams ended. This is the "already-queued read cannot remain stuck" rule. |
| **C**: close with a pending publication and read; close while `Held` with an operation still in scope | The pending publication failed `TaskRuntimeError` and the read failed `Closed`. After the late finalizer ran, the slot had been returned exactly once (free 1, granted 0). |

**Close ordering gap.** In the stand-in, and as line 149 reads, a `Held` slot can be returned at close _before_ the owned operations' cleanup finishes. Nothing deadlocks, because cleanup never waits on S. But it allows a transient fifth binary invocation while a closing descriptor or a writer-holding staging cleanup is still running. That breaks the stated 4 × 4 and S → W invariants for that window. The fix is to return the slot last (W2).

[Fact] `task.ts:412` runs `lifetime.close`, which interrupts and awaits core-owned publications, in `ensuring` inside `execute`. `interpreter.ts:266-271` flips `active` only afterwards, and draft line 141 requires reader cleanup before task-local Layers release. So the owner's close must be driven from the same invocation close as the core lifetime, not from the later host `ensuring`.

## 4. Required wording fixes

**W1 [Wording], line 146.** After "...including source-stream consumption.", insert:

> The host `publishBytes` bridge takes this publication reference around the entire existing binary publish call, so it covers the writer wait, source consumption, installation retries and writer release, and is released only after the writer permit. The invocation-slot pool is one daemon-wide instance like the writer pool; the per-attempt owner is created once with the runtime context and closed over by both the reader and `publishBytes` bridges.

**W2 [Wording], line 149.** Replace "On close, fail pending operations with Closed, interrupt/await owned operations and their cleanup, and return each slot exactly once. Publication closure retains its existing TaskRuntimeError/InvalidBoundary behavior; it does not gain reader-domain errors." with:

> On invocation close, in order: mark the owner Closed; fail pending reads with Closed and pending publications with the existing TaskRuntimeError/InvalidBoundary (publications gain no reader-domain error); interrupt and await owned reads and publications including descriptor and staging cleanup; only then return a still-held invocation slot, exactly once. Finalizers running after close are no-ops. This close runs within the same invocation close as the publication lifetime, before task-local Layers release.

**W3 [Wording], line 147.** After "...behind four newly opened streams.", insert:

> An interrupted local waiter leaves the queue; a position handed to it while it is being interrupted passes to the next local waiter or is released.

**Proof gate 4 [Wording].** Append:

> Run both probe-W shapes (stream-holder publishing per chunk; `publish(B, reader.stream(A))`) in both start orders against real `createBinaryStorage` with all writer and invocation slots saturated; both must complete. Close with a publication pending in the group yields TaskRuntimeError/InvalidBoundary, and the slot is returned only after owned cleanup.

## 5. Advisory

- **Writer barging remains.** [Advisory] W is still a bare `Semaphore` and can barge. Every W waiter is now inside one of at most four admitted invocations, so this cannot block a non-admitted run. Within that set, one invocation running many concurrent publications can repeatedly retake W ahead of another admitted invocation's publication, until that publication's attempt timeout. Mention it in one clause on line 151, or give W the same hand-off queue. This is not blocking; existing writer behaviour promised no fairness either.
- **Pin retries under a writer permit.** [Advisory] A pin retry nested in a publication source holds both S and W through at most 250 ms of sleeps (line 150 already allows this). That is bounded and causes no cycle.

## 6. Presentation decision (unchanged scope)

The user decides on these, with the scheduling change made explicit:

- Four admitted binary invocations, each with four local binary reads.
- K3 local queuing, with fail-fast `ConcurrencyLimit` when all four are open streams.
- **Every bytes publication now queues in the shared invocation FIFO before the unchanged four-writer pool.** This can delay writes behind long-lived readers until the attempt timeout, and it adds no publication error.
- JSON reads and publications bypass the slots.

Reviewer status: **G1–G5 and K1–K5 resolved. G3's third resolution verified. Conditional approve for presentation after W1–W3 and the gate-4 sentence.** This is not user approval.
