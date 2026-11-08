# Artifact reads: Claude Effect design re-review, round 2

Status: focused Effect-perspective re-review of [consolidated draft 1](artifact-reads-api-draft.md). **This is reviewer approval at most, not user approval.** No artifact-read API is approved and no implementation is authorized. The draft was treated as frozen. Predecessors: [Effect round 1](artifact-reads-review-effect-round1.md) and [consumer round 1](artifact-reads-review-consumer-round1.md). Evidence base: [research](artifact-reads-research.md) and [parent probes](artifact-reads-evidence.md).

Labels:

- **[Fact]**: read from source in this checkout. File references are given.
- **[Probe]**: executed for this review outside the checkout, against pinned Effect 4.0.5, bun:sqlite and the real SDK modules. Any reader, fixture, pump or error class in a probe is a **labelled stand-in**, not SDK code.
- **[Required]**: a correction that must be in draft 2 before this reviewer's conditional approval holds.
- **[Advisory]**: recommended, but not blocking.

Probe scripts are in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/41ce7b45-3435-4da3-bfce-910c1b92199e/scratchpad/probe/`. Production files were not edited. The full repository suite was not run.

## Verdict

**Conditional Effect approval.** The draft's deliberate changes are sound from an Effect perspective:

- six reader methods, with `ArtifactQuery.stream` as an ordinary helper;
- explicit domain errors, without widening `Task.make` E;
- first-access pins and report-obligation protection;
- the shared harness store.

The approval holds only after the ten corrections in §3 are made. Five of them close real holes:

- **R1:** codec defect text can leak through an interrupted cause.
- **R2:** a closed stream can end as a silently truncated _success_.
- **R3 and R4:** content permits are held during author decoding. Fail-fast admission also turns ordinary fan-out into failures.
- **R6:** reporters can hit `PinLimit` on data that is already protected.
- **R7:** `Report.test` cannot receive fixtures, and fixtures cannot set `runId`.

The other corrections are precision fixes. None of them shrinks scope. JSON, bytes, streams, latest, queries, durability and the two-test handoff all stay in.

The user still has to approve the retention amendment, the permit policy (R4) and the test-harness reference behaviour. Neither review round grants those.

## 1. Verified source facts behind the deliberate changes

| Claim in draft | Result | Evidence |
| --- | --- | --- |
| A task-local Layer's declared domain errors stay typed through `taskLayer`; undeclared ones die. | **Confirmed.** | `task.ts:180-196` fails when `Schema.is(errorSchema)(error)`, and dies otherwise. In probe `layer.ts`, a stand-in `ArtifactUnavailable{Busy}` declared in `error` came back as a typed `FAIL`. With `error: Schema.Never` it came back as `DIE`. |
| `Task.make` E need not widen. | **Confirmed.** | `task.ts:463-473`: handler E is `S["error"]["Type"] \| TaskRuntimeError`. Probe `types.ts` (tsc, repo tsconfig) compiles a reader handler with `error: Schema.Union([ArtifactReadError, ArtifactUnavailable])` (stand-in classes). It also compiles a graph node with `retry.when: ["ArtifactUnavailable"]`. |
| Retry is by declared `_tag` only. | **Confirmed.** | `interpreter.ts:350-371`. |
| Requirement exclusion must grow. | **Confirmed, still pending.** | In probe `types.ts`, `Definition<…, ArtifactReader>` is inferred and assigning it to `Definition<…, never>` is an error. All five `Exclude<…, Tag.Values \| ArtifactStorage \| History>` sites (`task.ts:119,384,455-457,473,544,568`) must add the reader. A named union is still advised. |
| Latest = newest _retained_ version of the identity, selected before the predicate, with no fallback to an older schema. | **Confirmed.** | `lake-query.ts:288-294`: the `NOT EXISTS newer` subquery is scoped by principal and artifactId with `reclaimedAt IS NULL` and no schema filter. The outer filter applies `schemaId/schemaVersion`. Identity is `sha256(canonical([principal, taskId, output, key]))` (`lake.ts:314-316`), and runtime `taskId` is the contract id (`interpreter.ts:83`, `application.ts:183`), so `Collect.id` is correct. |
| Same run includes graph branches and child workflows. | **Confirmed.** | A child invocation reuses the run and only extends the permits (`interpreter.ts:837`). |
| Report statuses WaitingSource, Queued, Running and NeedsAttention are unsettled, and arming precedes dispatch. | **Confirmed.** | `report-record.ts:15-24`. Root reports are armed in the run-insert transaction (`report-sources.ts:124-140`, `host-store.ts:643`). Invocation reports are armed when the invocation is registered (`host-store.ts:1373`). `records.arm` inserts `WaitingSource` rows immediately (`report-records.ts:241`). The run→record status mapping sends `Cancelling` to `Running` (`report-records.ts:66-89`), so bulk cancellation keeps protection until settlement. Report runs use the source root's principal (`report-records.ts:58-64`, `host-store.ts:1487-1510`). |
| Pin and apply transactions. | **Partly confirmed; see R5.** | Lake `commit` and reclamation `apply` both use deferred `database.transaction(...)()` (`lake.ts:214`, `lake-reclamation.ts:572`). Host, lake and engine are three connections to one file (`host.ts:18-26`, `engine.ts:31` uses `SqliteClient`), and none sets `busy_timeout`. |
| Draft's six error-reason coverage | **Incomplete; see R10.** | Existing lake codes `LimitExceeded` (`lake-query.ts:111-116,355-359`, `pagination.ts:83-87`) and pagination `Conflict` (`pagination.ts:62`) have no stated reason mapping. |

## 2. Probes run for this review

| # | Question | Result |
| --- | --- | --- |
| C1 `codec.ts` | Does mapping a decode exit to `DecodeFailed` in the same fiber hide text? | Yes for schema failures, synchronous throws, async `Effect.die` and codec self-interruption: all four became sanitized `DecodeFailed` with no secret. External interruption of a slow async codec stayed an interruption. |
| C2 `mixed.ts` | Is "preserve interruption" safe with `catchCause` in the same fiber? | **No.** Interrupting a codec whose `onInterrupt` dies with `secret=hunter2` produced a cause containing the secret. This held both for `failCause(c)` and for the "clean" `Effect.interrupt` branch. The interrupted fiber's own cause accumulates the finalizer defect. |
| C3 `isolated.ts` | Decode in a detached child, then `Fiber.await` (not `join`) and map the exit. | External interruption gave an interrupt-only cause with **no secret**. A defect or self-interrupt became `DecodeFailed`. |
| C4 `logs.ts` | Does Effect log a discarded child's defect? | No. Nothing was captured at `MinimumLogLevel: "All"` with a custom logger. |
| P1 `pump.ts` | What does a consumer see when the owner interrupts a bounded-queue pump? | `Queue.end` gave the consumer **success with 20 bytes (silent truncation)**. `Queue.shutdown` gave an interrupt cause in a fiber nobody interrupted. Only `Queue.fail(Closed)` produced the intended typed failure. |
| S1 `sqlite.ts` | Two connections; a host write lands between apply's protection check and its tombstone. | Deferred apply failed with `database is locked` (safe). Immediate apply blocked the host write instead, and no protected row was reclaimed. |
| Q1 `pushdown.ts` | Pushing `runId` equality into the outer `WHERE`, with 20,000 unrelated rows. | The result preserved latest-before-filter. SQLite used the partial expression index, and the `NOT EXISTS` probe used `UNIQUE(artifactId, version)`. Also pushing the predicate _into_ `NOT EXISTS` produced the wrong (latest-after-filter) result. |
| T1 `types.ts` | Fixture typing (stand-in `Fixture<A>` with a phantom artifact and `.reference`). | `Fixture<typeof Inventory>` and `Fixture<typeof Archive>` are assignable to `readonly Fixture[]`. A wrong JSON value and an Archive ref used as an Inventory input are rejected. |

## 3. Required corrections (smallest form)

### R1. Codec isolation: wording and mechanism [Required, security]

The draft says to map "Both Schema failures and codec defects … to safe DecodeFailed; preserve external interruption." C2 shows that doing this inside the reading fiber can still leak defect text. The leak path is an interrupted fiber's cause. If lifetime close interrupts the reader child, `lifetime.run` re-raises that cause through `Fiber.join` (`publication-lifetime.ts:82`).

Specify the following:

- Decode runs in a lifetime-owned child.
- The reader waits on it with `Fiber.await`, never `Fiber.join`, and maps the exit:
  - success → the value;
  - any other exit, including the codec's own interruption → `DecodeFailed`;
  - lifetime already closed → `Closed`.
- External interruption of the caller interrupts the child and **discards its exit**. The caller then ends with a clean interruption (C3).
- The same rule covers every reader body that runs author code or could carry defect text. Do not reuse `lifetime.run`'s join path for reads.

C4 shows the discarded exit is not logged.

### R2. Stream termination after close must be a typed failure [Required, integrity]

P1 shows that if the descriptor owner (the bounded pump the draft allows) stops by ending its queue, the consumer sees a truncated stream as success. Required wording:

- A consumer sees end-of-stream only after length and digest have verified at EOF.
- Lifetime close, interruption of the owner and descriptor errors all terminate the consumer with `ArtifactReadError{Closed}` or `{Corrupt}`, through `Queue.fail` or an equivalent. They never use `end` or `shutdown`.
- Add a proof gate: close the invocation mid-stream; the consumer must fail `Closed` and must not succeed with fewer bytes.

### R3. Do not hold a content permit across author decoding [Required]

`get` holds a permit "including decoding". An async codec can then sleep up to the attempt timeout while holding one of four daemon-wide slots. JSON reads are synchronous `readFileSync` of at most 1 MiB, so the permit protects nothing during decoding.

Smallest fix:

- JSON `get` takes the permit only around its I/O, or takes none.
- The permit is released before the R1 decode child starts.

`stream` and `bytes` keep their permits through descriptor/buffer lifetime.

### R4. Permit admission policy must be explicit about fan-out [Required: fix or user decision]

Tasks run in-process with 32 global execution slots (`execution-resources.ts:50`). Binary writers _wait_ for their four permits (`lake-binary.ts:223,256`). Fail-fast `Busy` at four readers means ordinary graph fan-out fails, for example eight parallel tasks streaming inputs. Those tasks fail unless every author declares `ArtifactUnavailable` and a retry. Fail-fast does prevent the hold-and-wait deadlock of a task that opens a second read while holding one.

Smallest correct policy:

- An invocation's first content permit **waits interruptibly**, bounded by the attempt deadline and cancellation.
- Any further concurrent permit while that invocation already holds one is **fail-fast `Busy`**.
- No invocation ever waits while holding a permit, so this cannot deadlock.

If the parent keeps pure fail-fast, the user must approve it as a decision, with the fan-out consequence stated in the docs. The harness should mirror whichever policy is chosen.

### R5. Pin contention and the real race [Required: precision]

- Pin and apply both run synchronously on the single lake connection. JavaScript therefore totally orders them, and gate 3's "both orders on real connections" proves little.
- The real contenders are other connections:
  - the engine's `SqliteClient` connection, whose transactions can span fiber yields;
  - host-store writes, such as run status and report retry.

  All connections use `busy_timeout = 0`.

- Pins therefore hit `SQLITE_BUSY` in ordinary operation. Surfacing every one as `ArtifactUnavailable{Busy}` again forces retry declarations on authors.
- Add a short internal pin retry: bounded (e.g. ≤ 250 ms total), interruptible, with no author code inside it. Surface `Busy` only after that.
- Make apply `.immediate()` so contention fails at `BEGIN` rather than after its checks. S1 shows both forms are safe; immediate just fails earlier.
- Retarget gate 3 at engine/host connections holding write locks across a pin or apply.

### R6. Reporter reads of their own source run must not consume pins [Required]

A report run's reads of publications by its `sourceRunId` are already protected by rule 6 for as long as the report record is unsettled. The record mirrors the report run's status (`reportStatus`), including `NeedsAttention` and `Cancelling`→`Running`.

Charging those reads to the 1,024-pin cap makes a reporter over a large fan-out source fail with `PinLimit` on data that is protected anyway.

Smallest fix: treat source-run publications like same-run reads for report runs. They are not pinned and not counted. Still verify the record inside the immediate transaction.

### R7. Fixture contract holes [Required]

- **a. `Report.test`.** It calls `Task.test(task.provide(…History…), { input, tags })` (`report-test.ts:217`). It therefore cannot seed fixtures, and reporters cannot be tested reading content. Forward `artifacts`, and return `artifacts`.
- **b. Metadata options.** Reporter queries filter `metadata.runId = source.runId`, but fixture options cannot set `runId`.
  - Add `runId?`; `invocationPath?` and `attemptId?` are advisable.
  - Specify defaults for every `Record` field: `runId`, `attemptId`, `invocationPath`, `revision`, `bytes`, `kind`, `contentType`.
  - Sequences are assigned per harness at seeding, in array order. They are not carried on fixtures.
- **c. Identity invariants checked at seeding.**
  - identity ↔ artifactId must be a bijection;
  - (artifactId, version) ↔ (digest alias, real digest, content) must be unique.

  For example, a hand-made fixture with a derived artifactId and an exported `test-artifact-N` for the _same_ identity must fail before execution, not be merged.

- **d. Multi-producer handoff.** Two independent producer tests both allocate `test-artifact-1`, so `[...a.artifacts, ...b.artifacts]` is the draft's collision error. The supported recipe is threading: `Task.test(B, { input, artifacts: a.artifacts })`, because allocation skips seeded IDs. The error message must name this recipe.
  - Also correct "existing publications … unchanged". That holds only when no seeded identity or ID is touched. With seeding, a publication can reuse a seeded artifactId at version ≥ 2.
  - The existing assertion `binary-artifacts.test.ts:159` (`test-digest-1`) stays valid without fixtures.
- **e. Immutability.**
  - The store holds its own copies, distinct from `TestPublication.bytes`, which is a mutable, public `Uint8Array` today.
  - `bytes()` and every `stream` chunk are fresh copies.
  - JSON is decoded from stored encoded text on every read.
  - Fixtures and their references are frozen.
  - Seeding a later test never mutates fixture objects; version advancement lives only in that test's private store.
- **f. Projection descriptions.** Use the first writer's `fields` per `(schemaId, version)`, matching `INSERT OR IGNORE INTO lake_schemas` (`lake.ts:302-305`). Equivalent definitions with different `fields` then query identically in the host and the harness.

Typing is feasible as drafted (T1). There is no import cycle:

- `artifact.ts` can import `boundary`, `json-budget` and `tag-state`; none of these import `artifact.ts` or `task.ts`.
- Keep the shared harness store in a new internal module imported by `task.ts`.
- `artifact.ts` must not import the reader or the task module.

### R8. Do not echo caller-controlled identifiers [Required, small]

`referenceSchema.artifactId` is an unbounded `Schema.String` (`artifact.ts:8-16`). `ArtifactReadError.artifactId` should carry the value only when a stored record matched it, or when it is a well-formed 64-hex ID or a harness alias. Otherwise use `null`. This keeps forged-input strings out of durable domain-error records.

### R9. Pushdown rules, stated as invariants [Required: precision]

- **What may be pushed:**
  - Push only positive `Eq`/`In` terms with non-null scalar values on metadata columns or tags. They must be conjuncts of the top-level `And`.
  - Never push through `Or` or `Not`.
  - Never push `Eq null`: SQL `NULL` conflates _missing_ and _null_, but the evaluator does not (`lake-query.ts:151-161`).
- **Where pushed terms go:** only into the outer `WHERE`, never into the latest `NOT EXISTS` subquery (Q1).
- **Re-evaluation:** the shared evaluator always re-evaluates the full predicate. Candidates must be a superset of matches.
- **Tag keys:**
  - Tag keys may contain `.` and `/` (`run-tags.ts:4`). Never interpolate them into a JSON path.
  - Use a side table indexed by `(principal, schemaId, schemaVersion, key, value)`, following `host_run_tags` (`host-store.ts:208-212`), or a bound key parameter.
  - A side table needs an idempotent, bounded backfill.
- **Moving the evaluator into core:** the core version throws a core error, and each adapter maps it. The CLI keeps its exact `OperationError` codes and messages.

### R10. Complete the reason mapping [Required: precision]

State each mapping.

| Source | Reason |
| --- | --- |
| Lake `InvalidInput` on query | `InvalidQuery` |
| `Invalid page cursor`, or pagination `Conflict` (other limit, principal or query) | `InvalidCursor` |
| Predicate over 64 terms or depth 8 | `InvalidQuery` |
| Projected row over 2 MiB, or cursor over 4 KiB | `QueryBudget` |
| Attempt no longer admitted, or fenced during a pin | `Closed` |
| `latest` when every version is reclaimed | `Reclaimed` |
| `latest` when nothing was ever published, or the identity belongs to another principal | `NotFound` |

Also:

- Legacy records without `kind`/`contentType` read as `json`/`application/json`.
- Busy after the R5 retry maps to `ArtifactUnavailable{Busy}`.

## 4. Assessment of the remaining deliberate choices

- **Six methods and the stream helper.** Accepted. `latest` needs the host because identity hashing includes the principal, which the task cannot see.
  - [Advisory] `bytes` has exactly the integrity semantics of `stream`→collect with a 16 MiB cap, since collection completes only after the EOF check. A helper would remove one method from every hand-written fake. Keep it as a method only if the implementation measures a benefit.
  - `ArtifactQuery.stream` re-runs the full candidate scan per page (`lake-query.ts:417-428`). Add a near-budget multi-page proof.
- **Two errors, explicit in `error`.** Accepted, and verified (§1). Using `Closed` here, while publish uses `TaskRuntimeError InvalidBoundary`, is an acceptable asymmetry; document it.
- **First access, no admission walk.** Accepted from the Effect side as honest and implementable. The consumer reviewer's objection is a user decision, not an Effect blocker.
- **Report protection and explicit retry.** Accepted. A retry inserts `Queued`/`WaitingSource` rows (`report-records.ts:500-520`) and protects from acceptance onward without resurrecting anything. `NeedsAttention` holds until cancelled; this is intended and visible through `reportSourceRunId`.
- **Lifetime.** Accepted.
  - Reads during Layer acquisition work, because close is registered on acquisition scopes (`publication-lifetime.ts:30-44,71-78`).
  - Finalizer reads fail.
  - Close awaits `Fiber.interruptAll`, so descriptors close before Layer finalizers run, once R1 and R2 are in place.
- **Overrides.** Accepted: an inner `Task.provide` wins, and the invocation default beats an application-level fake (`task.ts:420-447`).
- **Operator visibility.** Accepted. Consumer IDs are same-principal by construction. "Missing consumer state is conservatively protected" must surface the missing run ID in `protection`, so a permanent hold stays diagnosable.
- **Durability.** No further hole found once R5 and R6 are in. Retries, waits, `NeedsAttention` and restart keep run-owned pins. Terminal lag only extends protection.

## 5. Proof-gate additions

1. Close mid-stream → `Closed`, never a short success (R2). Lifetime close during an async decode whose finalizer dies → no secret in any cause, record or log (R1).
2. Eight parallel streaming tasks under the chosen permit policy. No deadlock when a holder opens a second read. JSON `get` with a slow async codec does not starve other readers (R3, R4).
3. Pin and apply against an engine `SqliteClient` transaction holding the write lock. Pin retries internally, then `Busy`. Apply fails without tombstoning (R5).
4. Reporter reading more than 1,024 source-run versions succeeds (R6).
5. `Report.test` with fixtures. A fixture with a custom `runId` matched by a reporter query. Threaded multi-producer handoff. Mixed-identity conflict rejected. Mutating `publications[i].bytes` and returned chunks does not change later reads (R7).
6. Pushdown equivalence for `Eq null`, `Not`, `Or`, and tag keys containing `.` or `/` (R9).

## 6. Decisions that remain the user's

1. The retention amendment: consumer pins, report-source protection and operator fields.
2. The permit admission policy (R4).
3. The first-access boundary instead of admission pins. This is contested by the consumer review.
4. Harness behaviour: synthetic aliases and the reference changes when seeded identities are reused (R7d).

Reviewer status: **conditionally approved for user presentation once R1–R10 are in draft 2.** A focused round-3 check of only those deltas is sufficient. It does not need a full re-review.
