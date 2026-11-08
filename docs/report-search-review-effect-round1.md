# Report search: Effect/SQLite/pagination/ownership review, round 1

Status: review of the unapproved [report-search-api-draft.md](report-search-api-draft.md) (draft 1). **This is reviewer feedback only. It is not user approval and does not authorize implementation.** No draft, production or test file was edited. No commit was made. The concurrent consumer review and consumer resolution were not read. The independent [query evidence](report-search-query-evidence.md) note was read; it agrees with the findings below where they overlap.

Labels:

- **[tested]**: executed in a scratch probe outside the checkout with Bun 1.4.3 (SQLite 3.51.0) and the checkout's pinned `effect@4.0.5`, which is symlinked from `node_modules/.bun/effect@4.0.5`.
- **[source-read]**: read in this checkout. File and line references are given.
- **[inferred]**: a design conclusion that has not been executed.

## Verdict

**Not ready for user presentation. Changes are required, but the feature is feasible without reducing its scope.** The public shape is sound: a new RPC, stored metadata only, a watermark, latest-before-filter selection, a signed cursor, and no new SDK service or Layer. The work-bound section is the problem. Its premise is that structured filters are pushed into SQLite and the budget then counts only substring candidates. The probes show that this premise does not hold, either for today's schema or for a naive set of new indexes. With the conjunctive filters the draft allows, an outer `LIMIT` still walks or sorts the whole matching history.

A different shape does work. It intersects principal-led, sequence-ordered indexes and counts index seeks and residual checks against the budget. It found rare matches in about 0.05–3 ms. It bounded dense conjunctions to about 200 seeks (≈6 ms) per 51-item page, over 264,000 real-schema report rows. The draft needs:

- corrections C1–C10;
- three public decisions (D1–D3), which the user must make;
- proof gates G1–G12.

## Probe evidence

Probe directory: `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/43bd2cf9-32a2-49d8-8e13-ded5a97544ae/scratchpad/probe/`. It has no network access, no credentials and no repository tests.

| Script | Purpose |
| --- | --- |
| `sqlite-probe.ts` | DDL copied verbatim (search-relevant columns) from `host-store.ts:203–255`, `report-sources.ts:58–81` and `report-records.ts:95–117`. Seeds `RUNS` root runs: 90% principal `me` and 10% `other`; workflow and task roots; two tags, one key containing `.` and `/`; one run-scope source and two invocation sources per run; three plan entries; 10% failed-then-retried groups. A single needle run sits near the oldest end, which is the worst case for a descending scan. Outputs are in `sqlite-probe.out` (88k rows) and `big.out` / `sqlite-probe-60k.out` (264k rows). |
| `batch-probe.ts` | Tag-led driving index; statement and snapshot behaviour across yields; Effect 4.0.5 request-owned batching and interruption (`batch-probe.out`). |
| `iter-probe.ts` | Bun `iterate()` / `return()` / `finalize()` / `all()` / `get()` and WAL checkpoint blocking. |
| `leapfrog-probe.ts` | Zig-zag intersection of sequence-ordered indexes under a seek budget. |
| `backfill-probe.ts` | SQL-only migration cost, atomic rollback, idempotent catch-up. |

Timings come from one Apple-silicon laptop on a warm file database. They are evidence about plan shape and relative cost. They are not latency guarantees.

### Today's schema: LIMIT does not bound work [tested]

These measurements use 264,000 report generations, with the query `ORDER BY r.sequence DESC LIMIT 51` and the current joins (the `selection` in `report-records.ts:57–64`).

| Query | Plan | Time | Rows |
| --- | --- | --- | --- |
| A. Rare reporter (via `json_extract(planJson…)`) | `SEARCH r USING INTEGER PRIMARY KEY (rowid<?)`, then per-row joins | 2,755 ms | 1 |
| A2. Reporter with no match | same | 1,523 ms | 0 |
| B. Rare tag only, through the `host_run_tags` IN-list | tag index → runs → groups → **TEMP B-TREE FOR ORDER BY** | 0.4 ms | 4 |
| B2. Common tag `team=platform` AND rare reporter | same as B, but sorting every report of the common tag | 935 ms | 0 |
| C. `status = Failed` latest-at-watermark (every Failed row superseded) | PK scan of the full history | 66 ms | 0 |

At 88,000 rows, A took 355 ms. That roughly scales linearly with history.

### Naive new indexes still fail for conjunctions [tested]

These use the proposed denormalized `host_report_search` table, with an index per exact filter.

- **G2.** Tag-driven join from `host_run_tags` to per-run search rows, using the common tag. Cost: 548 ms per page, a full sort of every matching generation on every page.
- **H.** Driving `host_reports(status, sequence)` with the latest-at-watermark residual. Cost: 68 ms. It walks every Failed row in history, because the latest check rejects them all.
- **I.** `createdAt` range plus `ORDER BY sequence`. Cost: 432 ms. The planner walked `(principal, sequence)` and filtered `createdAt` row by row. No single index serves both the range and the order.

### What does bound the work [tested]

- **D, E, F (single driving index plus a 10,000-row window).** The rare reporter is found in 0.2 ms. A no-match substring takes 14.6 ms per 10,000-row window. A residual rare tag takes 13 ms per window, but every window before the needle comes back empty.
- **T1, T2 (tag-led index).** These use `host_report_search_tags(principal, key, value, sequence)`, `WITHOUT ROWID`. The rare tag plus a second tag took 2.6 ms and returned 4 rows. The common tag with a 500-row window took 18.7 ms and returned 206 rows. Backfill was 528,000 rows in 2.6 s, in pure SQL.
- **Leapfrog (zig-zag) intersection** over principal-led `(…, sequence)` indexes. Each seek is `SELECT MAX(sequence) … AND sequence <= ?`:

| Conjunction | Time | Items | Seeks |
| --- | --- | --- | --- |
| Common reporter AND rare tag | 2.6 ms | 3 (exhausted, cursor null) | 9 |
| Rare reporter AND common tag (disjoint) | 0.05 ms | 0 (exhausted) | 3 |
| Common reporter AND common tag AND root workflow (dense) | 5.8 ms | 51 (cursor) | 197 |
| Partially anti-correlated pair | 6.3 ms | 51 (cursor) | 214 |

Every seek strictly lowers the position or confirms agreement. Progress is therefore guaranteed, and the seek count is a hard bound per page. The worst case is two dense indexes with perfectly interleaved, disjoint sequences. There, seeks approach the number of rows examined and the budget stops the page. That outcome is bounded, not unbounded.

### Snapshot and statement behaviour in Bun 1.4.3 [tested]

From `iter-probe.ts` and `batch-probe.ts`:

- While an `iterate()` cursor is mid-statement, `Database.inTransaction` is **false**, but `PRAGMA wal_checkpoint(TRUNCATE)` from another connection reports `busy: 1`. The read snapshot is held.
- `iterator.return()` does **not** release it (still `busy: 1`). Only `statement.finalize()` does. The same applies to an abandoned cached `db.query(...).iterate()`.
- A completed `.all()`, and `.get()` on a multi-row result, leave no snapshot (`busy: 0`), even without finalize.
- The existing `run-history.ts:69–123` pattern is correct: `prepare` + `iterate` + `finally finalize` + no yield. A search that kept an iterator across `Effect.yieldNow` would pin the WAL and block checkpoints. `inTransaction` cannot detect that.
- Effect 4.0.5 loop: each batch is `Effect.sync(() => prepare/all/finalize)` followed by `Effect.yieldNow`. A 10,000-row budget ran in 20 batches of 500 and returned `{items: [], cursor: 252716}`. Interrupting a forked search after 5 ms stopped it between batches (11 batches done). Afterwards `inTransaction` was false and the checkpoint returned `busy: 0`.

### Case folding [tested]

- SQLite `lower('ÄBÇ-Deploy')` gives `ÄbÇ-deploy`. `'ÄBÇ' LIKE 'äbç'` gives 0. `'a_b' LIKE 'a%'` gives 1.
- JavaScript `'ÄBÇ-Deploy'.toLowerCase()` gives `äbç-deploy`, and `'İ'.toLowerCase().length` is 2.
- IDs are any non-empty string of up to 200 characters (`report-plan.ts:6`).

So SQL `lower`, `LIKE` or `instr` over SQL-folded text cannot implement the draft's "JavaScript toLowerCase literal substring".

### Migration [tested]

- SQL-only backfill of 264,000 per-generation search rows with six indexes took 17.9 s. The join and `json_extract` took 1.4–2.5 s, and each index build about 1.3 s.
- A failed statement inside the migration transaction left no partial table.
- An idempotent catch-up of `WHERE sequence > MAX(search.sequence)` took 0.7 ms when nothing was missing.

## Source audit

1. **Tables and joins [source-read].**
   - A report generation is `host_reports` (`sequence` AUTOINCREMENT, `UNIQUE(groupId, generation)`), joined to:
     - `host_report_groups` (`sourceRunId`, `attachmentIndex`, `latestGeneration`);
     - `host_report_sources` (`sourceJson`, which carries the source target kind/ID and scope);
     - `host_report_plans` (`planJson`; the attachment and reporter come from `json_extract(planJson, '$[attachmentIndex]')`);
     - `host_runs root` (`principal`, `kind`, `targetId`, `tagsJson`).

     See `report-records.ts:57–64` and `95–117`, and `report-sources.ts:58–81`.

   - None of the draft's exact filters is an indexed column today. The only report indexes are `host_reports_pending(status, groupId, queuedAt, sequence)`, `host_report_groups_source(sourceRunId, sourceId)` and the source/pending indexes.
2. **No deletions [source-read].** No `DELETE FROM host_report*`, `host_runs` or `host_run_tags` exists in `packages/platform-bun/src`. Sequence order is append-only, so a watermark plus an exclusive position is a sound traversal key.
3. **Stored versus projected status [source-read].**
   - `records.get` returns `reportStatus(run.status)` when `reportRunId` is set, and the stored `host_reports.status` otherwise (`report-records.ts:137–176`).
   - Every write of `host_runs.status` calls `records.project` in the same transaction: `host-store.ts:388–392` (recovery), `536/568` (cancel → Cancelling) and `1264–1277` (projection).
   - `bind` sets `reportRunId` only while the stored status is `Queued` and the new run is `Queued` (`report-records.ts:246–259`, `host-store.ts:642`).
   - So the stored column equals the projected status for every reachable write. That makes a SQL status filter sound, **provided this invariant is enforced as a gate** (G6). The reading must also happen in the same snapshot as projection (C5).
4. **Latest-before-status [source-read + tested].**
   - The current RunReports query already implements latest-at-watermark with `NOT EXISTS (newer.generation > r.generation AND newer.sequence <= W)` (`report-inspection.ts:140–147`). It is answered from the covering `UNIQUE(groupId, generation)` index (plans A–J).
   - "Latest at W, then status = S" is equivalent to "status = S AND latest at W" on the same row. Status can therefore be either a driving index or a residual without changing semantics. It is never a fallback to an older generation.
5. **Principals [source-read].**
   - Every RPC handler passes the literal principal `"owner"` (`control-plane.ts`, 42 occurrences). `host_run_tags` stores the principal (`host-store.ts:214–218`). Report rows inherit ownership only through `host_runs root`.
   - Multi-principal behaviour is therefore unexercised today. Leading every new index with principal costs nothing and keeps the draft's "principal inside every candidate query" true.
6. **Cursor [source-read].**
   - `pagination.ts` signs `{expires, fingerprint(kind, principal, query), position, snapshot}`, with a cap of 4 KiB. It returns `Conflict` on fingerprint mismatch and `CursorExpired` after expiry.
   - RunReports keeps the original expiry (`report-inspection.ts:175–181`).
   - The draft's binding list maps onto this directly. The 200-unit query lives in the fingerprint, not the token, so the size is fine.
7. **Precedent conflict [source-read].** Run history enforces 10,000 scanned rows / 16 MiB by **failing** with `QueryBudgetExceeded` ("narrow the time range") (`run-history.ts:107–114`; the code exists in `runtime/src/protocol.ts:128`). The draft's partial-page convention is new and differs from it. That is decision D1.
8. **Migration style [source-read].**
   - The store migrates with `CREATE … IF NOT EXISTS` plus guarded `ALTER`s inside a lease-asserted transaction (`host-store.ts:258–274`).
   - There is no schema version.
   - The only downgrade guard rejects pre-`admissionNamespace` databases (`host-store.ts:178–198`).
   - An older binary can therefore open an upgraded database and keep inserting reports without search rows. A backup restore can do the same (C7).
9. **Swamp [source-read].** The draft's citations are accurate (`vendor/swamp/src/cli/commands/report_search.ts:240–285`, `vendor/swamp/src/libswamp/reports/search.ts:169–214`). Swamp loads every candidate into memory and sorts it, with no paging. It sets no precedent for bounds.
10. **Effect ownership [source-read + tested].**
    - `HostStore` operations are synchronous bodies wrapped by `perform` (`Effect.try`, `host-store.ts:290–305`). RunReports runs the whole page in one `database.transaction` (`host-store.ts:1454–1460`).
    - A request-owned loop of `perform(batch)` plus `Effect.yieldNow` is ordinary Effect. It needs no Scope, Layer, finalizer or SDK service. Interruption lands between batches, because a synchronous body cannot be interrupted.
    - I agree with the draft that no new SDK service is needed.

## Required corrections

**C1. Replace "push structured filters into SQLite, then budget substring candidates" with an explicit bounded traversal.**

The draft's sentence "inspect at most 10,000 structured-filter candidates" is unsound, because with conjunctions the work happens _before_ candidates exist (A, B2, C, G2, H, I). Specify this instead:

- **Equality filters** (`runId`, `workflowId`, `taskId`, `reporterId`, `attachmentId`, `scope`, each tag, and optionally `status`) each map to one principal-led index whose last column is `sequence`.
- **Traversal** is a zig-zag intersection of those indexes, descending from `min(position, W)`. With no equality filter, it uses `(principal, sequence)`.
- **Residual predicates** are evaluated per agreed candidate: latest-at-W, `createdAt` interval, text query, and status if it is not indexed.
- **Per-page budget** is a single number of _work units_: one unit per index seek or per residual candidate check, for example 10,000. It is plus the existing 200-item, 2 MiB and 16 MiB-of-candidate-metadata bounds.

This removes any dependence on planner selectivity or `COUNT`, and it bounds every filter combination.

The smallest acceptable alternative is a single driving index plus residuals, as in probes D/E/F. That alternative makes rare-conjunction searches return long runs of empty pages (F). The draft must then say so.

**C2. Name the search storage concretely.** Use an immutable per-generation table keyed by `host_reports.sequence`:

- columns: `principal`, `sourceRunId`, `rootKind`, `rootTargetId`, `sourceTargetKind`, `sourceTargetId`, `scope`, `attachmentId`, `reporterId`, `createdAt`, `groupId`;
- indexes: `(principal, sequence)`, `(principal, sourceRunId, sequence)`, `(principal, rootKind, rootTargetId, sequence)`, `(principal, sourceTargetKind, sourceTargetId, sequence)`, `(principal, reporterId, sequence)`, `(principal, attachmentId, sequence)`;
- a `WITHOUT ROWID` tag table `(principal, key, value, sequence)`. Its size is at most 32 rows per generation (`run-tags.ts:10–15`).

Populate both in the same transaction as the `host_reports` insert, in `arm` and `retry` (`report-records.ts:214–243`, `505–525`).

Do **not** copy status, errors, results or folded text. A per-group table is insufficient, because traversal order is per generation.

The scope filter is low-cardinality. Make it a residual unless it is combined into the source index, as `(principal, scope, sourceTargetKind, sourceTargetId, sequence)`.

**C3. Status.** Pick one of two approaches and state it:

- (a) Status is a residual. This is simple, but `--status Failed` over a long history spends its budget on superseded rows (H). Or:
- (b) Add `host_reports(status, sequence)` as a leapfrog participant. Principal is then enforced by intersecting with a principal-led index; every page has at least `(principal, sequence)`.

Either way, the filter and the returned record must read the same snapshot (C5). Never emit an item whose returned `status` differs from the requested one.

**C4. Case-insensitive text matching happens in JavaScript over the four stored IDs, never in SQL.**

- SQLite `lower`/`LIKE` is ASCII-only and has wildcards (tested).
- Do not store a separately folded column either. A fold computed by a different binary or SQL function would drift, and keeping only raw IDs keeps the migration SQL-only.
- Per candidate, compute `[attachmentId, reporterId, sourceTargetId, rootTargetId].some(id => id.toLowerCase().includes(q))`, where `q = query.toLowerCase()`.
- Count each candidate as one work unit, plus its UTF-16 length against the 16 MiB metadata bound. Four IDs × 200 units fits that bound easily, so state the bound in UTF-16 units, not bytes.

**C5. Define request-owned batching exactly.**

- A page is an `Effect.gen` loop.
- Each batch is one `perform(() => database.transaction(() => …)())`. It contains at most N work units (for example 500), with completed statements only: cached `query().get()`/`.all()`, or `prepare` + `finally finalize`. **No `iterate()` survives a batch.**
- Item projection (`records.get`) runs inside the same batch transaction as the predicate that admitted it.
- `Effect.yieldNow` runs only between batches. Batch outputs (items, last examined sequence, unit counters) are plain values in the loop state.
- Interruption between batches simply discards the page. Nothing is written, so nothing needs rollback, and no Scope is needed.
- Do not assert progress with `database.inTransaction`. It reads false while a snapshot is pinned (tested). Gate G9 uses a WAL checkpoint probe instead.

**C6. Cursor position and limits.**

- The position is the exclusive upper bound for the next traversal, `sequence < position`. On a work-budget stop, it is the last examined sequence. On a 2 MiB stop, it is the sequence of the first unreturned matching item plus one, so that item is re-examined.
- If that unreturned item is the first match on the page, return `LimitExceeded`, which matches RunReports (`report-inspection.ts:169–171`).
- The cursor is null only when the traversal returns no further sequence at or below the position.
- State that `snapshot` is the watermark W, and that history mode skips only the latest residual.
- Item size can be checked. Root tags are at most 4,096 bytes, the path preview is at most 2,048 characters, and IDs are at most 200 characters. So one item is well under 2 MiB, and `LimitExceeded` for a single item is unreachable. Say so, rather than listing it as a live code.

**C7. Migration must be catch-up, not one-shot.**

- On every startup, inside the lease transaction, insert search and tag rows for every `host_reports.sequence > MAX(search.sequence)`. The rows are derived purely in SQL from the joins above.
- This also repairs databases written by an older binary or restored from an older backup. Neither is guarded today (source audit 8).
- The catch-up must be atomic (tested rollback) and idempotent (0.7 ms when nothing is missing).
- Replace "may need startup disk/time proportional" with a measured figure. The probe measured 17.9 s for 264,000 generations, so the daemon start/readiness timeouts and the `doctor` output must tolerate it, or the migration must say it blocks startup. Each index costs about 1.3 s per 264,000 rows. If startup time is a concern, drop the attachment index, since an attachment ID is usually combined with a reporter or workflow.

**C8. `--created-after/--created-before` cannot narrow the traversal.**

- `createdAt` is `new Date().toISOString()` at insert time. It is not guaranteed to be monotonic with `sequence`, because wall clocks step.
- No single index serves both the range and the sequence order (I).
- Make the interval a residual that counts against the work budget, and document that old intervals can produce empty continuation pages. Do not derive sequence bounds by assuming monotonicity.

**C9. The work bound must be real bounds, not prose.** Replace "SQL batches should be small" and "subject to proof gates" with these numbers:

- units per page;
- units per batch;
- a maximum of one statement per seek;
- the response bound.

Also say that one batch is a synchronous SQLite section on the daemon's event loop. Measured cost was about 0.7 ms per 500 units for a no-match window (E), and 197–214 seeks in about 6 ms for dense conjunctions. The implementation must record the same figures (G4).

**C10. Error-code and convention alignment.**

- The draft lists `Unavailable` for storage failure. Existing `perform` maps failures through `storageError`, which can yield `StorageFull` among others. Say "existing storage error mapping".
- Explicitly state that `QueryBudgetExceeded` is **not** used, and why (D1).

## Public decisions for the user (separate from reviewer approval)

**D1. Partial pages.** Budget-limited, possibly empty, continuation pages with `scanLimited` apply to **every** filter combination, not only text queries (C1/C8). This differs from run history's `QueryBudgetExceeded` failure. The alternative is to fail like history. That is consistent, but a no-match or old-range search could then never complete. I recommend partial pages, applied uniformly.

**D2. Status semantics.**

- Status is live and not frozen: a report whose status changes after it was passed is not revisited.
- Latest generation per group at the watermark comes before the status filter, with no fallback.

Both are already in the draft and are consistent with RunReports. They need explicit user approval because `--status Succeeded` can hide an older success.

**D3. Upgrade cost.** Startup blocks for a migration proportional to the stored report generations (measured: about 18 s per 264,000 on a laptop). The alternative is an online background backfill. That would need a "search not ready" state, which is more public surface, so I do not recommend it.

These choices are already clearly labelled in the draft and need no new decision: no TUI, no counts, source tags rather than definition labels, and the Swamp parity gaps.

## Proof gates (additions and sharpenings to the draft's 1–7)

- **G1.** Real-schema fixture with at least 250,000 generations: many retries per group, many groups per root, 10% other principal, sparse and dense tags, keys with `.` and `/`. For each filter class (single exact, rare∧common, common∧common, anti-correlated pair, status=Failed with all superseded, old `createdAt` range, no-match text), record EXPLAIN QUERY PLAN for every statement used.
  - No statement may show `USE TEMP B-TREE FOR ORDER BY` over an unbounded set, or a scan not bounded by `LIMIT`/`MAX`.
- **G2.** A counter instrumented in the implementation proves work units per page ≤ the budget for every G1 case. The rare cases (a single match among more than 100,000 unrelated generations, with an equality filter) complete in one page.
- **G3.** On immutable fixtures, the full traversal through every page (including empty and `scanLimited` ones) equals a brute-force reference list, with no duplicates or omissions. Cover limit=1, limit=200, a budget exactly hit, and a 2 MiB stop exactly hit.
- **G4.** Record the per-batch and per-page wall time for G1 alongside the unit counts. Report them as measurements, not as guarantees.
- **G5.** Latest-at-watermark: a retry inserted after page 1 does not change membership. A fresh search sees it. `--status Succeeded` never falls back. `--history` returns every generation once.
- **G6.** Invariant test, after run, cancel, recovery, retry and report-cancel paths: `host_reports.status = reportStatus(host_runs.status)` for every bound row. Every returned item's status equals the requested `--status`.
- **G7.** A cursor with a different principal, query, limit or history setting gives `Conflict`. Expiry gives `CursorExpired`. A tampered cursor gives `InvalidInput`. No root tags or IDs from another principal ever appear, tested with a real second principal inserted directly into the store.
- **G8.** Migration:
  - backfill equals the join-derived reference;
  - an injected failure leaves the pre-migration schema untouched;
  - a database written by the pre-search binary after upgrade (downgrade/re-upgrade, and restore of an older backup) is caught up;
  - record the startup time for G1's size.
- **G9.** Effect ownership: interrupt a search fiber mid-page, and a concurrent connection's `wal_checkpoint(TRUNCATE)` then returns `busy = 0`. No `iterate()` crosses a yield. A mid-page write by another fiber does not appear in the page, because of the watermark.
- **G10.** Text queries: non-ASCII IDs follow `toLowerCase` semantics (`Ä`, `İ`). `%`, `_` and `\` are literal. The empty string is treated as omitted. A query of 201 units gives `InvalidInput`.
- **G11.** `taskId` covers direct task roots and invocations. `workflowId` matches only root kind workflow. Root and source targets are distinguished in the output, including for patches and fan-out invocations.
- **G12.** The draft's gates 1, 6 and 7 (real daemon/CLI, no content bodies, old-daemon preflight, unchanged list/get/wait, full `bun run typecheck && bun run check && bun test`) remain as written.

## Summary for the parent

- **Approval and scope.** Reviewer approval is withheld until C1–C10 are in the draft. The draft can then go to the user with D1–D3 marked as user decisions.
- **Feasibility.** The feature is feasible at full scope. The fix is to bound traversal, not to narrow the search:
  - zig-zag intersection over principal-led `(…, sequence)` indexes, plus a tag index;
  - residual checks under a single work-unit budget;
  - JavaScript-side Unicode folding;
  - synchronous per-batch transactions with `yieldNow` only between them;
  - catch-up migration on every startup.
- **Effect.** No SDK service, Layer or Scope is needed.
