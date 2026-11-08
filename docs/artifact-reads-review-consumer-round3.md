# Artifact reads: consumer design critique, round 3

Reviewer: Claude, reviewing through the consumer and developer-experience lens, with Effect checks where they affect consumers. This is a narrow re-review of the frozen [draft 2](artifact-reads-api-draft.md), checked against [consumer round 2](artifact-reads-review-consumer-round2.md), [Effect round 2](artifact-reads-review-effect-round2.md), the [evidence](artifact-reads-evidence.md) and current source.

**This is reviewer feedback, not user approval.** `ArtifactReader` is neither approved nor implemented. The lake-query candidate optimization, which passed 356 tests, is a separate internal change. It is not evidence for any reader behaviour below. No production files, other docs or commits were changed. I ran no repository tests.

Labels:

- **[Fact]**: read from source in this checkout.
- **[Probe]**: run for this review outside the checkout against pinned Effect 4.0.5 and the real core SDK modules. Every reader, permit manager or error class inside a probe is a **labelled stand-in**, not SDK code.
- **[Correction]**: an exact, small text change I ask for before presentation.
- **[Advisory]**: optional.

Probe directory: `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/721535d8-0614-46e1-98c6-6b0d8be280ad/scratchpad/`. It contains `permits/probe.ts`, `permits/probe2.ts`, `permits/fifo.ts` and `types/existing.ts`.

## Verdict

**C1–C6 are resolved. The draft is presentable once five precise corrections are made.** I am not reopening any accepted method, error tag, the first-access decision or the fixture design.

I preserve my round-2 withdrawal of admission pins. No new evidence changes it.

The grouped permit policy is a real improvement over fail-fast `Busy`. It lets ordinary cross-run contention queue instead of failing. As drafted, though, it has one consumer-visible defect and two implementation traps:

- **P1:** `ConcurrencyLimit` can depend on load. The same `forEach(…, { concurrency: 8 })` of JSON `get`s succeeds on an idle daemon and fails when the global slots are busy. The harness cannot reproduce this. My own round-2 C4 asked for local fail-fast, so I am revising my own suggestion.
- **P2:** "Further operations share that slot" fails if the first waiter's fiber owns the acquisition and is interrupted. Its siblings then hang.
- **P3:** Effect 4.0.5 `Semaphore` is **not FIFO**. A newcomer can take a released permit ahead of a queued waiter.

§3 gives one small amendment that fixes P1 and keeps everything else in the policy.

| # | Correction | Area |
| --- | --- | --- |
| K1 | A default `committedAt` must follow the preceding row, not `epoch + sequence`. Reject an explicit timestamp that would invert a version history. | Fixtures |
| K2 | New synthetic **digest** aliases must also avoid seeded aliases, not only artifact IDs. | Fixtures |
| K3 | Local over-subscription waits when it can make progress. It fails `ConcurrencyLimit` only when every in-flight local operation is an open stream. | Permits (P1) |
| K4 | The invocation, not the first caller, owns the pending global acquisition. FIFO needs an explicit handoff queue, not a bare `Semaphore`. | Permits (P2, P3) |
| K5 | Make the claims honest: waiting can end in an attempt timeout; slots are leases held while any operation overlaps; buffered memory is 16 × 16 MiB. | Permits |

---

## 1. Verification of C1–C6 and the named items

| Item | Draft 2 text | Result |
| --- | --- | --- |
| **C1** fixture metadata | `runId`, `attemptId`, `invocationPath` and `revision` options with stated defaults. Sequence follows seeding order, then publication order. Default `committedAt = epoch + sequence ms`. A higher version must come later (§Testing contract). | **Resolved**, with one gap: mixing explicit and default timestamps can still invert order (K1). |
| **C2** `Report.test` | Gains `artifacts`, forwards it to `Task.test` and returns the result's artifacts. The `test-run` handoff rule is stated. | **Resolved.** [Fact] `report-test.ts:217-220` is the one call site to extend. `Report.test` already returns the `Task.test` result, so `artifacts` reaches the caller without a new shape. |
| **C3** identity mapping and fan-in | Lake formula over principal `test-owner`. Both directions of identity ↔ artifactId are enforced. Mixed references are harness-only. Collision errors name the threading remedy. Default-identity errors name keys or versions. Threading example given. | **Resolved**, with K2 for digest aliases. `test-owner` differs from the production principal `owner` ([Fact] `control-plane.ts:311`), so fixture IDs can never be mistaken for production IDs. That is desirable; state it in one clause. |
| **C4** permits | Replaced by grouped admission. | **Changed design**, evaluated in §3. |
| **C5** reporter cap exemption | Same-run point 1: exempt "while their report protection holds", verified from stored provenance and status in the pin transaction. Gate 5 tests more than 1,024 reads. | **Resolved.** [Correction, wording only] Add: "Otherwise the read is an ordinary external read: it pins and counts." This rules out reading "exempt only while protected" as "fails when not protected". |
| **C6** acquire before wait | Recipe given with the honest caveat that reclamation can win before Acquire runs. Gate 4 included. | **Resolved.** [Probe] The existing-API skeleton typechecks (§4). |
| Reporter fixture example | Fixture with explicit `runId: "source-1"`; `Report.test` with a `source` matching `Report.sourceOf(Collect)`. | **Correct against existing APIs** (§4). Advisory: `revision: "fixture-revision"` in `source` is unrelated to the fixture's default `revision` metadata. Use `"r1"` to avoid implying a link. The reporter reads one page (default limit 50). That is honest ("on this page"), but a production reporter would page with `ArtifactQuery.stream`. |
| Metadata defaults | All `Record` fields are covered. `bytes`, `kind` and `contentType` come from the definition and content. | **Resolved.** |
| Independent-producer recipe | Thread `first.artifacts` into the second `Task.test`. | **Resolved.** Needs K2 so the second harness's `test-digest-N` does not reuse the first's. |
| First access before wait | Point 3 plus the recipe. Admission pins stay rejected. | **Resolved.** My withdrawal stands. |

## 2. Fixture reference semantics

The draft's model is coherent:

- An exported reference is preserved byte for byte.
- Metadata (sequence and defaulted `committedAt`) is recomputed deterministically by each harness.
- "The fixture reference is independent of these metadata defaults."

Because threading preserves array order, a row keeps the same sequence across a handoff unless the author reorders or prepends fixtures. That is acceptable, and the draft already states array-order seeding. Two precise gaps remain.

**K1. Mixed timestamps.** Take an explicit `committedAt: "2026-01-01T…"` for v1 and a defaulted v2. The default gives v2 `1970-01-01T00:00:00.002Z`, so `orderBy committedAt desc` returns v1 first. That is the inversion C1 was meant to prevent, now caused by mixing. Replace the default sentence with:

> A default committedAt is one millisecond after the preceding seeded or published row's committedAt (epoch + 1 ms for the first row). Seeding fails if a higher version of the same artifactId has an earlier committedAt than a lower version.

This remains deterministic, needs no wall clock, and keeps the "explicit vs defaulted" flag meaningful.

**K2. Digest-alias allocation.** The draft says to "allocate new synthetic IDs without colliding with seeded fixture IDs". It also enforces uniqueness of `(artifactId, version) ↔ alias`. Today the digest alias is `test-digest-${publications.length + 1}` ([Fact] `task.ts:616-617`, `:690-691`), which restarts at 1 in every harness. In the draft's own threading example, the second harness would mint `test-digest-1` for `test-artifact-2`, and the bidirectional check would reject it. Replace with:

> Allocate new synthetic artifact and digest aliases after the highest seeded alias of each kind.

Without fixtures, references stay `test-artifact-1` and `test-digest-1`, so compatibility is unchanged.

The remaining semantics are fine, and I note them for the user rather than as defects:

- A seeded identity plus an in-test publish gives a mixed reference: hashed artifactId, synthetic digest, version k+1. This is harness-only and stated.
- Combining a hashed `Artifact.fixture` with an exported synthetic reference for the same `(taskId, output, key)` is rejected. Authors must pick one source for each identity. The error should say "this identity was already seeded from another source".

## 3. Grouped permit policy

### 3.1 What it gets right

- Cross-run contention now **queues** instead of failing. That was the core of my C4 and the Effect review's R4.
- Nested reads within one invocation never wait for a second global slot, so there is no global hold-and-wait.
- JSON releases capacity before decoding, as Effect R3 asked. Metadata and query take no slot.
- Separating CLI downloads and writers is right.

### 3.2 P1: `ConcurrencyLimit` is load-dependent under the draft rule [Probe]

`permits/probe2.ts` models the draft with a labelled stand-in: one global pool of four invocation slots, at most four local operations, and a fifth fails. Each case runs `Effect.forEach(8 rows, get, { concurrency: 8 })`:

| Global slots                | JSON-like synchronous I/O | Asynchronous I/O   |
| --------------------------- | ------------------------- | ------------------ |
| Idle                        | **success**               | `ConcurrencyLimit` |
| All four held by other runs | **`ConcurrencyLimit`**    | `ConcurrencyLimit` |

On an idle daemon the first `get` takes the slot synchronously and finishes its synchronous I/O before the next fiber runs, so operations never overlap. When the slots are busy, the first `get` suspends. Operations 2–4 join it as "sharing" waiters, and operation 5 fails. A "permanent" error then appears only under production load.

The harness has no global contention, so tests pass. This is the "load becomes failure" problem C4 removed, back in a narrower form. (If the acquisition always suspends, the failure becomes deterministic. Whether it does is an implementation accident that should not decide the contract.)

`ConcurrencyLimit` exists for one case: an invocation that cannot make progress without itself, for example a fiber holding four open streams and asking for a fifth read. That is the only deadlock-shaped case. `get` and `bytes` finish without the caller's help: JSON decoding runs after release, and admission is finite.

**K3 [Correction].** Replace "Exceeding four concurrent operations within one invocation fails permanent ConcurrencyLimit" with:

> An operation that finds its invocation's four local operations in use waits interruptibly, without taking another global slot, if at least one in-flight local operation is a `get`/`bytes` read or is waiting for admission; those complete without the caller. If all four are open streams, it fails permanent ConcurrencyLimit immediately. Local waiters are served before the slot is released.

The same probe with this rule (`permits/probe.ts`, "amended"):

- The eight-way fan-out succeeds in all four cells.
- Four open streams plus a `get` fails `ConcurrencyLimit` at once, without hanging.

The amended failure depends on how the author's code holds streams, not on daemon load. The harness's four-operation mirror therefore reports it faithfully.

**Consumer effect:** the common patterns `forEach(rows, get, { concurrency: n })` and `ArtifactQuery.stream(...).pipe(Stream.mapEffect(get, { concurrency: n }))` work for any `n`. They are throttled to four, which matches how authors already think about Effect concurrency. The surprising number only shows up for authors who hold several streams open at once.

If the user keeps the draft rule instead, the docs must say: "Never run more than four reader operations concurrently in one invocation, including one open stream plus its nested reads. An excess may fail only under load." Proof gate 4 must then test the busy-daemon case, because the harness cannot.

### 3.3 P2 and P3: acquisition ownership and FIFO [Probe]

**P2.** In `permits/probe.ts` case C, the stand-in's first `get` takes the global slot on its own fiber while a sibling waits on the shared pending acquisition. Interrupting the first `get` means the sibling **never acquires**: it times out at 200 ms. When an invocation-owned fiber runs the acquisition and hands it to the remaining waiters, the sibling succeeds. Waiting counts against the attempt deadline, so a lost wakeup turns into a confusing timeout.

**P3.** In `permits/fifo.ts`, after `Semaphore.release`, a newcomer's `take` or `takeIfAvailable` in the same step gets the permit while an already-queued waiter stays blocked. [Fact] `node_modules/effect/dist/Semaphore.js:45-92`: release schedules the waiter wakeups as a task, and `take` re-checks `free` synchronously, so barging is possible. The draft's "FIFO admission applies to invocation slots" is therefore not met by a bare `Semaphore`. The existing writer permit (`lake-binary.ts:223`) is not FIFO either, which is fine there because it promises nothing.

**K4 [Correction].** Add:

> The pending global acquisition is owned by the invocation's read lifetime, not by the first caller; interrupting one waiter neither cancels nor strands the others, and the request is withdrawn only when no local waiter remains. FIFO admission uses an explicit queue with direct handoff on release.

Proof gate 4 should include "interrupt the first waiter; siblings still admit" and "a later arrival never overtakes a queued invocation".

### 3.4 Fairness and consumer-visible limits

**K5 [Correction, wording].** The draft claims grouped admission "avoids ordinary cross-run load causing task failures". This needs three honest qualifiers.

1. **Timeouts.** Waiting counts against the attempt deadline. A task with a 30 s attempt timeout queued behind four long-running streaming reporters fails with a timeout. Write:

   > avoids immediate failures from cross-run load; a waiter still times out if slots stay held beyond its remaining attempt deadline.

2. **Slots are leases.** A slot is released only when the invocation's last operation ends. An invocation whose operations overlap continuously (a `concurrency: 4` loop, or a long stream with nested gets) keeps its slot until the loop finishes.

   [Probe] In `permits/probe.ts` case D there are four such fan-outs (40 reads of 5 ms each at concurrency 4). A single `get` from a fifth invocation waited **66 ms of the fan-outs' 69 ms total**, which is nearly the whole run rather than one 5 ms operation. Under contention, a sequential reader gives up and re-queues its slot on every read, while a fan-out reader keeps its slot. Concurrent readers are favoured.

   This is the price of avoiding nested-read deadlock, and I think it is acceptable: the alternative of yielding mid-overlap reintroduces self-deadlock. But it must be stated:

   > Slots are leases held while any of the invocation's content operations is in flight; FIFO applies when a slot is free, not as per-operation round-robin.

3. **Memory.** Live operations rise from 4 to 16. `bytes` buffers up to 16 MiB, so worst-case reader buffering is 256 MiB, not 64 MiB. Say this next to "bounds live content operations at 16".

[Advisory] Queued reads are invisible. An operator seeing a run in `Running` cannot tell it is waiting for read capacity. A span attribute or progress note such as "waiting for artifact read capacity" would help, and it adds no public API.

### 3.5 Nested-read usability summary

| Pattern | Draft rule | With K3 |
| --- | --- | --- |
| Sequential `get` loop | Works. Re-queues for every read under contention. | Same |
| `forEach(get, { concurrency: 8 })` | Load-dependent `ConcurrencyLimit` | Works, throttled to 4 |
| `stream` with nested `get` per chunk | Works up to 3 concurrent nested reads | Works for any concurrency |
| Four open streams plus another read | `ConcurrencyLimit` | `ConcurrencyLimit` (deterministic) |
| Reading in Layer acquisition, then the handler | Same invocation and slot | Same |
| Eight parallel graph tasks | Four admitted, four queue | Same |

## 4. Examples against existing APIs [Probe]

`types/existing.ts` compiles the draft's three examples with `tsc` under the repository's tsconfig, importing the real `packages/core/src/index.ts`. The reader calls, `Artifact.fixture` and `artifacts` options are replaced by stand-ins, and the two error classes are stand-in `Schema.TaggedError`s. The file **typechecks cleanly**. That confirms these parts:

- `Artifact.make` with `fields`, `storage.publish(def, value, { key })` and `Task.make` with `outputs`.
- A union error schema as a task and workflow `error`, and `retry.when: ["ArtifactUnavailable"]` narrowing.
- `graph.input(Inventory.refSchema)`, and `graph.approval` with `after: [held]` followed by `graph.task(…, { after: [approval] })`.
- `Report.sourceOf(Collect)` with `Report.result(Schema.Int)`, and a `Report.test` `source` literal (`targetKind: "task"`, `targetId: Collect.id`, `targetVersion: 1`).
- An `outcome.value` holding a reference type.
- `Application.make(...) satisfies Application.Application<never>` with these tasks and workflows.

**Unimplemented, and not checked:** `ArtifactReader` and its methods, `ArtifactReadError`/`ArtifactUnavailable` as SDK exports, `Artifact.fixture`, `Task.test`'s and `Report.test`'s `artifacts` option and result field, and `ArtifactQuery.stream`. Requirement exclusion of `ArtifactReader` from `Task.make`'s R, which the Application `never` check depends on, is also unimplemented. It remains Effect round-2's pending item.

The draft already labels each snippet "proposed / not typechecked". Keep those labels.

## 5. Remaining user decisions

Nothing below is approved by any review round.

1. A separate `ArtifactReader` with six methods, plus the `ArtifactQuery.stream` helper.
2. Explicit `latest(taskId, output, key)`, and its schema-change behaviour next to the query omission.
3. `versions` required; `limit` default 50, maximum 200.
4. Two explicit error tags, with no implicit widening.
5. First-access protection plus the acquire-before-wait recipe, instead of admission pins.
6. The retention amendment: report-source protection, the reporter cap exemption, 1,024 external pins per run, and operator `protectedBy` counts and `protection` details.
7. **The permit policy**, which is the only newly changed design:
   - four reading invocations, each with four local operations;
   - K3 local waiting versus the draft's fail-fast `ConcurrencyLimit`;
   - acceptance of lease-style fairness and 256 MiB worst-case buffering.
8. `bytes` (verified) next to `stream` (verified only at EOF).
9. The fixture contract:
   - synthetic aliases preserved and accepted only by the harness;
   - the `test-owner` principal;
   - threading instead of merging;
   - default identity errors instead of digest-derived keys (my round-2 R7 was not adopted; that is a valid choice, but the user should see it);
   - K1 timestamp ordering.
10. Rebuild and compatibility: regenerated host loaders, and older daemons refusing the application.

## 6. Proof-gate deltas

- **Gate 4:**
  - The eight-way JSON fan-out succeeds while all four global slots are held elsewhere (K3).
  - Four open streams plus a read fails `ConcurrencyLimit` immediately.
  - Interrupting the first waiter still admits its siblings (K4).
  - A later arrival never overtakes a queued invocation (K4).
  - A waiter whose deadline expires in the queue fails with the attempt timeout and leaves no slot or waiter behind.
- **Gate 10:**
  - An explicit-then-defaulted history orders correctly (K1).
  - A seeded-history inversion is rejected (K1).
  - The threaded second producer mints `test-artifact-2` and `test-digest-2` (K2).
