# Artifact reads inside tasks: Claude Effect design review, round 1

Status: design critique for parent consolidation. **No artifact-read API is approved.** This review's verdict is not user approval and does not authorize implementation. It critiques the candidate in [artifact-reads-research.md](artifact-reads-research.md).

Labels:

- **[Fact]** Read from source in this checkout, or observed in a probe run for this review. File references are given.
- **[Probe]** Executed outside the checkout against pinned Effect 4.0.5, bun:sqlite and the real SDK types. Proposed code in the probes is a **labelled stand-in**; it does not exist in the SDK.
- **[Proposal]** A recommended choice. Needs consumer review and user discussion.
- **[Untested]** An assumption that a proof gate must settle.

Probe scripts are in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/cbb333c5-f3f5-4031-8817-7de9a9aa1796/scratchpad/probe/` (`runtime.ts`, `types.ts`, `sqlite.ts`). They are scratch evidence, not repository tests.

## Verdict

Add reads as a **separate runner-owned Context service**, `ArtifactReader`. Do not widen `ArtifactStorage`. The service has four operations:

- `get`: an exact, decoded JSON read;
- `stream`: an exact bytes `Stream`, with its descriptor owned by the invocation;
- `metadata`: an exact, verified metadata read;
- `query`/`queryStream`: discovery through the existing query AST, with typed references in the rows.

The service has two error tags:

- `ArtifactUnavailable`: transient, and eligible for retry;
- `ArtifactReadError`: permanent, with a `reason` literal.

The candidate's read-pinning direction is sound only with five corrections:

1. Pins belong to the **consumer run**, not the attempt or the invocation.
2. Pins are written in an **immediate transaction on the lake connection**. That transaction also checks attempt admission, exactly as `commit` does.
3. Pins **do not** cover references the run has not yet read. This review argues pinning at admission is unnecessary for in-run references, and wrong to do by scanning JSON values. It states the first-read boundary instead and offers `metadata` as a cheap early acquisition.
4. Queries are **live per attempt and never journaled**. Stability across attempts comes from the workflow engine's durable task results, not from the reader.
5. Reporters need a **producer-side rule, not a reader pin**. While a source run has unsettled report obligations, its own publications stay protected. A later explicit regeneration gets no content guarantee.

There are three blockers before implementation:

- Handler and Layer error channels reject the new errors today (shown by a probe).
- `ArtifactReader` would leak into `Definition` requirements unless the exclusion lists grow (shown by a probe).
- The query AST schemas live in `runtime`, which `core` cannot import.

## 1. Source facts

### Service, ownership and override

- **[Fact]** `ArtifactStorage` has only `publish` (`packages/core/src/artifact-storage.ts`). It is provided by `definition()` through `Effect.provideContext(Context.make(ArtifactStorage, storage)…)`, together with `Tag.Values` and `Report.History` (`task.ts` `definition`).
- **[Fact]** Runner-owned services are removed from requirements by a fixed list, `Exclude<R, Tag.Values | ArtifactStorage | History>`. The list appears in `Definition.provide`, `definition`, `make`, `Implementation.provide` and `implementation` (`task.ts`).
- **[Fact]** A task-local Layer **overrides** a runner-owned service.
  - Each `provide` wraps a new `definition()`. The runner context is provided at the outer `execute`, and `provideContext(services)` from the Layer is applied inside it.
  - `Report.test` relies on this: `Task.test(task.provide(Layer.succeed(History, history)))` (`report-test.ts:217`).
  - So `Layer.succeed(ArtifactReader, fake)` through `task.provide` is already a working substitution path, by precedent.
- **[Fact]** The publication lifetime (`publication-lifetime.ts`) gives each invocation:
  - a fresh memo map;
  - `run`, which forks a detached child and fails with `InvalidBoundary "Invocation closed"` once closed;
  - `close`, which interrupts the tracked children.

  It is open during task-local Layer acquisition. Its `close` is registered as a finalizer of each acquisition scope, so it closes **before** Layer finalizers release resources.

- **[Fact]** The host side (`interpreter.ts` `taskContext`) gates publication on `active.value`. This flag is set to `false` when the handler effect ends (`Effect.ensuring`).

### Retry and error routing

- **[Fact]** The leaf retry loop (`interpreter.ts` ≈330–395) retries only when all of these hold:
  - `error.category === "Domain"`;
  - the error decodes through `task.errorSchema`;
  - its `_tag` is in `retry.when`.

  A `TaskRuntimeError` always becomes `hostFailure(...)` and is never retried. A thrown value outside the error schema fails `encode(task.errorSchema, …)` and becomes a host failure.

- **[Fact]** `taskLayer` (`task.ts`) turns any Layer error that is neither a `TaskRuntimeError` nor in the error schema into `Effect.die`.

### Lake storage

- **[Fact]** The host store and the lake are **separate `bun:sqlite` connections to one WAL file** (`host.ts:18`, `lake.ts` `lakeLayer`, `host-store.ts:196`).
  - `commit` already reads `host_attempts`/`host_runs` and writes `host_events` in a _deferred_ transaction on the lake connection (`lake.ts` `commit`).
  - The lake connection sets no `busy_timeout`.
- **[Fact]** Today's `lake.get` reads metadata (checking `reclaimedAt IS NULL`) and then calls `readFileSync` on the blob **outside any transaction**. A reclaim that commits and unlinks between the two steps surfaces as a generic storage error. JSON is capped at 1 MiB and checked for both digest and length.
- **[Fact]** `binaryDownload` (`lake-download.ts`) does the metadata lookup and the `open` in one non-yielding step. It verifies size with `fstat`, checks length on every block, and checks the digest **only at EOF**.
- **[Fact]** Reclamation (`lake-reclamation.ts`):
  - It protects a candidate whose **producer** run (`json_extract(metadataJson,'$.runId')`) is non-terminal.
  - Plan and apply both re-check this. Apply evaluates every candidate inside one transaction before it marks `reclaimedAt`.
  - Blob unlink happens later, per digest, only when `retainedReferences(digest) === 0` (content-addressed dedupe).
  - An apply that changes anything bumps `lake_reclamation_epochs`.
- **[Fact]** Query cursors carry `{epoch, snapshot}`. Any reclamation epoch bump expires them (`CursorExpired`, `lake-query.ts`). Queries are scoped to the principal and to an exact `schemaId`/`schemaVersion`. Their budget is 250 ms, 16 MiB scanned, 10 001 rows and a 2 MiB page.
- **[Fact]** Run statuses: `Waiting`, `Retrying`, `Cancelling` and `NeedsAttention` are non-terminal (`runtime/src/protocol.ts`).
- **[Fact]** Report obligations exist from **source submission**: `reportSources.capture(...)` runs inside the run-insert transaction (`host-store.ts:643`). `host_reports` rows track `status`, `generation` and `reportRunId` (`report-records.ts`). Report runs are ordinary runs with their own attempts.

### References, codecs and dependencies

- **[Fact]** `referenceSchema(id)` narrows `schemaId` to a literal, but `schemaVersion` is `Schema.Int`. `Boundary` is `Codec<unknown, unknown, never, never>`, and `boundary.decode` uses `decodeUnknownSync`.
- **[Fact]** The query AST (`Field`, `Expression`, `Query`, `Record`, `QueryRow`) is defined in `packages/runtime/src/lake-protocol.ts`. `core` cannot import `runtime`, while `runtime` already imports `core` internals (`protocol.ts` imports `report-record`, `schedule-occurrence`, `RunTags`).
- **[Fact]** Swamp's `readModelData` (`vendor/swamp/src/domain/data/data_access_service.ts:127`) is a **live** query by name, with an identity fallback. It does not pin consumers or journal reads. Effectory's durable guarantee would therefore be _stronger_ than Swamp's. Parity does not require pinning, but the approved retention contract does (`artifact-retention-api-draft.md:88`).

## 2. Probes (executed)

| # | Question | Result |
| --- | --- | --- |
| P1 | Can a `Boundary`-typed codec be async? | **Yes.** A `SchemaGetter.transformEffect` with `Effect.sleep` has `DecodingServices = never`, so it type-checks as `Boundary`. `decodeUnknownSync` throws `Sync adapter can only throw schema errors`; `decodeUnknownEffect` returns `"X"`. |
| P1b | Is `decodeUnknownEffect` lazy? | **No.** When a sync transform throws, `Schema.decodeUnknownEffect(s)(x)` throws **at call time**, before any Effect runs. Wrapped in `Effect.suspend`, the result is a `Die` whose defect **contains the thrown message** (`secret=hunter2` leaked). |
| P2 | Stream with `acquireRelease` | Early `Stream.take(1)` releases the stand-in descriptor (open 1 / closed 1). With corruption at EOF, the consumer's `runForEach` **ran side effects on all three chunks before** the failure; the descriptor was still released. |
| P3 | Is a `Stream` value tied to invocation liveness? | **No.** A stream built during the invocation and run after its Scope closed **succeeded**. Only a guard re-checked at acquisition (`Stream.unwrap(Effect.suspend(check))`) failed. |
| P4 | Does interruption release the descriptor? | Interrupting a fiber that is draining a `Stream.never` with an acquired descriptor released it (1/1). |
| T1 | Inference and rejection (`tsc --strict`, `exactOptionalPropertyTypes`) | All five `@ts-expect-error` cases hold: a wrong-schema ref is rejected by `get`, a bytes definition is rejected by `get`, a JSON definition is rejected by `stream`, a publish-only fake is rejected by a widened service, and an unmapped read error is rejected in the `Task.make` handler. The decoded value infers `{team: string; n: number}`. |
| T2 | `schemaVersion` gap | A `doc` v1 ref passed to a `doc` v2 definition **compiles**. Only a runtime check can reject it. |
| T3 | Requirement leakage | A `Task.make` handler that yields a new `ArtifactReader` produces `Definition<…, ArtifactReader>` (`[R] extends [ArtifactReader]` is true). |
| T4 | Opt-in retry | `error: Schema.Union([ArtifactUnavailable])`, with `ArtifactUnavailable` a `Schema.TaggedError`, is accepted as a `Boundary`. A handler that `catchTags` the other errors type-checks. |
| S1 | Deferred lake transaction vs. a host write | A lake-connection `BEGIN` reads, then the host connection commits, then the lake connection writes: **`SQLiteError: database is locked`**. This is the shape of today's `commit`. |
| S2/S3 | Immediate pin vs. a reclaim recheck | A `.immediate()` pin transaction (check `reclaimedAt`, check run status, insert) succeeds. A stand-in apply recheck that joins pins to non-terminal runs sees the protection. |

## 3. Service choice: separate `ArtifactReader`, not a wider `ArtifactStorage`

**[Proposal]** Use a new `ArtifactReader` service in `@offtree/effectory-sdk/ArtifactReader`. The reasons:

1. **Least privilege in types.** A helper `loadPolicy: Effect<Policy, …, ArtifactReader>` states that it reads and cannot publish. Reporters and Layers that only read should not need a capability that can publish.
2. **No break for existing fakes.** T1 shows that `Layer.succeed(Widened, { publish })` stops compiling. Fakes that implement only publish keep working with a separate service.
3. **Precedent.** `Report.History` is already a second runner-owned read service. It shares the exclusion list, the `bindHistory` WeakMap wiring and the override-by-task-Layer test path. A reader adds one entry to an existing mechanism.
4. **Different lifetimes and semantics.** Publish is output-ACL'd and fenced by publication key. Reads are principal-ACL'd and fenced by pins. One service would mix two authorization models behind one tag.

The cost is one more exclusion entry (T3). This must be fixed in all five `Exclude<…>` sites. Consider naming the union once, e.g. `type RunnerServices = Tag.Values | ArtifactStorage | History | ArtifactReader`, so the next service cannot be missed in one site.

## 4. Minimal contract (proposed signatures)

```ts
// PROPOSED — @offtree/effectory-sdk/ArtifactReader. Not SDK code.
import type { Effect, Stream } from "effect";
import { Context, Schema } from "effect";

import type * as ArtifactQuery from "./artifact-query.ts"; // moved from runtime, see §8
import type * as Artifact from "./artifact.ts";

export class ArtifactUnavailable extends Schema.TaggedError<ArtifactUnavailable>()(
  "ArtifactUnavailable",
  { reason: Schema.Literals(["Storage", "Busy"]) }
) {}

export class ArtifactReadError extends Schema.TaggedError<ArtifactReadError>()(
  "ArtifactReadError",
  {
    artifactId: Schema.NullOr(Schema.String),
    version: Schema.NullOr(Schema.Int),
    reason: Schema.Literals([
      "NotFound", // never existed, or another principal's: indistinguishable on purpose
      "Reclaimed",
      "KindMismatch", // json vs bytes, or bytes contentType differs
      "SchemaMismatch", // id/version of definition ≠ ref ≠ stored record
      "DigestMismatch", // forged/stale ref digest ≠ stored digest (checked before any I/O)
      "DecodeFailed", // stored JSON is valid and verified but the consumer codec rejects it
      "Corrupt", // stored bytes ≠ stored digest/length (for streams: may arrive at EOF)
      "InvalidQuery",
      "CursorExpired",
      "PinLimit",
    ]),
  }
) {}

export type ReadError = ArtifactReadError | ArtifactUnavailable;

export interface Metadata extends ArtifactQuery.Record {
  readonly kind: "json" | "bytes";
  readonly contentType: string;
}
export interface Row<A extends Artifact.Any> {
  readonly ref: A["refSchema"]["Type"];
  readonly metadata: Metadata;
  readonly projection?: Readonly<Record<string, Schema.Json>>;
}
export interface Page<A extends Artifact.Any> {
  readonly rows: ReadonlyArray<Row<A>>;
  readonly cursor: string | null;
  readonly matched: number;
}
/** The AST minus the parts the definition owns. `versions` and `limit` stay required. */
export type QueryRequest = Omit<ArtifactQuery.Query, "artifact" | "version">;

export interface Service {
  readonly get: <A extends Artifact.Artifact>(
    artifact: A,
    ref: NoInfer<A["refSchema"]["Type"]>
  ) => Effect.Effect<A["schema"]["Type"], ReadError>;
  readonly stream: <A extends Artifact.Bytes>(
    artifact: A,
    ref: NoInfer<A["refSchema"]["Type"]>
  ) => Stream.Stream<Uint8Array, ReadError>;
  readonly metadata: <A extends Artifact.Any>(
    artifact: A,
    ref: NoInfer<A["refSchema"]["Type"]>
  ) => Effect.Effect<Metadata, ReadError>;
  readonly query: <A extends Artifact.Any>(
    artifact: A,
    request: QueryRequest,
    cursor?: string
  ) => Effect.Effect<Page<A>, ReadError>;
  readonly queryStream: <A extends Artifact.Any>(
    artifact: A,
    request: QueryRequest
  ) => Stream.Stream<Row<A>, ReadError>;
}

export class ArtifactReader extends Context.Service<ArtifactReader, Service>()(
  "@offtree/effectory-sdk/ArtifactReader"
) {}
```

These are the design notes behind each signature.

- **`get` and `stream` are separate, not one `get` that depends on kind.** A conditional return type (`A["kind"] extends "bytes" ? Stream : Effect`) makes `yield*` ambiguous. It also hides that a stream defers integrity. T1 shows both mistakes are rejected at compile time with two methods.
- **`NoInfer` on `ref`** keeps the definition as the only source of inference. A reference can never widen the type.
- **`metadata` exists for durability as well as convenience.** It verifies the reference and **pins** it without reading content (§6.2). Use it to acquire references early, before a durable wait, or to inspect size and content type before streaming. It is not a lease: there is no release step.
- **No `latest` method.** "Latest within one identity" is `query(A, { versions: "latest", where: Eq(metadata.artifactId, ref.artifactId), limit: 1 })`. Swamp's name-based lookup has no counterpart: `artifactId` is derived from `(principal, taskId, output, key)` and is unknown until you hold a ref or row. A `latest(name)` method would suggest a model-name resolution Effectory does not have. If users want sugar later, `latestOf(artifact, ref)` is unambiguous; defer it.
- **No optional-read helper.** `Effect.catchTag("ArtifactReadError", e => e.reason === "Reclaimed" ? … )` is one line. An `Option` helper would tempt authors to fold `DecodeFailed` and `Corrupt` into `None`.
- **Read ACL is the principal only.**
  - Reading never requires declaring the artifact as an output.
  - Definition identity is checked by value: `(id, version, kind, contentType)` against the ref and the stored `lake_records`/`lake_schemas`.
  - Foreign-but-equivalent definition instances (duplicate module copies, installed extension contracts) are accepted. Output-membership rules (`UnknownOutput`) do not apply to reads.

## 5. Errors and the handler channel

- **[Proposal] Two tags, not one and not five.**
  - Retry selection matches `_tag` only ([Fact] §1), so the transient class needs its own tag.
  - All permanent outcomes share `ArtifactReadError` with a `reason` literal. This keeps "missing/reclaimed ≠ corrupt ≠ schema mismatch" distinct without a catch-tag explosion.
  - Invocation-closed stays the existing `TaskRuntimeError({ code: "InvalidBoundary", message: "Invocation closed" })`, to match publish.
- **Blocker (T1):** `Task.make`'s handler E is `S["error"]["Type"] | TaskRuntimeError`, so a handler that does not map read errors does not compile. Either:
  - **(a) [Recommended]** Widen it to `… | TaskRuntimeError | ArtifactReader.ReadError`, and route unmapped read errors to `hostFailure(message, "Artifact" + reason)`, which is not retryable. When the author's error schema **includes** `ArtifactUnavailable`, it is encoded as a Domain failure and `retry.when: ["ArtifactUnavailable"]` works (T4). Retry is opt-in, typed and stays on the existing path.
  - **(b)** Require authors to map every read error. This is noisy for the common case, where any read failure should fail the task.

  Either way:
  - `interpreter.ts`'s catch must recognise the read classes before trying `encode(task.errorSchema)`. Today the encode fails and produces a generic `InvalidBoundary` host failure.
  - `taskLayer`'s `Layer.catch` must fail, not `die`, on them. Otherwise a reading Layer turns a missing artifact into a defect.

- **Secret hygiene (P1b).**
  - Never include `SchemaError` issue text or a defect message in `ArtifactReadError`. Issues echo stored values, and the consumer's `VaultTracker` does not track secrets the producer resolved.
  - Wrap decoding as `Effect.suspend(() => Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }))`.
  - Map `SchemaError` to `DecodeFailed`.
  - Map a **defect from the consumer codec** to `DecodeFailed` too, with no message. The alternative is a redacted `Die`; this is a public decision (D6).
  - Log the full issue only to the task log through `VaultTracker.scrub`.

## 6. Durability: critique of the candidate pinning scheme

### 6.1 Rules this review would accept

1. **Pin key.** `lake_read_pins(consumerRunId, artifactId, version, principal, firstAttempt, pinnedAt)` with `PRIMARY KEY(consumerRunId, artifactId, version)`. A pin belongs to the **run**, so it survives:
   - attempt failure;
   - retry delays (`DurableClock.sleep`);
   - approvals and waits (`Waiting`);
   - `NeedsAttention`;
   - `Cancelling`;
   - process death.
2. **Pin transaction.** One `database.transaction(fn).immediate()` on the **lake** connection. S1 shows a deferred transaction on this connection can fail with `database is locked` when the host store commits in between. The transaction:
   1. calls `lease.assertActive()`;
   2. checks that the attempt is still admitted to this lease (`host_attempts.owner = lease.token` for `(runId, nodeId, attempt)`) and that the run is not fenced and is not terminal (the same predicate as `commit`);
   3. reads the record under the run's principal (another principal's record looks like `NotFound`);
   4. checks `reclaimedAt IS NULL`;
   5. checks the ref's digest, kind, schema and content type against the record;
   6. counts the run's pins and fails with `PinLimit` above the bound;
   7. `INSERT OR IGNORE`s the pin.

   Content I/O happens only **after commit**, and decoding happens after I/O, so author code never runs in a transaction. `SQLITE_BUSY` maps to `ArtifactUnavailable{Busy}`.

3. **Reclamation.** Both `rowSql` checks (plan and apply) gain one condition. A row is protected when either holds:
   - its producer run is non-terminal (today's rule);
   - `EXISTS (SELECT 1 FROM lake_read_pins p JOIN host_runs h ON h.runId = p.consumerRunId WHERE p.artifactId = r.artifactId AND p.version = r.version AND h.status NOT IN terminal)`.

   Apply already re-evaluates every candidate inside its transaction, so a pin that commits after the plan is honoured. Ordering is total because SQLite serialises the two writers:
   - pin first, then apply: apply skips the row;
   - apply first, then pin: the pin sees `reclaimedAt` and fails with `Reclaimed`.

   A pinned row stays non-reclaimed, so `retainedReferences(digest)` is at least 1 and dedupe cannot unlink a blob that a pinned version shares.

4. **Lapse, not erase.**
   - A pin stops protecting when `host_runs.status` is terminal. That status is a projection written _after_ engine completion ([Fact], run-reports review §1), so lag only extends protection and never shortens it.
   - Rows for terminal consumers are deleted lazily, in the reclaim apply transaction and on lake open, in bounded batches.
   - A row is never deleted while its run is non-terminal, so recovery never meets a missing dependency.
   - Cancelling a stuck run (`NeedsAttention`, then `Cancelled`) is the operator's way to release pins. Reclamation can never become _permanently_ blocked by a pin; a pin only defers a version.
5. **Bounds.**
   - At most 1 024 distinct pinned versions per consumer run (D3). Re-reading an already pinned version costs nothing.
   - The worst case is the existing 1 000 active runs × 1 024 pins ≈ 1 M small rows. A lower bound is a reasonable alternative.
   - JSON content stays capped at 1 MiB and bytes at 16 MiB.
6. **Receipt meanings preserved.** `reclaimedBytes` and `pendingBytes` are unchanged. Consumer-protected versions count in the plan's `protectedVersions`. That field is documented as "unfinished producer runs", so this is a **meaning amendment that needs the user's approval** (D4). The alternative is a new additive field, `consumerProtectedVersions`, which this review prefers.

### 6.2 Where the candidate overstates

**References not read yet.**

- Inside one run, references are passed via `Ref` between graph nodes. The producer _is_ the same run, which is non-terminal while the consumer runs. These references are **already protected** by the existing producer rule, so no pin is needed until the run ends.
  - [Untested] Confirm that child and sub-workflow invocations share `runId`. They should, since `invocationPath` is the node identity.
- The gap is **cross-run references**: references supplied in submitted input, in schedule input, or from a query. The candidate "pin on successful read" leaves a window from admission to first read.
- Pinning declared reference inputs at admission would require walking the **input schema** for reference schemas. That would be schema-directed, not JSON-shape scanning, but it is still complex across unions, records, `suspend` and transformations. It would also make admission fail for a reclaimed reference the task might never read.
- **[Proposal]** State the first-read boundary in the contract: _a cross-run reference is guaranteed from the first successful `get`, `stream` or `metadata` call in the consuming run until that run terminates._ Authors who need early acquisition call `metadata(A, ref)` as the first statement, or in a task-local Layer's acquisition. Admission-time pinning stays a separate later decision (D5).

**Later report retries and regenerations.**

- A reporter's _attempts_ share its run's pins. Retries are covered.
- The real gap is between the **source run reaching terminal** and the **reporter's first read**. Report admission is bounded at 4 active report runs, so a reporter may sit `Pending` behind others while a reclaim runs. Reader pins cannot cover a read that has not happened.
- **[Proposal]** Add a producer-side rule: a lake record whose producer run `S` has a `host_reports` row (through `host_report_groups.sourceRunId = S`) in a **non-settled** status stays protected. This is O(1) per source, needs no per-artifact rows, starts at source submission (when `capture` runs) and lapses when the obligations settle. [Untested] The exact set of non-settled `status` values must be taken from `report-records.ts`.
- **Explicit regeneration later** is a new generation and a new run, after the obligation settled. It gets **no** content guarantee: reads return `ArtifactReadError{Reclaimed}`, and the report history may still hold the stale reference. Say so in the docs, and add no retention promise.

**Query snapshots across attempts.**

- Rows are **not** pinned. Query-to-`get` is a documented race that ends in `Reclaimed`.
- A retry re-queries and may see a newer `latest`. **[Proposal]** Do not journal reads.
- The Effect-native durable boundary already exists: put the query in an upstream task and return the chosen references as its **success value**, which the workflow engine stores durably. The downstream task retries against the same references, and its first read pins them.
- Exact immutable reads are repeatable across attempts (and pinned); queries are live. The docs must state that difference in those terms.

**Cursor invalidation.** Any apply that changes rows bumps the epoch and expires every cursor. `queryStream` must **fail** with `CursorExpired`. It must not silently restart, which could duplicate or skip rows. The consumer decides whether to restart with `Stream.retry` and deduplicate by `ref`.

## 7. Scope, Stream and lifetime

**Acquisition.**

- `get`, `metadata` and `query` run through `lifetime.run`, so they are interrupted on close and refused afterwards.
- `stream` must not rely on the `Stream` _value_. P3 shows a stream built during the invocation still works after its Scope has closed.

**[Proposal] stream ownership.**

- `stream` = `Stream.unwrap(Effect.suspend(() => closed ? fail(InvocationClosed) : …))`.
- The descriptor is opened in a **pump fiber owned by the lifetime** (forked through the same child set as `run`). The pump reads blocks into a bounded queue of 2 × 64 KiB, and the consumer pulls from that queue.
- `lifetime.close` interrupts the pump. The pump closes its _own_ descriptor in its own finalizer (P4 confirms interruption releases it). Closing a descriptor from another fiber could race a read and reuse the fd number; this design avoids that.
- Each block re-checks `active`.
- Result: a detached fiber that keeps a half-read stream after the handler exits sees `InvocationClosed` and leaks no descriptor.

**Early cancellation.** `Stream.take` or interrupting the consumer closes the queue, and the pump's scope releases the descriptor (P2).

**Integrity timing.** The digest is known only at EOF. P2 shows downstream side effects can run on every chunk before `Corrupt` arrives. Document this. A consumer that must verify before acting does `Stream.runCollect` (bounded at 16 MiB) and acts afterwards. Do **not** add a buffering method in v1.

**Layers and finalizers.**

- Reads are available during task-local Layer **acquisition**, because the lifetime is open then. A Layer that loads a configuration artifact is a legitimate use; its pin is the run's pin.
- Reads are **unavailable in Layer finalizers and after the handler**. Close runs before finalizers, so those reads fail with `InvalidBoundary "Invocation closed"`. Document this.
- Memo map: the reader is runner context, not a Layer, so it has no memoisation of its own. A reading Layer is memoised in the invocation's fresh memo map. It therefore re-reads on every attempt, and the pin is idempotent.

## 8. Codecs, budgets and Schema ownership

**Lazy codec evaluation (P1, P1b).**

- Decode with `Effect.suspend(() => Schema.decodeUnknownEffect(artifact.schema)(json, { onExcessProperty: "error" }))`. This supports async `Boundary` codecs, which `decodeUnknownSync` rejects (P1). It also turns synchronous throws into Effect failures or defects instead of escaping `gen` (P1b).
- This is deliberately **more permissive than publish**, which uses the sync encode. Record the asymmetry. A future change to make publish encoding async-capable is separate.

**Independent budgets.**

- _Read (I/O) budget_ is enforced by the host before decoding: metadata-first size check, JSON ≤ 1 MiB, bytes ≤ 16 MiB, the pin bound, and the query budget (250 ms, 16 MiB scanned, 2 MiB page). These are unchanged.
- _Decode budget_ runs in the consumer fiber after the transaction, under the attempt timeout. Async decoding is interruptible. Sync decoding is bounded by input size: `checkJsonBudget` runs on the parsed value before decoding.
- Do not charge decode time against the query's 250 ms budget, and do not add a separate public decode timeout in v1.

**Schema ownership (blocker).**

- Move `Field`, `Expression`, `Query`, `Record`, `QueryRow` and `QueryPage` from `runtime/src/lake-protocol.ts` into a new `core` module, `@offtree/effectory-sdk/ArtifactQuery`.
- `runtime/src/lake-protocol.ts` re-exports the **same schema values**. The wire format does not change, and the existing RPC/CLI keep working.
- Do not create combinators (`And`, `Eq`, …) in v1. The AST literals are already public through the CLI. A typed field helper (`ArtifactQuery.json(Document, ["team"])`, checked against `queryFields`) could come later.

**Version gap (T2).** `schemaVersion` is a plain `number`, so a v1 reference type-checks against a v2 definition. The runtime check (`SchemaMismatch`) is mandatory. Making `referenceSchema` carry `Schema.Literal(version)` is a type-level change to an existing public schema (D7). It is likely compatible, because literal is assignable to `number`, but it changes the type of every `refSchema.Type`. Defer unless the user wants it.

## 9. Testing and substitution

- **Plain substitution works today, by precedent.** `task.provide(Layer.succeed(ArtifactReader, fake))` overrides the runner's reader ([Fact] §1). A pure helper is tested with `Effect.provideService(ArtifactReader, fake)`.
- **Disclosed gap:** a generic fake method (`<A>(a: A, ref) => Effect<A["schema"]["Type"]>`) cannot be written without a cast from a stored `unknown`. The same is true for `History.outcome` (`report-test.ts:215`).
- **[Proposal] Fixtures in `Task.test`.** Add an option, `artifacts: ReadonlyArray<ArtifactReader.Fixture>`. `ArtifactReader.fixture(Document, value, { tags? })` encodes through the definition, computes the **real** SHA-256 of the canonical JSON, and returns `{ fixture, ref }`. The harness reader then:
  - runs the same reference, schema, digest and decode checks as the host;
  - for the existing publications of the same `Task.test` run, serves them only by their **synthetic `test-digest-N`** references. These can never verify against a real lake, because the host requires 64-hex digests, so they cannot be mistaken for real lake reads;
  - records the reads (`reads: readonly { ref, kind }[]`), so a test can assert that a reference was acquired;
  - evaluates queries over the fixtures with the same AST evaluator. [Untested] Can `lake-query`'s row predicate be shared from `core`? If not, fixture queries support only `Eq`/`In` on `metadata`/`tag` fields and fail with `InvalidQuery` on anything else. Disclose this.
- `Task.test` stays "one validated attempt, not a durability test". Pins are not simulated.

## 10. Full consumer example (proposed API; not checked against the SDK)

```ts
import {
  Application,
  Artifact,
  ArtifactReader,
  ArtifactStorage,
  Ref,
  Task,
  Workflow,
} from "@offtree/effectory-sdk";
import { Effect, Schema, Stream } from "effect";

const Document = Artifact.make({
  id: "acme/doc",
  version: 1,
  fields: [["team"]],
  schema: Schema.Struct({ team: Schema.String, body: Schema.String }),
});
const Archive = Artifact.make({
  id: "acme/archive",
  version: 1,
  kind: "bytes",
  contentType: "application/zip",
});

const produce = Task.make(
  {
    id: "acme/produce",
    version: 1,
    input: Schema.String,
    replay: "idempotent",
    error: Schema.Never,
    outputs: { doc: Document, archive: Archive },
    success: Schema.Struct({
      doc: Document.refSchema,
      archive: Archive.refSchema,
    }),
  },
  (team) =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      const doc = yield* storage.publish(
        Document,
        { team, body: "…" },
        { key: team }
      );
      const archive = yield* storage.publish(
        Archive,
        new Uint8Array([80, 75]),
        { key: team }
      );
      return { doc, archive };
    })
);

const consume = Task.make(
  {
    id: "acme/consume",
    version: 1,
    replay: "idempotent",
    input: Schema.Struct({
      doc: Document.refSchema,
      archive: Archive.refSchema,
    }),
    error: Schema.Union([ArtifactReader.ArtifactUnavailable]), // opt in to transient retry
    success: Schema.Struct({ previous: Schema.Number, bytes: Schema.Number }),
  },
  ({ doc, archive }) =>
    Effect.gen(function* () {
      const reader = yield* ArtifactReader.ArtifactReader;
      const current = yield* reader.get(Document, doc); // verified, decoded, pinned
      const older = yield* reader.query(Document, {
        versions: "all",
        limit: 20,
        where: { _tag: "Eq", field: { json: ["team"] }, value: current.team },
        orderBy: [{ field: { metadata: "committedAt" }, direction: "desc" }],
      });
      const previous = older.rows.filter(
        (row) => row.ref.version < doc.version
      ).length;
      const bytes = yield* reader.stream(Archive, archive).pipe(
        // descriptor owned by invocation
        Stream.runFold(0, (n, chunk) => n + chunk.byteLength)
      );
      return { previous, bytes };
    }).pipe(Effect.catchTag("ArtifactReadError", (e) => Effect.die(e.reason)))
); // or let it fail as host failure

const pipeline = Workflow.make(
  {
    id: "acme/pipeline",
    version: 1,
    input: Schema.String,
    error: Schema.Never,
    success: consume.successSchema,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const team = yield* graph.input(Schema.String);
    const refs = yield* graph.task("produce", produce, team);
    return yield* graph.task("consume", consume, refs, {
      retry: { attempts: 3, delay: "5 seconds", when: ["ArtifactUnavailable"] },
    });
  })
);

// Test (proposed Task.test option)
const { fixture: d, ref: docRef } = ArtifactReader.fixture(Document, {
  team: "a",
  body: "x",
});
const { fixture: z, ref: zipRef } = ArtifactReader.fixture(
  Archive,
  new Uint8Array([80, 75])
);
const result = Task.test(consume, {
  input: { doc: docRef, archive: zipRef },
  artifacts: [d, z],
});

export default Application.make({
  tasks: [produce, consume],
  workflows: [pipeline],
});
```

The intra-run handoff (`produce` → `consume`) is protected by the existing producer rule. `consume`'s first `get` and `stream` add run-scoped pins, which make a later retry, wait or restart safe. They also make the references safe after `produce`'s run ends, if `consume` is reused cross-run.

[Fact] Graph task nodes accept `retry`, with `when` typed by the task's error tags (`workflow.ts:30–38`). The rest of the example is the proposed API and has not been type-checked.

## 11. Changes to existing compatibility

| Change | Kind |
| --- | --- |
| Add `ArtifactReader` to the five `Exclude<…>` lists in `task.ts` | Narrows inferred requirements. Source-compatible. |
| Widen the handler E in `make`/`implementation` with `ArtifactReader.ReadError` | Additive. |
| Route read errors in `interpreter.ts` and `taskLayer` (fail, not die) | Behaviour for new errors only. |
| Move the query schemas into `core`; `runtime` re-exports them | Internal. Identity must be `===` (proof gate). |
| `Task.test` gains an `artifacts` option and a `reads` result field | Additive. |
| Reclamation protection gains consumer pins and pending-report sources | **Changes which versions plans and apply return.** Needs the user's approval and an update to the retention draft. |
| `protectedVersions` meaning, or a new `consumerProtectedVersions` field | D4 |
| `lake.get` race fixed by pin-then-read | Bug fix |
| Lake read and pin transactions use `.immediate()` | Internal. The existing `commit` deferred-upgrade risk (S1) should be reviewed separately. |

## 12. Public decisions for the user

1. **D1** A separate `ArtifactReader` service, not a wider `ArtifactStorage`. Recommended: separate.
2. **D2** Error shape: two tags (`ArtifactUnavailable` transient, `ArtifactReadError{reason}`), with a widened handler E. Recommended: yes, option (a) in §5.
3. **D3** The per-run pin bound. Recommended: 1 024.
4. **D4** Report consumer protection inside `protectedVersions`, or add `consumerProtectedVersions`. Recommended: the additive field.
5. **D5** The first-read boundary plus `metadata` for early acquisition, versus pinning reference inputs at admission. Recommended: the first-read boundary in v1.
6. **D6** A consumer-codec defect becomes `DecodeFailed` with no message, or a redacted `Die`. Recommended: `DecodeFailed`.
7. **D7** Literal `schemaVersion` in `refSchema`. Recommended: defer, and keep the runtime check.
8. **D8** Include `queryStream` in v1, or `query` pages only. Recommended: include it, failing on `CursorExpired`.
9. **D9** Producer-side protection while report obligations are unsettled. Recommended: yes. Regeneration gets no guarantee.

## 13. Blockers

1. The handler and Layer error channels reject the read errors (T1, `taskLayer` dies on them).
2. Requirement leakage (T3) until the exclusion lists include `ArtifactReader`.
3. Query AST ownership: `core` cannot import `runtime`.
4. Deferred-transaction locking on the lake connection (S1): pin writes must be immediate, and busy errors must map to `ArtifactUnavailable{Busy}`.
5. The retention contract must be amended (consumer and report protection) before any reader ships (`artifact-retention-api-draft.md:88`).

## 14. Proof gates

- **Read and reclaim race:** interleave pin and apply in both orders, on two real connections. Assert exactly one of two outcomes: the pin wins and apply skips, or apply wins and the read returns `Reclaimed`. Assert no blob is unlinked under a pinned version, including a version that shares a deduplicated digest.
- **Plan then pin then apply:** the plan lists the version, and apply skips it. Assert the receipt's `reclaimedBytes` and `pendingBytes` are unchanged in meaning.
- **Retry:** attempt 1 reads and fails a domain error; a reclaim attempt happens during the durable retry delay; attempt 2 reads the same version successfully.
- **Restart:** kill the daemon while the consumer is `Waiting` after a read. After restart, reclaim, approve, and read again successfully.
- **Lapse:** the consumer terminates, its pin no longer protects, and lazy cleanup deletes only rows of terminal runs. A `NeedsAttention` consumer stays protected until it is cancelled.
- **Reporter:** a source succeeds, a reclaim runs before reporter admission, and the reporter reads the source's artifacts. Regeneration after settlement returns `Reclaimed`, with no crash.
- **Forgery:** wrong digest, wrong `schemaVersion` (the T2 shape), wrong kind, another principal's `artifactId`, and a `test-digest-N` reference against the real host. Each must fail with the specified reason before any content I/O, and the other-principal case must be indistinguishable from `NotFound`.
- **Streams:** early `take`; interruption; corruption at EOF (the error type, and that it arrives only after the chunks); a detached fiber holding a half-read stream after the handler exits (`InvocationClosed`, with the descriptor count back to baseline); a read from a Layer finalizer fails.
- **Codecs:** an async codec decodes; a throwing codec yields `DecodeFailed` with no secret text in the host failure, the run record or the logs; decoding never runs inside a SQLite transaction (instrumented).
- **Queries:** paging; an epoch bump mid-`queryStream` fails with `CursorExpired`; `versions: "latest"` stays within one identity; `InvalidQuery` for unknown fields; the budget is enforced.
- **Types:** the T1 to T4 suite as committed type tests; standalone `Definition` R excludes the reader; publish-only fakes still compile; the error union lets `retry.when: ["ArtifactUnavailable"]` work end to end.
- **Schema identity:** `runtime`'s `Query === core`'s `Query`; the CLI `lake query` wire format is unchanged.
- **Extensions:** an installed extension task reads an artifact defined by its contract module, and a duplicate module copy of the definition is accepted by value. Provenance and canonicalisation are unchanged.
- **Fixtures:** `Task.test` fixtures use real digests; reads of publications from the same test are labelled synthetic; the query evaluator either matches the host semantics or refuses with `InvalidQuery`.
