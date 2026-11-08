# Artifact reads: Claude Effect design re-review, round 3

Status: narrow Effect-perspective check of [consolidated draft 2](artifact-reads-api-draft.md) against [Effect round 2](artifact-reads-review-effect-round2.md) R1–R10, plus the new grouped permit policy. **This is reviewer status at most, not user approval.** `ArtifactReader` is neither approved nor implemented. The draft was treated as frozen.

The independently implemented lake query candidate optimization (`lake-query-candidates.ts`, reported as passing 356 tests, typecheck and check) is a separate thing. It is mentioned below only where draft 2 cites it for R9. It is not reader code, and nothing here treats it as such.

Labels:

- **[Fact]**: read from source in this checkout.
- **[Probe]**: executed for this review outside the checkout, with pinned Effect 4.0.5 (`node_modules/.bun/effect@4.0.5`), Bun 1.4.3 and real `bun:sqlite`. Every pool, slot, reader and pin loop in a probe is a **labelled stand-in**, not SDK code.
- **[Required]**: must change before this reviewer's approval holds.
- **[Advisory]**: recommended, not blocking.

Probe scripts and logs are in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/8618f3f8-add4-4ca9-8168-e31c4d4a8ac8/scratchpad/probe3/`:

- `barging.ts`
- `grouped.ts`
- `grouped-naive.ts`
- `grouped-test.ts`
- `more-test.ts`
- `busy.ts`

No production file was edited, and the repository suite was not run.

## Verdict

**Request changes. They are narrow and confined to the grouped permit policy.**

R1–R10 are resolved. Two need a one-word or one-clause precision fix (§1).

The grouped design is sound in its central claim. With correct coalescing, an invocation never waits for a second reader slot while holding one, and nested reads up to four deep proceed while the global pool is exhausted (probe E′). Four gaps remain:

1. **G1: "FIFO" is false with Effect's `Semaphore`.** A waiter can be barged indefinitely.
2. **G2: Coalescing has a specified-but-unwritten state machine and two Effect traps.** A naive `acquireRelease` wait cannot be cancelled.
3. **G3: Hold-and-wait across pools.** It still exists between reader slots and the existing binary writer permits. A real deadlock (two invocations, two pools) was reproduced. It persists until the attempt timeout.
4. **G4: JSON `get` gives load-dependent permanent failures.** Counting it as a content operation makes ordinary `Effect.forEach(rows, get, { concurrency: "unbounded" })` succeed when the daemon is idle and fail permanently with `ConcurrencyLimit` under cross-run load (probe J). That contradicts the draft's own goal.

All four have minimal corrections in §3. Once they are in, a check limited to §3's text is sufficient; no full review loop is needed.

## 1. R1–R10 resolution check

| Item | Draft 2 | Result |
| --- | --- | --- |
| R1: codec isolation | Line 116: lifetime-owned child; `Fiber.await`, never `join`; success → value; defect, Schema failure or self-interrupt → `DecodeFailed`, or `Closed` after close; external interruption interrupts and awaits the child, discards its Exit, and leaves the caller cleanly interrupted. Applies to every reader body running author code. | **Resolved.** Matches the C2/C3 evidence from round 2. Proof gate 7 covers a finalizer that dies with sensitive text. |
| R2: typed `Closed` | Line 142: end-of-stream only after EOF verification; close gives `Closed`, never a short success or a shutdown masquerading as interruption; consumer interruption still interrupts the pump. | **Resolved.** Gate 4 includes "or end as a short success". |
| R3: no permit across decoding | Line 145: release after verified raw I/O, before decoding. | **Resolved, superseded by G4.** If JSON takes no slot at all, the question disappears. |
| R4: permit policy | Replaced by grouped admission. | See §2–§3. |
| R5: cross-connection contention | Line 172: immediate pin; ≤250 ms interruptible retry outside the transaction; immediate apply; gate 3 retargeted at engine/host write locks. | **Resolved.** [Probe] `busy.ts`: with two real WAL connections and `busy_timeout=0`, a writer held a write lock across an async gap on connection A. The stand-in immediate pin on B retried and succeeded after 99 ms (9 attempts) for a 100 ms hold. For a 400 ms hold it returned `SQLITE_BUSY`→Busy at 250 ms. The error exposes `code: "SQLITE_BUSY"`, so the mapping needs no message parsing. `BEGIN IMMEDIATE` succeeds beside an open WAL read transaction. One ordering precision point is folded into G5. |
| R6: reporter source exemption | Line 168: no pins or cap while report protection holds; verified from stored provenance/status in the same transaction; not claimable through input. Gate 5 covers more than 1,024 reads. | **Resolved.** |
| R7: fixtures | a: `Report.test` forwards and returns `artifacts` (line 230). b: `runId`, `attemptId`, `invocationPath` and `revision` options, with defaults; sequences assigned at seeding (lines 183–187). c: bijection and uniqueness checks (line 206). d: threading recipe, collision error naming it, corrected "unchanged" claim (lines 189, 204, 208–224). e: owned copies, fresh chunks, freezing (line 228). f: first writer's catalogue. | **Resolved, with one wording fix.** [Fact] On f, draft 2 is _more_ accurate than R7f was. `lake.ts:290-302` throws `Conflict` when a later writer's `fieldsJson`, kind or content type differs; the `INSERT OR IGNORE` only runs after that check. "Reject conflicting subsequent writers as production does" is correct. **Wording:** line 185, "key = artifact ID", can be read as the 64-hex lake artifactId, which would be circular. Write "key = the definition's `id`" if that is meant. [Fact] `test-run` is the existing `Task.test` runId (`task.ts:710`), so line 230's handoff rule holds. |
| R8: identifier echo | Line 112. | **Resolved.** It covers structured fields, not just messages. |
| R9: pushdown invariants | Lines 158–162. | **Resolved.** [Fact] Draft 2 says the optimization exists. `lake-query-candidates.ts` matches the invariants: it descends only through `And`, never into `Or` or `Not`; it pushes only `Eq` with a well-formed, NUL-free _string_ value, so `Eq null` and non-strings stay on the evaluator; tag keys are bound parameters against `lake_query_tags`, never JSON paths; the clause goes into the outer `WHERE` (`lake-query.ts:296`), not the latest `NOT EXISTS`. `In` is not pushed, which the "may narrow" wording permits. This check is of the existing query optimization, not of any reader. |
| R10: reason mapping | Lines 122–135. | **Resolved.** Terms/depth → `InvalidQuery`; pagination `Conflict` → `InvalidCursor`; `LimitExceeded` on a row, page or cursor → `QueryBudget`; legacy kind/contentType defaults; Busy after retry. |

## 2. Grouped admission: what holds, and what the probes found

### 2.1 The claim that holds

Within one invocation, the first operation waits while holding no reader slot. Later operations attach to the same pending or held slot instead of requesting another. The invocation therefore never holds one global reader slot while waiting for a second. Local overflow fails fast with `ConcurrencyLimit`, so nesting deeper than four cannot self-deadlock on a local wait.

The 32 execution slots (`execution-resources.ts:50`) and the report semaphore (`:92`) are always taken before a handler runs and never while holding a reader slot. That ordering is consistent, so those pools add no cycle. This assumes that remains true; see the G3 proof gate.

### 2.2 Probe results

Stand-in: `grouped.ts`. It uses an explicit FIFO hand-off pool and a per-invocation state machine (`Idle | Pending(deferred, n, acquirer) | Held(n) | Closed`), with the acquirer fiber forked into the invocation scope.

| # | Scenario | Result |
| --- | --- | --- |
| G1 `barging.ts` (real `Semaphore`) | Is Effect 4.0.5 `Semaphore` FIFO? | **No.** B queued first, then A released and C arrived in the same step: C ran before B. In a loop, a newcomer re-took a just-released permit 1,000 times in a row ahead of a parked waiter. [Fact] `Semaphore.ts:217-233,267-278`: waiters are a `Set` woken by a deferred `scheduleTask`. A woken waiter that finds no permit re-enters at the _tail_. |
| a | Five simultaneous initial operations in one invocation, pool exhausted | Four coalesced into one pending acquisition (`n=4`) and the fifth failed `ConcurrencyLimit`. All four ran on one global grant: `maxGranted=1`, final state `Idle`, permit returned. |
| b′ | Group leader interrupted while a follower is coalesced and another invocation B is queued behind | Follower admitted, then B. The group kept its FIFO position because the acquirer is invocation-owned, not leader-owned. |
| c | All waiters interrupted while pending, 300 iterations with varied race windows around the grant | **0 leaked permits, 0 over-grants.** A grant that races the last waiter's interruption is handed on. |
| d | Six invocations × 400 operations at local concurrency 3, pool of 2, with releases and acquires interleaved in the same tick | **0 violations** of "state `Held` ⇔ holds one global slot". `maxGranted=2`. All states ended `Idle` with the pool fully free. Last-release/new-acquire is safe because both transitions are synchronous; a new acquire after a release re-queues at the tail. |
| E′ | Invocation A holds the only slot and B is queued; A nests four deep, then tries a fifth | Depth 4 succeeded with no global wait. Depth 5 failed `ConcurrencyLimit`. B was admitted afterwards. |
| f | Invocation close while an operation is pending | Waiter failed `Closed`, a later lease failed `Closed`, permit returned. |
| N `grouped-naive.ts` | The same machine, with the wait inside `Effect.acquireRelease`'s acquire | **`Fiber.interrupt` on a queued waiter blocked for more than 200 ms, until a slot was granted.** In 4.0.5 the acquire runs uninterruptibly. A fiber forked from that region also inherits uninterruptibility. |
| J | Twenty JSON gets via `forEach(..., { concurrency: "unbounded" })`, raw I/O synchronous (stand-in), using the draft's rule | Idle daemon: **20 ok.** Another invocation holding the slot for 20 ms: **4 ok, 16 `ConcurrencyLimit`.** The same code fails permanently depending on unrelated load. |
| W | Stand-in reader pool (1) and writer `Semaphore` (1). P: `publish(B, reader.stream(A))` takes the writer first, then the source pulls a reader slot. Q: holds `reader.stream(C)`, and per chunk publishes a bytes artifact. | **Deadlock** (no progress for 300 ms; in production, until the attempt timeout). [Fact] `lake-binary.ts:256`: `publish` takes `permits.withPermits(1)` (pool of 4) _before_ consuming the author's source stream. |

## 3. Required corrections (smallest form)

### G1. Make FIFO true, or drop the word [Required]

Replace "FIFO admission applies to invocation slots" with:

> Invocation slots are granted strictly in arrival order by a dedicated hand-off queue. A released slot goes directly to the head waiter and never returns to the free count while anyone waits. A waiter interrupted after being granted passes the slot to the next waiter. Effect's `Semaphore` is not used for this pool, because it permits barging.

Alternatively delete "FIFO" and state "no fairness guarantee". The reviewer recommends the hand-off queue: without it, a busy run's steady re-acquisitions can starve another run's single read until its attempt timeout (G1 probe).

### G2. Specify coalescing and ownership precisely [Required]

Add one paragraph. Its content is what the stand-in proved:

- **States and limit.** Per-invocation state is `Idle | Pending | Held | Closed`. The local limit counts _reservations_: pending plus held operations. A fifth reservation fails `ConcurrencyLimit` immediately, including while the group is still pending.
- **The acquirer.** The first reservation creates the pending group and one acquirer fiber, owned by the invocation lifetime rather than by the first caller. Later reservations await the same grant, so interrupting the leader does not lose the group's queue position.
- **Interruption while pending.** An interrupted pending reservation decrements the count. When it reaches 0, the acquirer is interrupted and the state returns to `Idle`. A grant that races that interruption returns the slot to the pool.
- **Release.** Each held operation's release is a synchronous finalizer in that operation's Scope. When the last one releases, the state goes `Held(1) → Idle` and the global slot is handed off in the same step. A later acquire starts a new pending group at the tail.
- **Close.** Invocation close fails any pending group with `Closed`, returns a held slot, and makes later leases fail `Closed`. Operation finalizers that run afterwards are no-ops.
- **Implementation constraint.** The wait must not sit in `Effect.acquireRelease`'s acquire: it is uninterruptible in Effect 4.0.5. The acquirer, forked from a masked region, must explicitly reopen interruptibility for the wait only. Register the release finalizer in the same uninterruptible step that observes the grant.

Proof gate 4 should name: simultaneous first acquisitions, leader interruption, interruption racing the grant, last-release/new-acquire, and close while pending.

### G3. Order reader slots against binary writer permits [Required: fix or user decision]

The rule "never wait for another global slot while already holding one" must cover the existing writer pool. Probe W is a two-pool cycle. Any eight invocations (four holding each pool) can hit it, and the attempt timeout is the only thing that breaks it. Choose one of these and state it:

- **(a) Writer before reader [reviewer's preference].** An invocation that holds a reader slot or reservation never _waits_ for a writer permit. If none is immediately available, the bytes publish fails with a typed, retryable outcome. Writer holders may wait for reader slots. This keeps the common copy pipeline `storage.publish(B, reader.stream(A).pipe(...))` waiting rather than failing. What fails fast under writer saturation is a bytes publish started while that invocation already holds an open read. **This needs a publish-side error decision.** Today publish surfaces `TaskRuntimeError`, which `retry.when` cannot select by a declared tag. It must either fail as `ArtifactUnavailable{Busy}` (widening publish's error type for reading invocations) or be accepted as a host failure.
- **(b) Reader before writer.** A reader reservation made while the invocation holds a writer permit and no reader slot must not wait: it takes a free slot immediately or fails `ArtifactUnavailable{Busy}`. This needs no publish-side change, and the error is already a reader error that surfaces through the source stream's E. But the copy pipeline above then fails Busy whenever reader slots are saturated.

Whichever is chosen is public semantics and goes in the user decision list. Proof gate 4 should run probe W's two shapes against real `createBinaryStorage` and require either progress or the chosen typed failure, never a stall to the attempt timeout. It should also assert that no reader slot is ever held while waiting for an execution slot or the report semaphore.

### G4. JSON `get` should take no content slot [Required, conditional]

[Fact] The JSON read is one synchronous `readFileSync` of at most 1 MiB (`lake.ts:401`). A slot held only for a non-yielding step bounds nothing that the single JS thread does not already serialize. Yet the slot is what makes coalesced waiting overlap, and that produces probe J's load-dependent permanent failure. It also forces microsecond JSON reads to wait behind four long-running streams anywhere on the daemon. Smallest wording:

> JSON `get` takes no content slot while its authorized raw read, length and digest verification run as one synchronous, non-yielding step of at most 1 MiB. If an implementation makes that step asynchronous, JSON `get` takes a slot like `bytes` does, and pending JSON gets do not count toward the local limit. Only `stream` and `bytes`, whose leases span yields, count toward the four-operation limit and can fail `ConcurrencyLimit`.

This also supersedes R3. The harness mirrors this: local limit counted over `stream`/`bytes` only.

### G5. Ordering inside an operation [Required: precision]

State the order as: authorize → pin (immediate transaction, with ≤250 ms retry sleeps outside it) → content lease → I/O. Never hold a content lease across pin retries. Otherwise a contended pin keeps a scarce slot for up to 250 ms and creates the overlap that turns into `ConcurrencyLimit`. `metadata` and `latest` take no lease, as drafted.

## 4. Unavoidable public semantics to surface to the user

These follow from any bounded global admission and should be in the decision list, not hidden:

1. **Waiting is charged to the attempt timeout.** Under sustained saturation, a reading task fails with the existing timeout outcome, not with `Busy`. Authors retry on timeout policy, not on `ArtifactUnavailable`.
2. **No preemption.** An invocation keeps its slot while it holds at least one stream or bytes lease, including a stream held open by a task-local Layer across the handler. Four such long-lived readers block all other stream/bytes reads daemon-wide for their duration; G4 exempts JSON. The bound is per-attempt time, not fairness.
3. **Re-queue on idle.** When an invocation's last lease closes, its next stream/bytes read re-enters at the tail. Sequential stream/bytes loops pay queueing latency per item under contention. This is the price of not holding slots across idle periods.
4. **Fan-out shape.** More than four _concurrent_ stream/bytes operations in one invocation fail permanently with `ConcurrencyLimit`, whatever the load. That includes a Layer's open stream and handler reads combined. Authors bound Stream/Effect concurrency to at most 4. After G4, this no longer depends on cross-run load.
5. **The G3 choice**, as written above.
6. **The harness** mirrors the local limit but has no global queue, so tests cannot reproduce queueing or timeouts from saturation. This should be documented as a harness boundary.

## 5. Proof-gate additions (append to gate 4)

1. A stand-in-free version of probes a, b′, c, d, E′ and f against the real reader admission. Include FIFO order across three invocations, with a newcomer arriving in the same tick as a release.
2. Probe J with the real reader: unbounded JSON fan-out succeeds both idle and saturated. Five concurrent streams fail `ConcurrencyLimit` both idle and saturated.
3. Probe W against real `createBinaryStorage` under the chosen G3 rule.
4. Interrupting a task queued for a reader slot completes promptly, without waiting for a grant (probe N regression).

## 6. Decisions that remain the user's

These are unchanged from round 2, with the permit item refined:

1. The retention amendment.
2. The first-access boundary.
3. Harness alias and identity behaviour.
4. The grouped admission policy itself: 4 × 4, attempt-timeout semantics, no preemption, and the G3 cross-pool choice.

Reviewer status: **R1–R10 approved as resolved. Grouped admission: request changes G1–G5.** The concurrency core is sound once G1–G5 are written in. Approval then requires only a check of those paragraphs.
