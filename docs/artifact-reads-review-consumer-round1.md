# Artifact reads — consumer design critique, round 1

Reviewer: Claude (consumer/developer-experience lens). This critiques `docs/artifact-reads-research.md`. It is **not user approval**. The reviewer's preferences below do not settle any public API. No production files were edited. Probes ran outside the checkout against pinned Effect 4.0.5 and the real SDK types. Every proposed service in them is a labelled stand-in.

## Verdict

The research document picks the right gap and keeps the right non-goals (no CEL, no HTTP wrapper over the CLI, no second query language). As written, the candidate API would not yet let consumers use the lake. It would mostly expose internal structures. There are five reasons:

1. **There is no way to name "the thing I want".** Swamp's main read is "latest data for model X, name N". In Effectory, artifact identity is `sha256(principal, taskId, output, key)` (`packages/platform-bun/src/lake.ts:314-316`). The publication `key` is not a queryable metadata field (`packages/runtime/src/lake-protocol.ts:17-32,101-119`). A consumer that does not already hold a reference cannot select one identity except through ad-hoc tags. A "latest" convenience is therefore useless until the identity is addressable.
2. **Transient read failures cannot be retried with the shown error channel.** Only `Domain` failures whose `_tag` is in `retry.when` are retried (`packages/platform-bun/src/interpreter.ts:364-371`). `TaskRuntimeError` is a host failure, so a read that fails as `TaskRuntimeError` fails the run with no declared-retry path.
3. **Testing a producer → consumer round trip is not designed.** `Task.test` returns synthetic `test-digest-N` references. An independent fixture cannot see them (probe P3).
4. **Cross-run consumers (reporters most of all) are exposed to reclamation before their first read.** The research names this but leaves it open. Reporters, which are explicitly in scope, are the main victim (see "Reporters" below).
5. **In-task queries have a time-bomb budget.** A fixed 10,000 scanned rows / 16 MiB / 250 ms budget (`packages/platform-bun/src/lake-query.ts:42-47,311-316`) works in development and starts failing as the lake grows. The 250 ms wall-clock part is also nondeterministic under load.

None of these blocks the feature. Each needs an explicit contract item. The recommended contract is below.

---

## 1. Source facts (read 2026-11-06)

Effectory:

- `ArtifactStorage` is a single `Context.Service` with only `publish` (`packages/core/src/artifact-storage.ts:19-28`). It is runner-provided via `Effect.provideContext` in `definition()` (`packages/core/src/task.ts:421-426`) and excluded from `Definition` requirements (`task.ts:119,384`).
- `Report.History` is the precedent for a second runner-owned read service. It is provided by the same `provideContext` (`task.ts:424`), excluded from requirements, defaults to a refusing implementation outside reports (`packages/core/src/report-history.ts:136-148`), and `Report.test` substitutes it with `task.provide(Layer.succeed(History, fixture))` (`packages/core/src/report-test.ts:213`). So an inner `task.provide` overrides a runner-owned service; the runtime probe P3 confirms the same for a stand-in reader.
- Existing explicitly typed publish-only fakes: `packages/core/test/artifact-storage.test.ts:46` (`ArtifactStorage.of({ publish })`). `docs/artifact-storage.md:59-61` tells authors to write such fakes. Type-only references to `typeof ArtifactStorage.Service` appear in `packages/core/test/binary-artifacts.test.ts:338,393`.
- References are `{ artifactId, digest, schemaId: Literal<Id>, schemaVersion: Int, version: Int }` (`packages/core/src/artifact.ts:8-16`). `schemaVersion` is a plain number, so the type system cannot reject a v1 reference passed with a v2 definition.
- `Lake.get(artifactId, version, principal)` checks only those three values plus `reclaimedAt`. It ignores the reference's digest and schema (`lake.ts:174-194,390-410`). It verifies size and digest of the stored bytes against **stored** metadata, rejects bytes artifacts, and loads synchronously up to 1 MiB.
- Reclaimed rows return `NotFound` with a CLI hint in the message (`lake.ts:183-192`). There is no structured "reclaimed" discriminator today.
- Byte download is a `Stream` over an opened descriptor. It does a length check at open, a running SHA-256, and the digest check **only at EOF** (`packages/platform-bun/src/lake-download.ts:79-112`).
- Query AST: `Eq/Gt/Gte/Lt/Lte/In/And/Or/Not` over `{tag}`, `{json: path}` (declared fields only) and `{metadata: runId|taskId|revision|output|artifactId|version|committedAt|sequence|bytes|schemaId|schemaVersion|digest|attemptId|invocationPath}`. It requires `limit` 1–200 and `versions: "all"|"latest"`. The cursor is a separate parameter (`lake-protocol.ts:13-98`). `versions: "latest"` means latest **per artifactId** among unreclaimed rows (`lake-query.ts:288-291`). Cursors expire after one hour and become `CursorExpired` when the snapshot row disappears (`lake-query.ts:428-446`).
- Query rows carry every field needed to build an exact reference (`lake-protocol.ts:101-119`), but no consumer-facing `ref` is assembled.
- Reclamation protects a version while its **producer** run is non-terminal (`lake-reclamation.ts:444-446,610-616`). The terminal set is `Succeeded/Failed/…`; `Waiting` and `NeedsAttention` are non-terminal (`packages/runtime/src/protocol.ts:8-24`). **Policy** reclamation never removes the newest version of an identity (`lake-reclamation.ts:424-428`). `Selection` (keepLatest/olderThan) and explicit `Version` can.
- The reclamation plan exposes only an aggregate `protectedVersions` count, with no reason (`lake-protocol.ts:177-187`).
- Report runs are **separate ordinary runs**, admitted by a promoter after the source run is terminal. Admission is limited to four active and four executing report runs daemon-wide, with queued obligations in between (`docs/run-reports-api-draft.md:11,210-212`).
- Declared task retry: `TaskOptions<E>.retry.when` is typed from the task error schema tags (`packages/core/src/workflow.ts:37-44`). At runtime only `category === "Domain"` with a listed tag is retried (`interpreter.ts:364-371`).

Swamp (vendored, reference only):

- Method context capabilities (`vendor/swamp/src/domain/models/model.ts:204-220`):
  - `readResource(instanceName, version?) → Record | null`: the behaviour's own resource, latest by default, with vault references resolved.
  - `readModelData(modelName, specName?) → DataRecord[]`
  - `queryData(predicate: CEL string, select?)`
- `readModelData` resolves a configured model name, scopes it to the caller's namespace, and merges data by write-time name tag and by identity, so data written before a rename is still found (`vendor/swamp/src/domain/data/data_access_service.ts:127-190`). It returns only the newest per name (`vendor/swamp/design/enablers/expressions.md:531-535`).
- `DataRecord.content` is parsed JSON for JSON types, text for text types, and `""` otherwise (`vendor/swamp/src/domain/data/data_record_mapper.ts:349`). A local `path` is available only to CEL `data.*` (`vendor/swamp/src/domain/data/data_record.ts:49-53`). Content is untyped (`Record<string, unknown>`). There is no streaming binary read in the method API.
- Swamp has **no reader pin**. GC, prune and delete take a global datastore lock. Retention can delete the latest version, except for names with an unpromoted write (`vendor/swamp/design/primitives/data.md:364-370,415-418`).
- Swamp tests substitute capabilities by setting context fields directly ("Prefer an explicitly-set queryData (test fixtures)", `vendor/swamp/src/domain/models/in_process_executor.ts:238-240`).

## 2. Executed probes

Probe files are in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/ad7636de-38dc-43f8-be9c-777f41d00b8c/scratchpad/reads-probe/`. `standin.ts` defines a **STAND-IN** `ArtifactReader` and read-error classes that do not exist in the SDK. Type checks used the worktree's `tsc` with the repo's strict options, and a sanity file confirmed that real errors are reported. Runtime checks used `bun`.

| # | Probe | Result |
| --- | --- | --- |
| P1 | `get<A extends Artifact.Artifact>(A, NoInfer<A["refSchema"]["Type"]>)` infers the decoded type. A reference with another schema ID, `get` on a bytes definition and `stream` on a JSON definition are all rejected (`@ts-expect-error` fired). `page.rows[0].ref` feeds `get` directly. | Pass |
| P2 | Widening: a service type of `ArtifactStorage.Service & { get }` rejects a publish-only object in both `.of(...)` and `Layer.succeed(...)`. | Confirms breakage of `artifact-storage.test.ts:46` style fakes. |
| P3 | `Task.test(task.provide(Layer.succeed(ArtifactReader, emptyFixture)))`. The task publishes, then reads its own reference. | Publish returns `{artifactId:"test-artifact-1", digest:"test-digest-1"}`. The independent fixture returns NotFound. **A round trip needs harness design**, not just substitution. |
| P4 | `Stream.take(1)` over a stand-in byte stream whose last element performs the integrity check. | The finalizer ran (`closed = true`), but `verified = false`. An early-terminated consumer never learns about corruption. |
| P5 | A stand-in reader captured in a task and used after `Task.test` finished. | `Success`. Nothing enforces closure unless the runner-owned implementation gates every call and every stream pull through the publication lifetime. Fakes never will. |
| P6 | A task without `provide` that yields the stand-in. | The requirement stays visible in `Definition<_, R>`. For a runner-owned reader this disappears, as with ArtifactStorage. |
| P7 | `Schema.TaggedError` read errors used inside a task `error: Schema.Union([...])`. Tag extraction for `retry.when` accepts `"ArtifactReadUnavailable"` and rejects an undeclared tag. `Effect.catchTag(s)` narrows correctly. | Pass. Typed read errors **can** reach declared retry, but only if the author lists them in the task error schema. |

Not executed: real lake reads, reclamation races, kill/restart, and installed-extension imports. These are proof gates, not claims.

## 3. Swamp equivalents and accurate gap names

| Swamp | Effectory today | With the recommended contract |
| --- | --- | --- |
| `readResource(name, version?)`: own resource, latest default, `null` if missing | None in tasks. CLI `lake get` needs artifactId and version. | `reader.latest(Def, { output, key })` for the **calling task's own** identity, plus `get` for exact versions. Missing is a typed `ArtifactNotFound`, not `null`. |
| `readModelData(model, spec?)`: by configured name, newest per name, rename-tolerant | None | `reader.latest(Def, { task, output, key })` for another producer task. **Gap remains:** there are no configured model instances, and a task ID rename changes `artifactId` with no fallback. |
| `queryData(CEL, select?)` | CLI/RPC only | `reader.query(Def, { where, versions, ... })` over the existing AST, bound to one schema ID and version. **Gaps:** no cross-schema query, no arbitrary content predicate (declared fields only), no namespaces. |
| `DataRecord.content`: untyped JSON or text, binary not loaded | – | **Exceeds Swamp:** Schema-decoded value, plus a verified byte stream and an optional verified whole-bytes read. |
| Vault-reference rehydration on read | – | Out of scope (research §Scope). Say so in docs. |
| GC under a global lock, no reader pin | Producer-run protection only | **Exceeds Swamp** if consumer-run dependencies are adopted. |
| Test: assign `context.queryData` | – | `Layer.succeed(ArtifactReader, …)` or `Task.test({ artifacts })`. |

Do not describe this as "readModelData parity". It is typed exact and latest reads plus a typed metadata query. Named-instance resolution, rename recovery, namespaces and CEL stay out of scope.

## 4. Widen ArtifactStorage, or add a separate service?

**Recommendation: a separate runner-owned `ArtifactReader` service, modelled on `Report.History`.**

The case for widening is real. It gives one import and one `yield*` for a task that both produces and consumes, it is easy to discover, and it adds no new service to the SDK. Host wiring cost is irrelevant to the decision either way, because both options are a single `Context.add` in `definition()`.

The case against widening outweighs it for consumers:

- **It breaks existing fakes (P2).** Every `ArtifactStorage.of({ publish })` and `Layer.succeed(ArtifactStorage, { publish })` stops compiling. That includes the documented pattern in `docs/artifact-storage.md:59-61` and `artifact-storage.test.ts:46`. The fix is mechanical: add stubbed `get/stream/query/latest`. But then every publish-test author has to write read stubs that mean nothing to their test, and a stub that returns `Effect.die` hides misuse.
- **It cannot express a read-only dependency.** Reporter helpers and analysis Layers that only read would still receive `publish`, which fails with `UnknownOutput` on a reporter without outputs. With a separate service, a helper's `R = ArtifactReader` documents and enforces that it only reads.
- **Test substitution stays orthogonal.** A test can keep the real `Task.test` publication recorder and swap only the reader, or the reverse. With a widened service, overriding reads replaces the publish recorder too, because `docs/artifact-storage.md:59` says an inner fake "replaces the test recorder and production persistence".
- **The semantics differ.** Publish is output-membership-checked and identity-sensitive (it requires the declared instance). Reads deliberately are not (see §6.6). One service with two membership rules is harder to explain than two services.

The honest cost of a second service:

- A producer-consumer task does two `yield*` calls.
- Like ArtifactStorage, ArtifactReader is excluded from `Definition` requirements, so forgetting a fixture in `Task.test` is a runtime error, not a compile error. Mitigate this with the `Task.test` default in §6.8.
- It is one more name to learn.

If the user prefers widening anyway, ship it with a published `ArtifactStorage.publishOnly(fake)` helper that fills read members with a clear `TaskRuntimeError("ReadNotFaked")`. Record the break in the compatibility notes. Do not use optional members (`get?:`), which would push `!`/narrowing onto every consumer.

## 5. Recommended contract (proposed, not approved)

Shared schemas live in `@offtree/effectory-sdk` (core). Core cannot import runtime, so `Expression`, `Field`, `Record` and `QueryRow` move from `packages/runtime/src/lake-protocol.ts` into a core module (for example `packages/core/src/lake-query.ts`). Runtime re-exports them unchanged, so the wire schema does not change.

```ts
// PROPOSED. Not an SDK API. Names marked † are public decisions (§9).
export class ArtifactReader extends Context.Service<ArtifactReader, {
  /** Exact immutable read. Verifies kind, schemaId/version, artifactId/version and digest before decoding. */
  readonly get: <A extends Artifact.Artifact>(
    artifact: A, ref: NoInfer<A["refSchema"]["Type"]>
  ) => Effect.Effect<A["schema"]["Type"], Artifact.ReadError>;

  /** Bytes as a scoped Stream. Digest is known only at EOF; see stream integrity rules. */
  readonly stream: <A extends Artifact.Bytes>(
    artifact: A, ref: NoInfer<A["refSchema"]["Type"]>
  ) => Stream.Stream<Uint8Array, Artifact.ReadError>;

  /** † Whole bytes (≤ 16 MiB), verified before returning. */
  readonly bytes: <A extends Artifact.Bytes>(
    artifact: A, ref: NoInfer<A["refSchema"]["Type"]>
  ) => Effect.Effect<Uint8Array, Artifact.ReadError>;

  /** † Newest unreclaimed version of ONE identity, returned as a reference (not content). */
  readonly latest: <A extends Artifact.Any>(
    artifact: A,
    identity: { readonly output: string; readonly key: string; readonly task?: Task.Contract }
  ) => Effect.Effect<A["refSchema"]["Type"], Artifact.ReadError>;

  /** One page over the existing AST, bound to artifact.id/version. */
  readonly query: <A extends Artifact.Any>(
    artifact: A, options: Artifact.QueryOptions
  ) => Effect.Effect<Artifact.QueryPage<A>, Artifact.QueryError>;
}>()("@offtree/effectory-sdk/ArtifactReader") {}

// † Pagination helper: a plain function, not a service member, so fakes need not implement it.
export const queryAll: <A extends Artifact.Any>(
  artifact: A, options: Omit<Artifact.QueryOptions, "cursor">
) => Stream.Stream<Artifact.Row<A>, Artifact.QueryError, ArtifactReader>;

export interface QueryOptions {
  readonly versions: "latest" | "all";   // REQUIRED: semantic, no default
  readonly where?: Expression;          // existing AST, unchanged
  readonly orderBy?: Query["orderBy"];
  readonly select?: Query["select"];
  readonly limit?: number;              // default 50, max 200
  readonly cursor?: string;
}
export interface Row<A extends Artifact.Any> {
  readonly ref: A["refSchema"]["Type"];         // ready for get/stream
  readonly metadata: Omit<Record, "artifactId" | "version" | "digest" | "schemaId" | "schemaVersion">;
  readonly projection?: Readonly<globalThis.Record<string, Schema.Json>>;
}
export interface QueryPage<A extends Artifact.Any> {
  readonly rows: readonly Row<A>[];
  readonly cursor: string | null;
}
```

Error family (`Schema.TaggedError`, exported so authors can put them in their task error schema; P7):

| Tag | Meaning | Retry advice |
| --- | --- | --- |
| `ArtifactNotFound` | `{ artifactId, version, reason: "Missing" \| "Reclaimed" }`. Also returned for another principal's reference, so there is no existence oracle. | Never transient. `Reclaimed` tells operators what happened. |
| `ArtifactMismatch` | `{ reason: "Kind" \| "SchemaId" \| "SchemaVersion" \| "Digest" \| "Decode" }`. The reference or definition disagrees with stored metadata, or the stored value fails the supplied codec. | Never. A code or data bug. |
| `ArtifactCorrupt` | Stored bytes fail the digest or length check. | Never. An operator problem. |
| `ArtifactReadUnavailable` | Lease lost, store busy, invocation closed, or dependency limit reached. | The only transient tag. Authors who want declared retry add it to `error`. |
| `ArtifactQueryRejected` | `{ reason: "InvalidField" \| "Budget" \| "CursorExpired" }` (query only). | `CursorExpired` → restart the query. `Budget` → narrow the query. |

`ReadError = NotFound | Mismatch | Corrupt | ReadUnavailable`, and `QueryError = ReadUnavailable | QueryRejected`. Do **not** reuse `TaskRuntimeError`. With an unrestricted string `code` it is not narrowable, and as a host failure it is never retryable (fact §1). Messages must be fixed strings plus identifiers. A `Decode` mismatch must never echo the stored value or parse issues containing it, because the value may contain secrets.

Do not add `getOption`. `Effect.catchTag("ArtifactNotFound", …)` is one line (P3, P7). An Option helper would also collapse `Reclaimed` into "absent", which hides an operator-relevant fact.

## 6. Semantics, one item at a time

### 6.1 Names and defaults

- `ArtifactReader`, `get`, `stream`, `bytes`, `latest`, `query`, `queryAll`. Avoid `read` because it reads as a generic verb next to `get`. Avoid `download` because that is a CLI and file vocabulary.
- `versions` must be required. "Latest per identity" and "all history" are different questions, and silently defaulting either one is a bug factory.
- `limit` defaults to 50. The wire protocol requires a limit, but authors should not have to choose one for a first query.
- `QueryOptions` omits `artifact` and `version: 1`, because the definition binds them.

### 6.2 Latest

`versions: "latest"` already means newest **per artifactId**, which is correct. `latest()` exists only to reach one identity without first holding a reference. It must take the identity's public components `(task, output, key)` and never mean "newest row of the schema". `task` defaults to the calling task's ID, which gives Swamp's `readResource` equivalent. Implementation recomputes `sha256(principal, taskId, output, key)`. This is a **public commitment** that the identity derivation is stable. It would become an ABI the moment it ships.

As an alternative or complement, add `key` (and keep `output`/`taskId`) as queryable metadata. That is an additive change to `Field.metadata` and `Record`. It also requires backfilling existing rows: `publicationKey` stores `canonical([runId, invocationPath, output, key])`, so the key is recoverable (`lake.ts:208-213`).

State the rename gap: changing a producer task ID starts a new identity, and there is no fallback.

### 6.3 Query grammar reuse

Reuse the AST verbatim. Accept that `{ _tag: "Eq", field: { json: ["team"] }, value: "platform" }` is verbose. Field paths are not checked against `Def.fields` at compile time. Declared-field validation stays a runtime `ArtifactQueryRejected{InvalidField}`. A typed path helper may come later as a pure, additive constructor, not a second grammar.

The 10k-row / 250 ms budget needs an explicit position for in-task use:

1. Document that in-task queries must be narrowed by identity, run or tag.
2. Return the budget failure as the distinct tag above.
3. Make a proof gate show that a reporter's run-scoped query (`metadata runId = source.runId`) stays far below budget as unrelated history grows. Today the scan is principal + schema-wide, filtered in JS (`lake-query.ts:288-334`). A run-scoped query on a large lake will hit the budget unless an index on runId is added. That index is an internal change, not a public one.

### 6.4 Missing or reclaimed data, and version mismatch

- A reference produced by a v1 definition, read with a v2 definition, gives `ArtifactMismatch{SchemaVersion}`. There is no migration. Authors who must read old data keep exporting the old definition and branch on `ref.schemaVersion`. Document that pattern. A query bound to v2 never returns v1 rows, which is surprising after a schema bump, so document it next to versioning.
- Foreign-but-equivalent definitions (same id, version and kind, a different object instance, for example a consumer's own copy or an installed extension's export) **are permitted for reads**. Verification is structural: id, version, kind and contentType against stored metadata, then the codec decodes the value. If the consumer's codec rejects the stored value, the error is `Mismatch{Decode}`. Reads are not output-membership-checked and are not an ACL. The principal is the only boundary.

### 6.5 Stream integrity

`stream` delivers chunks before the digest is known. Document it plainly: corruption surfaces as `ArtifactCorrupt` at EOF, and a consumer that stops early (P4) never learns about it.

Offer `bytes()` (verified before return, ≤ 16 MiB, fits the existing binary limit) for consumers that must not act on unverified content, such as parsing a CSV or computing a decision. This is not buffering to simulate streaming. It is a separate guarantee.

Stream pulls after invocation close must fail with `ReadUnavailable`. That must be enforced per pull, not only at open (P5).

### 6.6 First-read race and consumer protection

What protection exists, by case:

- **Same-run references are already safe.** Inside one workflow run, the producer run is the consumer run. It is non-terminal, so the existing producer protection covers every version it published (fact §1). Say this prominently, because it is the common case.
- **Cross-run references** (in run input, from a query, from a report source) are the real problem.

Recommended guarantee:

1. **Successful exact access registers a consumer-run dependency atomically with the metadata check.** "Exact access" means `get`, `bytes`, `stream` open, and `latest` resolution. The dependency is registered on the lake connection, in the same non-yielding step as lookup (`lake-download.ts:20` already does lookup and open as one step). It protects while the consumer run is non-terminal, including `Waiting`, `NeedsAttention` and `Cancelling`. It survives attempts, retries and restarts. No user-visible lease.
2. **Run-input references are pinned at admission, using the schema rather than a shape scan.** Register every `referenceSchema` instance (as `Report.result` does with a WeakSet) and walk the encoded input along the task input schema's AST at admission. Fail admission with a clear error if a referenced version is already reclaimed. This removes the first-read race for operator-supplied and scheduled inputs, the case consumers will hit first. If the AST walk proves fragile (unions, suspends), fall back to stating the first-read boundary. Do **not** scan JSON for reference-shaped objects.
3. **Query results are not pinned.** Between `query` and `get`, a row can be reclaimed. The result is `ArtifactNotFound{Reclaimed}`, and consumers handle it with `catchTag` like any other missing row. Cursors already become `CursorExpired` when reclamation removes the snapshot row. Map that to `QueryRejected{CursorExpired}`.
4. **Report obligations protect their source run's publications.** While a report record for source run S is unsettled (WaitingSource, Queued, Running or NeedsAttention), treat S's publications as protected. This is bounded by S's own publications and closes the queue gap between the source turning terminal and the report run's first read (fact §1: promoter queue, four-slot budget). Without it, a promised feature ("reporters read artifact content") fails exactly when queues are long. A **later explicit regeneration** gets no such promise: the reporter sees `NotFound{Reclaimed}` and must render that.
5. **Bounds.** Cap dependencies per run (for example 10,000 versions). Once the cap is reached, further reads fail with `ReadUnavailable{reason: DependencyLimit}`. Do not silently stop pinning. Dependency rows are deleted only after recovery has observed the consumer run as terminal, never on attempt failure. Cancelling the consumer run always releases its protection, so reclamation never becomes permanently unavailable.

### 6.7 Live queries across retries

Make queries and `latest` **live per attempt**, not journaled. This is the Effect-natural meaning (an Effect re-runs on retry), it matches Swamp, and journaling query results would add a second durable store for questionable value.

Document the consequence: a retry can see a newer latest. The pattern for determinism is to resolve in one task and pass the exact reference to the next (example 7.2). Exact `get` is deterministic by immutability. A dependency registered by attempt 1 still protects attempt 2.

### 6.8 Tests

`Task.test` gains an `artifacts` fixture option, plus a fixture constructor that produces **real** references:

```ts
// PROPOSED
const fx = Artifact.fixture(
  Doc,
  { team: "platform", n: 3 },
  { key: "nightly" }
); // canonical encode + real sha256
yield * Task.test(consumer, { input: { doc: fx.ref }, artifacts: [fx] });
```

Default reader in `Task.test`:

- It serves exactly the supplied fixtures, with the same verification as production: kind, schema, digest and decode.
- `query` filters fixtures with the same AST evaluator. Reuse `lake-query.ts`'s pure `matches`/`order` after moving them into core. Do not write a second evaluator.
- A reference not in the fixtures gives `NotFound{Missing}`, with a message that names the fixture option.

Recommended: **Do not** make the test's own synthetic publications (`test-digest-N`) readable. They are not real digests and would masquerade as lake reads.

The alternative, which is a public decision: change the recorder to emit real sha256 digests and make own publications readable. That changes `TestPublication.reference.digest` values (a visible compatibility change) but gives a true round trip within a single test. I lean towards the explicit-fixture approach plus a two-step test (example 7.6).

### 6.9 Lifetime and DI

The reader goes through `lifetime.run` exactly like publish. It works in task-local Layer acquisition and in the handler, and it fails `ReadUnavailable` once `lifetime.close` has run. That means **Layer finalizers cannot read**; state this.

Use the same override rule as ArtifactStorage: an inner `task.provide(Layer.succeed(ArtifactReader, fake))` wins, and an application-level fake is overridden by the runner.

Fakes do not inherit closure, pinning or verification (P5). Document this in the same words as `docs/artifact-storage.md:59`.

### 6.10 What reclaim operators see

Reclamation operators need to know _why_ something is held, or the feature looks like a leak:

- Keep `protectedVersions` as the total (approved meaning).
- Add, additively, `protectedBy: { producerRun: n, consumerRun: n, reportObligation: n }` to the plan.
- Have `lake versions` items carry `protectedBy` with up to N consumer run IDs.
- `reclaimedBytes`/`pendingBytes` meanings are unchanged. Apply re-checks consumer protection inside the apply transaction, as it already re-checks producer status (`lake-reclamation.ts:610-616`). A version that becomes protected between plan and apply is counted in `skippedVersions`.
- Operator remedy text: "cancel or finish run X to release".
- A long durable `Waiting` consumer holds data indefinitely, and that is intended. Show it, don't hide it.

## 7. Full consumer examples (proposed API; not checked against an SDK)

The probes verified the signatures with a stand-in. These examples are illustrative.

```ts
import {
  Artifact,
  ArtifactReader,
  ArtifactStorage,
  Task,
  Workflow,
} from "@offtree/effectory-sdk";
import { Effect, Schema, Stream } from "effect";

const Inventory = Artifact.make({
  id: "acme/inventory",
  version: 1,
  schema: Schema.Struct({
    team: Schema.String,
    hosts: Schema.Array(Schema.String),
  }),
  fields: [["team"]],
});
const Snapshot = Artifact.make({
  id: "acme/snapshot",
  version: 1,
  kind: "bytes",
  contentType: "application/gzip",
});
```

### 7.1 Produce → reference input → typed get (same run, already protected)

```ts
const collect = Task.make(
  {
    id: "acme/collect",
    version: 1,
    replay: "idempotent",
    input: Schema.Struct({ team: Schema.String }),
    success: Schema.Struct({ inventory: Inventory.refSchema }),
    error: Schema.Never,
    outputs: { inventory: Inventory },
  },
  ({ team }) =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      const inventory = yield* storage.publish(
        Inventory,
        { team, hosts: ["a", "b"] },
        { key: team }
      );
      return { inventory };
    })
);

const audit = Task.make(
  {
    id: "acme/audit",
    version: 1,
    replay: "idempotent",
    input: Schema.Struct({ inventory: Inventory.refSchema }),
    success: Schema.Number,
    error: Schema.Union([Artifact.ReadUnavailable]), // opt into declared retry
  },
  ({ inventory }) =>
    Effect.gen(function* () {
      const reader = yield* ArtifactReader;
      const value = yield* reader.get(Inventory, inventory).pipe(
        Effect.catchTags({
          // non-retryable → host failure, explicitly
          ArtifactNotFound: Effect.die,
          ArtifactMismatch: Effect.die,
          ArtifactCorrupt: Effect.die,
        })
      );
      return value.hosts.length;
    })
);

export const nightly = Workflow.make(
  /* … */ (w) => {
    const c = w.task(collect, { team: "platform" });
    return w.task(
      audit,
      { inventory: c.inventory },
      {
        retry: {
          attempts: 3,
          delay: "5 seconds",
          when: ["ArtifactReadUnavailable"],
        },
      }
    );
  }
);
```

The three-line `catchTags` → `die` is the boilerplate cost of typed errors. That is acceptable, and the alternative (one opaque error) cannot be retried at all.

### 7.2 Query existing records → feed refs to get (cross-run)

```ts
const compare = Task.make(
  {/* … success: Schema.Array(Schema.String), error: Schema.Never */},
  () =>
    Effect.gen(function* () {
      const reader = yield* ArtifactReader;
      const page = yield* reader
        .query(Inventory, {
          versions: "latest",
          where: { _tag: "Eq", field: { json: ["team"] }, value: "platform" },
          orderBy: [{ field: { metadata: "committedAt" }, direction: "desc" }],
          limit: 2,
        })
        .pipe(Effect.orDie);
      return yield* Effect.forEach(page.rows, (row) =>
        reader.get(Inventory, row.ref).pipe(
          // pins on success
          Effect.map((v) => `${row.metadata.committedAt}: ${v.hosts.length}`),
          Effect.catchTag("ArtifactNotFound", () =>
            Effect.succeed(`${row.ref.version}: reclaimed`)
          ),
          Effect.orDie
        )
      );
    })
);
```

### 7.3 Latest of one identity

```ts
const ref =
  yield *
  reader.latest(Inventory, {
    task: collect,
    output: "inventory",
    key: "platform",
  });
const current = yield * reader.get(Inventory, ref);
```

### 7.4 Stream bytes, with and without verification

```ts
// Streaming to a side-effecting sink: corruption only surfaces at EOF.
yield * reader.stream(Snapshot, snapshotRef).pipe(Stream.run(uploadSink));
// Need verified content before acting:
const gz = yield * reader.bytes(Snapshot, snapshotRef);
```

### 7.5 Reporter reading run content

```ts
const InventoryReport = Task.make(
  {
    id: "acme/inventory-report",
    version: 1,
    replay: "idempotent",
    input: Report.sourceOf(nightly),
    success: Report.result(Schema.Struct({ hosts: Schema.Number })),
    error: Schema.Never,
  },
  (source) =>
    Effect.gen(function* () {
      const reader = yield* ArtifactReader;
      const page = yield* reader
        .query(Inventory, {
          versions: "all",
          where: {
            _tag: "Eq",
            field: { metadata: "runId" },
            value: source.runId,
          },
        })
        .pipe(Effect.orDie);
      const values = yield* Effect.forEach(page.rows, (r) =>
        reader.get(Inventory, r.ref).pipe(Effect.option)
      ); // Option is fine HERE: report renders absence
      const hosts = values.flatMap((v) =>
        v._tag === "Some" ? v.value.hosts : []
      ).length;
      return {
        data: { hosts },
        markdown: `**${hosts}** hosts (${values.filter((v) => v._tag === "None").length} unreadable)`,
      };
    })
);
```

Without the report-obligation protection in §6.6.4, this reporter fails intermittently whenever a Selection reclamation runs while it is queued.

### 7.6 Tests

```ts
// Consumer, isolated, with a real-digest fixture.
const fx = Artifact.fixture(
  Inventory,
  { team: "platform", hosts: ["a"] },
  { key: "platform" }
);
const r =
  yield * Task.test(audit, { input: { inventory: fx.ref }, artifacts: [fx] });

// Producer → consumer: two steps, explicit hand-off.
const produced = yield * Task.test(collect, { input: { team: "platform" } });
const pub = produced.publications[0]!; // JSON publication
const fx2 = Artifact.fixture(Inventory, pub.value as never, {
  key: "platform",
});
yield * Task.test(audit, { input: { inventory: fx2.ref }, artifacts: [fx2] });

// Arbitrary substitution: plain Layer.
yield *
  Task.test(audit.provide(Layer.succeed(ArtifactReader, myFake)), {
    input: { inventory: fx.ref },
  });
```

The `as never` in the two-step test shows a real typing gap. `TestPublication.value` is `Schema.Json`, so feeding it back needs a decode: `Schema.decodeUnknownSync(Inventory.schema)(pub.value)`. Document that, or make `Artifact.fixture` accept encoded JSON.

### 7.7 Installed extension

```ts
import ext from "./effectory.extensions.ts";
const { Inventory: ExtInventory } = ext.artifacts;
const v = yield * reader.get(ExtInventory, ref); // structural verification; no output membership needed
```

Proof gate: the generated facade's declared `refSchema` keeps the literal `schemaId`, so P1's wrong-reference rejection holds across the facade.

## 8. Does the scope let consumers use the lake?

It does, with the recommended additions, and not without them:

- **Exact reads, decoding and streams** are the part that genuinely beats Swamp (typed values, verified bytes).
- **Discovery** is usable only with a ready `ref` on each row (recommended), required `versions`, a sensible default limit, and an addressable identity (`latest` and/or a `key` metadata field). Without identity addressing, the realistic in-task question "what's the current inventory for team X" depends on authors remembering to add tags at publish time. That is a convention, not an API.
- **Reliability** depends on retryable typed errors, protection for run-input references at admission, and report-obligation protection. Without those, consumers will see intermittent `NotFound` that they cannot reproduce in tests.
- **Testability** depends on real-digest fixtures. Substitution alone (P3) doesn't test the producer → consumer contract.

## 9. Essential public decisions for the user

1. Separate `ArtifactReader` (recommended) or widen `ArtifactStorage`, with the publish-only fake break documented and a helper provided.
2. A typed read-error family (recommended, five tags) or `TaskRuntimeError` codes. Also confirm that typed read errors are opt-in in the task error schema for retry.
3. Identity addressing: `latest(Def, { task?, output, key })` with the identity derivation as a stable public contract, and/or `key` added as queryable metadata (with a backfill), or neither (tags only).
4. Include `bytes()` (verified whole read) in addition to `stream()`.
5. Consumer-run dependency on successful exact access (recommended), including the per-run cap and its failure mode.
6. Pin run-input references at admission using the schema (recommended), or document a first-read boundary.
7. Report obligations protect their source run's publications (recommended). Later explicit regenerations get no promise.
8. Queries and `latest` are live per attempt (recommended), not journaled.
9. `Task.test` reads: explicit real-digest `Artifact.fixture` only (recommended), or a recorder changed to real digests so a task's own publications are readable.
10. Cross-definition reads are structural and permitted (recommended). This confirms that output membership is not a read ACL.
11. Defaults: `versions` required, `limit` default 50. Whether `queryAll` ships in the first slice.
12. Additive operator surfaces: `protectedBy` breakdown in plan and versions output. The meanings of `reclaimedBytes`/`pendingBytes`/`protectedVersions` stay unchanged.

## 10. Blockers before a contract is presentable

- B1: Identity addressing (decision 3). Without it, `latest` cannot be specified and discovery relies on tags.
- B2: The error channel (decision 2). This determines every example's boilerplate and retry behaviour.
- B3: Reporter protection (decision 7). Reporters are in scope, and without protection their reads are unreliable by design.
- B4: The move of `Expression/Field/Record` into core so the SDK can type `QueryOptions`. This is mechanical, but the wire schemas must be byte-identical. Add a proof that old and new decodes are equal.
- B5: The `Task.test` read semantics (decision 9). Without them, the "complete example" required by the research cannot be written honestly.

## 11. Existing compatibility changes

- Widening only: every explicitly typed `ArtifactStorage` fake breaks (P2). This is avoided by the separate service.
- `Field.metadata` gains `key` (if chosen). This is additive to the wire. Old clients that decode `QueryRow` with an exact schema are unaffected because they never request it. Existing rows need a backfill from `publicationKey`.
- Reclamation plan and versions gain optional `protectedBy` fields (additive). Protection grows, so some versions that were reclaimable before are now protected. That is a behavioural change operators will notice and must be in release notes.
- Recorder digests change only if decision 9's alternative is chosen.
- `Lake.get` internal semantics tighten: reference digest and schema are now checked. CLI `lake get` keeps its looser by-ID behaviour.

## 12. Proof gates

1. Type: inference of the decoded value, rejection of a wrong-ID reference, `get` refusing bytes and `stream` refusing JSON, a row's `ref` feeding `get`, and the reference type surviving the extension facade. (P1 covers the stand-in; repeat on the real SDK and on a generated facade.)
2. Forged references: a wrong digest, schemaVersion, kind or artifactId, and another principal's reference. Each returns the specified tag and never content.
3. A real read/reclaim race: `get` concurrent with Selection apply. Either content plus a registered dependency, or `NotFound{Reclaimed}`; never content without a dependency.
4. Dependency durability: attempt failure → retry; kill -9 while the consumer is `Waiting`; restart. Protection persists, and it is released only after the consumer is observed terminal.
5. Run-input admission pinning, including references nested in union and optional input fields. A reclaimed input reference rejects admission.
6. Report-obligation protection across a long promoter queue. Regeneration after reclaim renders `NotFound{Reclaimed}`.
7. Plan/apply re-check: a version gains consumer protection after planning and lands in `skippedVersions`, with bytes accounting unchanged.
8. Stream: early `take`/interruption closes the descriptor and the fiber. Corruption at EOF fails as `ArtifactCorrupt`. A pull after invocation close fails. A reader in a Layer finalizer fails. A reader captured in a detached fiber fails (P5 inverted for the real implementation).
9. Query: paging across a reclamation gives `CursorExpired`. A run-scoped reporter query stays within budget on a lake with 100k unrelated rows of the same schema.
10. Retry: `ArtifactReadUnavailable` declared in `error` plus `retry.when` retries. An undeclared one fails as a host failure with a clear message.
11. `Task.test`: fixture verification parity with production, the AST evaluator shared with the daemon (same results on the same rows), and own synthetic publications not readable (if decision 9 is the recommended option).
12. Old publish-only fakes still compile (separate service). Standalone helper effects keep `ArtifactReader` in `R`. `Definition` excludes it.
13. A consumer codec that fails on stored content containing a vault secret: the error and logs contain no value.
