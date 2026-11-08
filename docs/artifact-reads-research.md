# Artifact reads inside tasks — design research

Status: research/design critique requested; **no new public API is approved**. The previous goal turn was progress: the approved reports slice was implemented and verified by 352 passing tests, typecheck and lint. The broader parity goal remains active. This document selects the next gap and supplies candidate contracts for Claude's independent Effect and consumer reviews. It is not an implementation instruction.

## Why this feature

Swamp methods can consume existing stored data as part of their work. Effectory's task-facing ArtifactStorage currently only publishes. The CLI/RPC can get/query/download data, but a consumer task or reporter cannot use a supported injected reader. Adding this capability makes the existing lake useful as shared workflow data and lets reporters inspect artifact content.

Source evidence, read locally on 2026-11-06:

- `vendor/swamp/src/domain/models/model.ts:204–220`: readResource, readModelData and queryData method-context capabilities.
- `vendor/swamp/src/domain/data/data_access_service.ts:127`: readModelData resolves identity and namespace and uses the query service, including identity fallback after a rename.
- `vendor/swamp/design/primitives/data.md:294–325`: exact/latest reads, CEL accessors, in-method queries, JSON/text content and resource vault-reference resolution. These are source/documentation findings, not an executed Swamp integration test.
- `packages/core/src/artifact-storage.ts`: one invocation-owned Effect service, currently with publish only.
- `packages/core/src/artifact.ts`: immutable references carry artifactId, version, digest, schemaId and schemaVersion. JSON definitions own codecs; bytes definitions own MIME type. A reference narrows schemaId, but its schemaVersion is a number, not a literal.
- `packages/runtime/src/lake-protocol.ts`: existing Schema-based query AST, projections, metadata pages, cursors and version listing. This grammar is already public through RPC/CLI.
- `packages/platform-bun/src/lake.ts:385–412,528–548`: bytes download, JSON get with digest/size verification, query and versions. JSON get is synchronous and bounded at 1 MiB. Bytes download is a Stream backed by an open file descriptor.
- `packages/platform-bun/src/lake-reclamation.ts:444,615`: protection currently follows unfinished producer runs. There is no consumer dependency/pin table.
- `docs/artifact-retention-api-draft.md:88`: the approved retention contract explicitly requires revisiting cross-run pinning before adding an in-run content reader. Its older prospective reader-lease paragraphs were superseded for CLI byte downloads by the approved POSIX opened-descriptor design; do not accidentally reintroduce pendingBytes lease semantics.
- `packages/core/src/task.ts`: ArtifactStorage is installed inside definition(), works for task-local Layers, and is excluded from exposed task requirements. A fresh invocation memo map isolates resource acquisition. The publication lifetime already spans Layer acquisition and handler execution, and closes before finalizers release dependencies.

The vendored repository is reference material only; do not modify it. Its own app-specific AGENTS/skills do not change Effectory's authoring vocabulary.

Executed storage probes are recorded in [artifact-reads-evidence.md](artifact-reads-evidence.md). They confirm that a waiting consumer's input reference does not protect content today, and that the current binary download checks its digest only at EOF. These are existing-behavior findings, not proofs of the proposed reader contract.

## Scope to design

Cover exact immutable-reference reads of JSON and bytes, discovery through the existing bounded query AST, task-local Layer/Scope ownership, standalone substitution/testing, extension imports, and safe interaction with retries/reclamation. Include reporters as ordinary consumers. Do not substitute an HTTP wrapper around the CLI, another bespoke query language, or a metadata-only feature for actual content reads.

Do not promise full CEL/configured-model parity: named model-instance resolution, namespace federation, arbitrary CEL expressions, data mutation/deletion from tasks, and automatic vault-reference rehydration need separate contracts. SQL/DuckDB expressiveness remains a separate query-engine decision; reuse the existing AST for this feature.

## Candidate consumer API for critique

The user's established direction is to yield capabilities through Effect DI, not add methods to the task handler context. The most consistent candidate is widening ArtifactStorage:

```ts
// PROPOSED sketch; not a checked SDK example, and not approved.
const storage = yield * ArtifactStorage;
const document = yield * storage.get(Document, reference);
const byteSource = storage.stream(Archive, archiveReference);
const page =
  yield *
  storage.query(Document, {
    versions: "latest",
    where: { _tag: "Eq", field: { tag: "team" }, value: "platform" },
    limit: 20,
  });
```

Questions the reviews must resolve rather than silently choose:

1. Should reads widen ArtifactStorage, or use a separate read-only Effect service? Widening breaks existing explicitly typed publish-only fakes; splitting services can express a read-only dependency and preserve those fakes, but needs another runner-owned requirement. Both must remain ordinary Context services with Layer substitution. Explain the consumer tradeoff; do not favor a second service merely because host wiring is easier.
2. For JSON, prefer `get(Definition, Ref): Effect<decoded value,...>` over casting raw JSON. Artifact definition determines the type; ref cannot widen inference. Check kind, schema ID/version, artifact ID/version and digest against stored metadata before returning any content. Decide whether foreign-but-equivalent definitions are permitted for reads; output membership rules should not automatically become read ACLs. Reading an artifact need not declare it as a task output.
3. For bytes, compare `stream(Definition, Ref): Stream<Uint8Array,...>` with a single kind-dependent `get`. Expose standard Stream/Scope composition and early cancellation, avoid buffering 16 MiB to simulate streaming, and state when integrity is known. A stream can deliver bytes before its final digest check, so downstream side effects may already have happened when corruption is detected.
4. Queries should bind schemaId/version from Definition and reuse the existing AST. Optional versions defaults, limits, ordering, projections and cursor membership must be explicit. Rows should provide directly usable exact references and metadata, not require consumers to hand-assemble a reference. Decide whether the API returns one page only or also a normal Effect Stream pagination helper. Do not invent a second set of And/Eq/etc combinators without a compelling need.
5. Is exact-reference access plus query enough, or does a latest convenience earn its place? "Latest" must be within one artifact identity (publication key), not arbitrarily the newest row of an entire schema. Swamp's configured model/name lookup has no direct equivalent here. Do not hide that difference behind an ambiguous method name.
6. Error channel: existing TaskRuntimeError has an unrestricted string code and becomes a host failure (not a declared retryable domain error). It is convenient for handler types, but a transient read failure would not automatically follow declared task retry tags. Compare reusing it with a small typed read-error family. Missing/reclaimed content must be distinct from corruption and schema mismatch; do not turn every invalid value into Option.none. State whether any optional-read helper is justified.

## Durability and reclamation are part of this feature

An open POSIX descriptor protects one byte stream from unlinking, but it does not protect a later attempt or another task in a waiting workflow. A terminal producer's data can currently be reclaimed even while another unfinished run needs it. Neither a Scope nor a Layer alone solves that durable dependency.

Candidate direction to assess: successful exact reads atomically register a durable consumer-run dependency on the exact version before exposing content; reclamation treats it as protected while that consumer run is unfinished (including Waiting/NeedsAttention/Cancelling). Dependencies survive attempt failure, retry, process death and durable waits; they cease protecting after the consumer run terminates. No public lease/release ceremony for routine reads. Determine admission bounds, receipt semantics and the existing reclaim plan/apply changes this requires.

Do not overstate that candidate:

- A reference passed as input may be reclaimed before the task first reads it. Decide whether to pin declared reference inputs at admission, require an explicit acquisition operation, or state the first-read boundary. Arbitrarily scanning JSON for reference-shaped objects is not automatically correct.
- Query results are metadata. Pinning every matching row forever can fill the store, but query-to-get races exist without pins. Decide the exact guarantee and cursor invalidation behavior.
- Retrying the entire task may issue a fresh query and see a different latest version. Decide whether reads/queries are live per attempt or journaled. Immutable exact references do not make a query snapshot durable across attempts.
- A later explicit report generation is a new run after the source finished. Existing report history may reference content that has since been reclaimed. Do not promise indefinite replay of that content without a retention contract.
- Reader dependency insertion and reclamation use the lake connection/ownership boundary. The host store and engine use other SQLite connections. Do not write through a second connection inside a transaction.
- Plan/apply must re-check consumer protection after plan creation. Preserve the approved meanings of reclaimedBytes/pendingBytes unless the user explicitly approves an amendment.
- Do not erase dependency history before recovery can determine whether its consumer really finished. Bound new reads without making cancellation or reclamation permanently unavailable.

## Ownership, codecs and tests

Readers must be lazy and invocation-owned, usable from task-local Layers and released before those Layers close. Define whether finalizers can read or are already closed. A service captured in a detached fiber must not remain a working reader after the invocation closes. Preserve application-vs-task override rules and isolated memo maps. Plain Layer.succeed is the substitution tool; disclose any generic fake typing gaps.

Place shared schemas in a dependency-safe module (core currently cannot import runtime). Reuse Effect Schema for boundaries, Schema decoding for the value, Stream for bytes/pagination, Context for injection, Layer for providers and Scope for file/resource ownership. Schema decoding can throw synchronously or return an Effect; wrap calls lazily and decide sync/async codec support deliberately. Never decode arbitrary author code inside a SQLite transaction.

Task.test needs a credible consumer path: explicit fixture storage, an ordinary replacement Layer, or another small approved mechanism. Existing publication recording and synthetic reference digests must not silently masquerade as real lake reads. A complete example must show producing, passing a reference to another task, reading it, querying older data, streaming bytes, and testing with a fake/fixture. Installed extension definitions must retain their type/provenance behavior.

Proof gates include real read/reclaim races; retry and kill/restart while a consumer waits; false/forged references and schema versions; early stream cancellation and corruption at EOF; no descriptor/fiber leak across finalizers; query paging/reclamation invalidation; cross-principal authorization; read fixture semantics; API inference, wrong-ref rejection and standalone requirements; old publish-only fake impact; source/extension canonicalization; and no secret leak through codec errors in a consuming task.

## Review process

Claude Effect and consumer design critiques should be written to distinct files. They may propose better signatures and test stand-ins against pinned Effect 4.0.5, but must mark them as stand-ins. Findings must distinguish source facts, executed probes and recommendations. Review approval is not user approval. The parent will consolidate a precise contract, resolve disagreements, obtain any required re-review, and present only then. Production implementation waits for the user's approval.
