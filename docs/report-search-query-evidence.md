# Report search — pre-implementation query evidence

2026-11-06. This is research for the unapproved [report search draft](report-search-api-draft.md), not an implementation or approval. No production source was changed. The two design reviews were already requested; this independent probe does not substitute for them.

## Tested model

Scratch source: `/tmp/effectory-report-search-probes/query.ts`. Output: `/tmp/effectory-report-search-probes/query.log`. Source SHA-256: `851f15985dcdd514522267a0a1930cc009ce09975e1c643d75f742df373694e9`.

The script uses Bun's real SQLite database in memory, with simplified report groups, generations and source-run tag tables. It seeds 200,000 groups/generations, adds a later failed retry, and adds sparse and broad tag populations. Its proposed immutable search columns and indexes do **not** exist in Effectory. The model omits real source/plan joins, status projection, RPC serialization, page-byte accounting, asynchronous request ownership and migration. It therefore proves selected SQL/ordering properties, not the proposed feature.

Assertions passed:

- Both exact tag filters must match. A key containing `.` and `/` is bound as a literal value.
- A different principal returns no rows.
- A fixed first-page watermark continues to select the older generation after a new failed retry is inserted.
- A new search selects that failed generation; filtering for Succeeded does not fall back to the older success.
- A candidate scan over the fixed watermark advances through empty substring-match batches without dropping or duplicating matches. There were 20 candidate batches of 10,000, 17 empty batches and 11,111 total matches, agreeing exactly with an independent descending reference list. These were candidate batches, not complete API pages with the 200-item/2 MiB limits.

## Findings that affect the draft

### Sparse exact tag narrowing is feasible

With two bound tags selecting one source run, SQLite used the covering tag lookup index, the `(principal, runId)` group index and the per-group generation index. It returned the one intended generation. Observed time was about 0.9 ms on the final run (2.1 ms on an earlier run). This uses the proposed indexes, not today's schema.

### LIMIT does not bound broad-filter work

With the same two-tag query matching all 200,000 source runs, LIMIT 51 still materialized broad tag subqueries and sorted the matching generations in a temporary B-tree. It took about 637 ms on the final run and 1,284 ms on the earlier run. Only 51 rows were returned. Neither measurement is a latency guarantee; the counterexample is that a small output limit did not constrain the SQLite work. The synchronous query blocks the host event loop while it runs.

Draft 1 explicitly reserves this as a proof gate. It must not be presented as solved merely by promising structured predicates before a LIMIT. Additional testing needs many generations per group, many groups per root, sparse statuses, dense tags, and old watermarks after many retries.

### A bounded sequence window avoids that broad-filter shape

An alternative probe first materialized at most 256 generation positions by the sequence primary key. It then performed primary-key group lookups, correlated per-run/key tag lookups, and latest-at-watermark checks using `(groupId, sequence)`. It returned the same 51 broad-tag matches in about 0.7 ms on the final run. EXPLAIN showed indexed lookups and no global order sort. This is a candidate fallback, not a chosen implementation.

The cost is meaningful: a sparse exact match outside the current window needs further windows. If a request-wide work budget counts these positions, even an exact structured filter could return an empty continuation page. Draft 1 currently describes the 10,000 budget in terms of candidates **after** structured filtering. A fallback that budgets positions first changes that wording and the operator's expectations; it must be reconciled with the reviews and made explicit before user approval. Do not quietly weaken the bound or silently stop after one window.

An adaptive selective-index path plus bounded-window fallback might preserve fast rare lookups and bounded broad work. It still needs a bounded selection/planning rule; a COUNT over the entire filtered population is not a bounded way to choose a plan. No such adaptive implementation was tested here.

## Additional source findings

`report-inspection.ts`'s existing projectedRun helper selects and decodes `errorJson`, and `report-records.ts`'s get method includes error and execution in ReportRecord. A search promised to read no error/result bodies must use a dedicated metadata projection; calling that getter and deleting fields afterwards would violate the claim.

`report-records.ts` updates stored report status when a report run projects, and retry creates a new generation with a higher sequence. The query model's sequence-based latest check depends on that monotonic per-group relationship. Production migration and tests must verify it rather than assuming arbitrary edited rows satisfy it. Search must continue using the existing normalized report status mapping (for example TimedOut is a Failed report record) while displaying reportRunStatus separately.

These findings do not change the approved reporting or recovery APIs. The draft remains unapproved, and production search remains unimplemented.

## Follow-up: old watermarks and body-free metadata

Scratch source: `/tmp/effectory-report-search-probes/edge-cases.ts`, SHA-256 `5892526f7ff69530f54f839c8e8bec722846784564517939b3c57ef48b6e4617`; output is the adjacent `edge-cases.log`.

A simplified table with one group and 200,000 ordered generations checked generation 1 at watermark 1. The generation-index form of `NOT EXISTS(newer generation AND sequence <= watermark)` took about 17.4 ms, because the sequence constraint was residual to its generation range. The `(groupId, sequence)` range form took about 0.17 ms and returned the same row. EXPLAIN confirmed both bounds on the sequence-index lookup. This is not a production latency estimate; it identifies a second way work can grow despite a small requested page. Production retry creates a greater generation and a greater sequence atomically, so sequence-range exclusion is an available internal approach if migration preserves that invariant.

The same script then used the **real createStore**, source submission, report materialization, promotion and failure projection. After replacing only the report run's errorJson with deliberately malformed synthetic data, current report inspection failed as expected. A dedicated SQL projection of report/source/root metadata still returned the correct Failed status, reporter ID and source tags, with no error/result body. The same projection for another principal returned no row. This demonstrates the metadata-only query path is feasible with the actual schema; it is not an implementation of ReportSearch or its full item schema.

## Follow-up: unknown request keys

Scratch source: `/tmp/effectory-report-search-probes/schema.ts`, SHA-256 `36f2e99d035c8483a1775a68dcc70c015bcf0b21638360a8e6322d6bfcbe5459`; output is `schema.log`.

Pinned Effect 4.0.5's default Struct decoder dropped an unknownFilter property. Adding isPropertyNames to that Struct did not reject it: the check saw the already-stripped result. RpcServer constructs its payload decoder with default options (`node_modules/effect/src/rpc/RpcServer.ts:517`). Calling a second strict decoder inside the handler therefore cannot recover an unknown property that RPC already dropped. This framework-only probe does **not** describe Effectory's complete request path.

A stand-in codec consisting of a Record(String, Unknown) with an allowed-property-name check, decoded into the Struct, rejected both an unknown key and a malformed known value through toCodecJson; valid input round-tripped. However its encoded-side JSON Schema described the allowed property names without the Struct field constraints. This was exploratory evidence, not a selected implementation.

**Correction after tracing the daemon:** Effectory already validates each known RPC payload with `onExcessProperty: "error"` before passing the HTTP request to Effect RPC (`packages/platform-bun/src/daemon.ts:76–95,230–253`). Unknown fields therefore fail before the framework can strip them. The earlier inference that the draft needed a new rejection mechanism was wrong. Keep the existing Struct schema and daemon prevalidation; no new codec or generic schema abstraction is needed.

The error distinction should be explicit in the consolidated draft: malformed wire payloads use the existing HTTP 400 `Invalid RPC request` response, rather than a typed `OperationError` with code `InvalidInput`. Well-formed requests with invalid semantic combinations and CLI validation can use `InvalidInput`. This complete-host behavior was traced in source, not exercised by the framework-only probe.

A further scratch stand-in, `schema-strict.ts` (SHA-256 `101af3e70ba3d2ff036a577fb359901a5ef0c5393a6ed8c826da974581f2aa0e`), typechecked and retained field constraints using StructWithRest plus a property-name check. Its bare RpcServer rejected bad payloads with an RPC schema defect. Neither that wrapper nor its error behavior is required by Effectory; the existing HTTP prevalidation is the relevant mechanism.

## Follow-up: bounded traversal with signed cursors

Scratch source: `/tmp/effectory-report-search-probes/paging.ts`, SHA-256 `b890f8a6da2f3689b39a40ff4e3c760353578da5e3cec8c2e96043769ef35702`; output is `paging.log`. This uses a simplified SQLite generation table and the **real createPagination** signing/validation implementation. It is not ReportSearch, and its position-budget strategy remains a proposal.

The model uses a principal/sequence index to materialize at most 17 positions per SQL batch, applies latest-at-watermark and structured predicates to those positions, then performs Unicode lowercase substring matching in JavaScript. The scaled page limits are 53 examined positions, 13 items and 1,300 encoded bytes including the actual signed cursor. A group/sequence index excludes newer generations within the watermark; a unique group/generation index enforces generation identity. Every traversal is compared with an independent in-memory reference selecting the greatest generation before applying any filters.

Across 72 combinations of history mode, status, creation bound and text, all 5,667 pages agreed with that reference. There were 1,879 empty non-final pages and 2,844 non-final pages stopped below their requested item count by the encoded-byte bound. Each traversal received a new retry after its first page. Every continuing cursor advanced strictly, kept the original watermark and expiry, and rejected a changed principal or query. An item that did not fit was returned on a later page rather than skipped. All traversals terminated. Separate calls confirmed a status update changes a subsequent search's matches. The run took about 11.4 seconds in total; this is not a production per-page latency measurement.

This adds evidence for pagination correctness under the bounded-position alternative. It does not prove production migrations, complete metadata schemas, the 16 MiB candidate-byte budget, cooperative cancellation, concurrent status races, or the latency of real joins. The earlier 200,000-row probe covers a larger SQL population but not this complete paging loop. In particular, sparse exact filters can require empty continuation pages because unmatched stored positions consume work; that public consequence must be included in the reviewed contract rather than hidden as an implementation detail.

The follow-up `paging-filtered.ts` (SHA-256 `1d8484e70a193ee974d85e882e2099e582fb62277ed02bf2f57e0474f20dfaa1`, output `paging-filtered.log`) returns only SQL-filtered matches plus one boundary/count row per window. It passed the same 72 combinations over 5,671 pages; a separate no-match traversal completed in 50 pages while transferring zero report metadata rows to JavaScript. This removes the first model's transfer of unrelated metadata without losing empty-page progress. SQL still examines the bounded positions. Draft 2 instead adopts the Effect review's ordered-index intersection, which also makes sparse exact conjunctions efficient; these window-model results are supporting pagination evidence, not proof of that chosen algorithm.
