# Queryable data lake

The bounded v0 implementation is JSON-only and retains every artifact. See `packages/runtime/src/lake-protocol.ts` for the executable query contract. The original broader design below includes deferred binary, TTL/GC and migration features.

Implemented predicates are `And`, `Or`, `Not`, `Eq`, `Gt`, `Gte`, `Lt`, `Lte`, and `In`. Fields are `{ metadata: "runId" }`, `{ tag: "environment" }`, or declared `{ json: ["status"] }` paths. A projection is `select: [{ name: "status", field: { json: ["status"] } }]`; an order is `orderBy: [{ field: { json: ["status"] }, direction: "asc" }]`. Rows retain provenance metadata and add `projection` when requested. Missing projected values are omitted; explicit null remains null. Ordered fields require one encoded string/number type, optionally null. The schema-derived field catalogue follows references, unions, optional fields and array paths; unsupported intersections/recursive declarations fail authoring instead of guessing types.

Queries scan persisted metadata/projections, without reading blobs. The schema/principal/sequence index narrows the scan; predicate evaluation and ordering are bounded residual work. Defaults are 64 KiB of query JSON, depth 8 / 64 predicate nodes, 32 In values, 32 selected fields, 4 ordering fields, 200 rows per page, 10,000 scanned rows, 16 MiB of scanned metadata, a 250 ms checked work budget and 2 MiB of row data per page. Work-budget exhaustion returns `QueryBudgetExceeded`, never an apparently complete partial page. The time budget is checked between synchronous scan/sort stages; it cannot preempt one SQLite call or arbitrary synchronous application code. Latest versions are resolved as of the fixed commit snapshot; order ties use artifact ID/version. Signed cursors bind the complete query and principal and expire in one hour. Version-history pages and exact reads authorize before returning metadata.

## Data model

The initial lake combines immutable local blobs and authoritative SQLite metadata. An artifact specification has a namespaced ID, schema version, content type and retention default. Each committed record has repository ID, logical artifact ID/name, monotonic version, schema ID/version, digest, byte length, creation/commit time, tags, lifetime, and producer provenance (run, task, workflow, step, attempt and extension revision). References always include an exact version. `latest` is a query convenience resolved to a concrete reference before it becomes a durable workflow input.

JSON resources are schema-validated before encoding. Files are streamed with content type and size limits. Task results and run logs are separate records with artifact references; they are not automatically all materialized as lake resources. Tags are string metadata, not arbitrary secret-bearing payloads.

## Publication and consistency

1. Write bytes to a temporary blob while computing a digest; finish validation.
2. Flush and atomically place the immutable blob at its digest location.
3. In one SQLite transaction allocate a version, insert artifact metadata and provenance, update latest, and append the publication event.
4. Commit before returning an ArtifactRef or notifying query/watch clients.

Use a publication key derived from run, step, logical output name and write ordinal so replay after a crash does not publish a second version of the same write. Different bytes for the same publication key are a conflict. Concurrent writers allocate versions transactionally; latest means highest committed version, not newest wall-clock timestamp. A failed transaction may leave an unreferenced blob for later GC; it must not expose metadata pointing at incomplete bytes. This ordering handles artifacts and task completion in separate transactions: a replay can look up the prior publication key.

Planning refinement: the [task publication proposal](task-implementation.md#identity-retries-and-publication) recommends replacing the incidental write ordinal above with an explicit stable caller key. This avoids identity changes caused by concurrent write ordering. That adjustment, including metadata in duplicate comparisons, needs the same publication/restart proof before adoption.

SQLite WAL and a single writer give read-after-commit consistency in the local backend. A remote backend must advertise its publication/transaction semantics; reject it if it cannot meet the selected runtime's contract. Content-addressed blob storage is an Effectory proposal, not Swamp's UUID artifact identity model.

## Query boundary

Define an Effect Schema tagged AST rather than evaluating JavaScript or exposing raw SQL over RPC. Initial nodes: `And`, `Or`, `Not`, equality/range comparisons, `In`, tag lookup and declared JSON field lookup. Missing field, null and type mismatch have distinct documented semantics: missing comparisons are false, explicit null matches only null, and incompatible ordered comparisons are a query validation error. Version selection is explicit (`latest` or `all`).

Proposed `query.json`:

```json
{
  "version": 1,
  "artifact": { "schemaId": "example/host", "schemaVersion": 1 },
  "versions": "latest",
  "where": {
    "_tag": "And",
    "terms": [
      { "_tag": "Eq", "field": { "tag": "environment" }, "value": "prod" },
      { "_tag": "Eq", "field": { "json": ["status"] }, "value": "failed" }
    ]
  },
  "select": ["id", "name", "version", "producer.runId"],
  "orderBy": [{ "field": "committedAt", "direction": "desc" }],
  "limit": 100
}
```

Compile allowed metadata predicates and declared indexed JSON paths into parameterized SQL. Validate field paths and comparison types against the artifact schema. JSON query projections are populated from validated resource content in the same publication transaction. Arbitrary binary content searches and joins are deferred. Unindexed JSON filters may use a bounded residual scan after SQL prefiltering; report QueryBudgetExceeded rather than silently returning a partial complete result. Metadata-only queries must not read blobs.

Query results include rows, snapshot high-water mark, optional next cursor and statistics (scanned/matched rows and bytes). Apply authorization before limit, projection and count. Bound AST depth, term count, page size, scan budget, content bytes and execution time. Reject unknown query versions and invalid cursors.

Pagination uses a stable total order with artifact identity/version as a tie breaker, a high-water commit sequence, and a cursor bound to the canonical query and principal scope. New writes do not drift into an existing page sequence. Latest is computed **as of that high-water mark**, not from a mutable latest flag. A retention lease preserves the required versions for the cursor's bounded lifetime; expired cursors return CursorExpired. A new query sees new commits.

The same query spec powers `Lake.query`, RPC and the CLI. Typed library helpers may derive projected row types when the schema is statically known. Dynamic queries return schema-tagged JSON, not an unsound claimed generic type. A later SQL analytics adapter can expose read-only views without making the control plane accept unrestricted SQL.

## Retention, lineage and recovery

Support retained, TTL, keep-last-N and run-scoped lifetimes. Ephemeral in-memory artifacts cannot be used as persisted inputs across suspension or restart; validation rejects such graph edges unless explicitly materialized. GC respects active run references, waiting workflows, query leases and explicit pins before TTL/version-count deletion. Tombstone metadata before collecting unreferenced bytes; retain lineage and a typed ContentExpired response as policy permits. Shared digests are collected only after all live references expire.

Every artifact points back to the run, spec revision and exact upstream artifact versions used. Query results consumed by a workflow are recorded as an activity result, so resume does not rerun a changing `latest` query. Schema evolution creates a new version; explicit migration tasks publish new artifacts with links to their originals. Do not reinterpret old JSON through a new decoder silently.

Repair verifies blob digests and catalog references, rebuilds derived indexes and reports missing/corrupt content. Backup/restore tests must include the database, blobs and pinned extension bundles. Swamp's relevant precedents are [data](../vendor/swamp/design/primitives/data.md) and [query implementation](../vendor/swamp/src/domain/data/data_query_service.ts).
