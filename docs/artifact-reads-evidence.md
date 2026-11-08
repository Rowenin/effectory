# Artifact reads — storage evidence

Executed on 2026-11-06 against the current host store and lake implementation. These probes establish existing behavior for the reader design; they do not implement or approve a new API.

The scratch program used the real `createStore`, `createLake`, `Artifact.make`, Effect and Stream APIs, a temporary SQLite database and synthetic content. The store and lake shared one database connection and a stub exclusive lease. This was not a daemon, concurrent-connection, restart or task-authoring test. The temporary database and blobs were removed in `finally`.

## References in consumer inputs do not protect content

The probe published one JSON version, marked its producer Succeeded, then submitted a consumer with the exact reference as its input and marked that consumer Waiting. A read succeeded before reclamation. An explicit-version reclamation plan selected the version, apply deleted it, and a subsequent read failed.

Observed result:

```json
{
  "consumerStatus": "Waiting",
  "before": { "value": "stored" },
  "candidates": 1,
  "protected": 0,
  "deleted": 1,
  "after": {
    "_tag": "OperationError",
    "code": "NotFound",
    "message": "Artifact version was reclaimed; use lake versions --include-reclaimed to inspect its history"
  }
}
```

This confirms that an input reference alone creates no consumer protection today. It does not test the proposed first-read pin or settle whether admission should protect references. The design must distinguish protection before a first read from protection after a successful acquisition.

## Stream integrity is checked at EOF

The probe published a 131,073-byte binary artifact, then changed its last byte on disk without changing its length. Consuming the complete download delivered three byte frames containing all 131,073 bytes before failing with `ContentUnavailable: Binary artifact digest or length does not match`.

A second download stopped after its metadata frame and first byte frame using `Stream.take(2)`. That consumption succeeded because it never reached the final digest check.

This is evidence about the existing download implementation, not an integrity guarantee for the proposed reader. A streaming reader built on it must disclose that bytes can reach downstream code before corruption is detected, and that early termination does not verify the whole artifact. Whether to add a separately verified whole-content operation remains an API decision.

## Query snapshots and discovery

A second probe used the same real store/lake APIs and assertion checks:

1. Publish alpha v1 and beta v1, then query latest versions with a one-row page. The snapshot was sequence 2 and the first row was alpha v1.
2. Publish beta v2. Continuing the original cursor returned beta v1 at snapshot 2. A fresh query used snapshot 3 and returned alpha v1 and beta v2.
3. With alpha v1 and beta v1 carrying `status: old`, and beta v2 carrying `status: new`, a latest query filtered by `status = old` returned only alpha. An all-versions query returned both older records. Latest is selected before the predicate; it does not mean the newest version that matches the predicate.
4. Reusing the cursor with another page limit or another principal returned `Conflict`.
5. Closing and reopening the database and store/lake objects preserved the original cursor and its beta v1 result. This was a same-process connection reopen, not a daemon-restart proof.
6. Reclaiming an artifact of a different schema under the same principal expired the original cursor with `CursorExpired`. Reading beta v1 by exact version still succeeded. Reclamation invalidation is principal-wide, not limited to rows selected by the query.

All assertions passed. The current one-hour cursor expiry is a source finding from `lake-query.ts` and `pagination.ts`; this probe did not advance time to test it.

## A selective predicate does not currently avoid the scan budget

A third probe added 10,000 valid metadata rows of the same schema with unrelated run IDs directly in the temporary database. This bypassed publication and blob fsyncs to isolate query work. A real lake query with `metadata.runId = <alpha's run>` failed with `QueryBudgetExceeded`, although only alpha's single row matched.

A scratch expression index on `(principal, schemaId, schemaVersion, json_extract(metadataJson, '$.runId'), sequence)` for retained rows, together with an exact-run SQL predicate, returned one candidate. SQLite's plan reported `SEARCH lake_records USING INDEX probe_read_run` using those equalities and the snapshot sequence bound.

This establishes feasibility for narrowing an exact run predicate before the scan budget. It is not a complete query compiler or a performance benchmark. Compound predicates, missing/null behavior, latest-version ranking, ordering, projections and all existing budgets still need equivalence tests. In particular, pushing a predicate down must not change the latest-before-filter behavior above.

## Reports need protection before materialization

A fourth probe used separate host-store and lake connections to one temporary WAL database, the real report store methods, and a stub exclusive lease. It submitted a source task with two root report attachments, published a JSON artifact and marked the source Succeeded. Both report records already existed as WaitingSource, before `reportMaterialize` or `reportPromote` ran.

Current reclamation selected the source's version with `candidateVersions: 1` and `protectedVersions: 0`. Apply deleted it, and a subsequent get returned NotFound. Thus the protection gap begins before report promotion and even before materialization; protecting only admitted report runs would miss it.

The probe separately evaluated this **proposed read-only predicate**, without installing it in reclamation:

```sql
SELECT EXISTS (
  SELECT 1
  FROM host_report_groups g
  JOIN host_reports r ON r.groupId = g.groupId
  WHERE g.sourceRunId = ?
    AND r.status IN ('WaitingSource', 'Queued', 'Running', 'NeedsAttention')
) AS held;
```

Assertions against real report-store transitions found:

- The predicate was true before materialization, after queueing, while a report ran and while it needed attention.
- Cancelling one of the two reports did not clear the hold while the other remained unsettled.
- Closing and reopening both connections preserved the NeedsAttention hold.
- Marking the remaining report run Cancelled cleared the hold.
- `reportRetry` created a queued generation 2 and made the predicate true again. The already-reclaimed artifact still returned NotFound.
- Cancelling that queued generation cleared the hold again.

All assertions passed. This tests a candidate SQL predicate against actual stored report lifecycle state, not an implemented retention amendment. Run status projections were driven through the store directly; it is not an engine-execution, operator-cancellation or process-restart proof. No claim of performance at the maximum report fan-out follows from this small fixture. An implementation must also prove transactional ordering with apply, cancellation batching, excluded outcomes and bounded evaluation on large histories.

## Reproduction record

- Scratch source: `/tmp/effectory-artifact-read-evidence.6CFDlw/probe.ts`.
- Captured output: `/tmp/effectory-artifact-read-evidence.6CFDlw/output.log`.
- Query source/output: `query.ts` and `query-output.log` in that directory.
- Selective-query source/output: `query-budget.ts` and `query-budget-output.log` in that directory. Both query probes exited 0 and printed `All query assertions passed`.
- Report source/output: `reports.ts` and `reports-output.log` in that directory. It exited 0 and printed `All report protection assertions passed`.
- Both expected result records were present without an uncaught error.
- These scratch probes changed no production source. No credentials or external services were used.

The scratch paths are local and temporary. This document preserves the observations; implementation will need committed regression tests for whichever contract the user approves. The existing reports verification remains 352 passing tests, typecheck and lint; that suite was not rerun for this research-only change.

## Existing query optimization — implemented independently

The selective-query gap above has now been addressed in the existing lake API. This adds no ArtifactReader service, fixture API, consumer pins or report retention protection.

`lake-query-candidates.ts` adds retained run/task indexes and a transactionally maintained tag index with an atomic startup backfill. It narrows only positive equality constraints at the root or under conjunctions. Unsupported text cases, Or/Not and other predicates retain the original evaluator path. Latest-version selection precedes filtering, and every candidate still passes the full evaluator. Startup migration needs time and disk proportional to existing records; it is not a bounded-time migration.

Four repository regression tests in `packages/platform-bun/test/lake-query-candidates.test.ts` cover selective reads among 100,000 unrelated records, pushed/non-pushed semantic equivalence, latest/snapshot behavior, and backfill/index maintenance/cursor expiry. The scale corpus uses SQL-generated metadata rather than 100,000 filesystem publications. Broad queries still fail explicitly at the existing budgets.

The full suite passed on 2026-11-06: **356 tests, 0 failures, 2,736 assertions across 91 files**, in 543.63 seconds. The captured log is `/tmp/effectory-query-full-tests.log`. Final typecheck and formatting/lint checks also passed. After removing a test-only generic Error wrapper flagged by the Effect typecheck, the four query regression tests passed again (78 assertions). These are implementation tests for the existing query optimization, not evidence that the proposed reader or retention amendment works.

## Report-protection query scale — implementation constraint

A follow-up scratch probe created the real host-store schema, admitted two source runs, then generated 10,000 source rows with 16 report groups each in SQL: 160,000 queued report rows for one run. This exercises the database access path, not actual graph dispatch, cancellation or implemented retention. Temporary database files were removed afterward.

The simple JOIN predicate above was correct but chose the pending-status index first and visited unrelated groups. Checking a different, fully settled source took roughly 398 ms median before ANALYZE; checking a nonexistent source took roughly 404 ms. ANALYZE did not remove this plan shape. These are local observations under concurrent development load, not latency guarantees.

A source-first correlated EXISTS used host_report_groups_source and then host_reports_pending with status and groupId. It returned the small settled/missing-source cases in fractions of a millisecond. But after all 160,000 reports settled, checking the large source still visited all its groups and took roughly 0.6–1.0 seconds. The original status-first form was quick in that all-settled case. Neither join order alone supplies bounded work across both populations.

Implementation consequence: do not run the original protection predicate independently for every artifact version. Reclamation must avoid repeatedly evaluating the same source inside one consistent transaction, and needs an indexed representation of unsettled source membership (or an equivalently proven bounded lookup). An internal maintained source-keyed projection or denormalized source key is feasible but not implemented or proven by this probe. Its migration, atomic status maintenance, retries and recovery need implementation tests. A transaction-local cache must never survive a transaction and mask a newly armed or retried report.

The final probe passed all held/not-held assertions before and after ANALYZE and after settlement. Source/output: `/tmp/effectory-artifact-read-evidence.6CFDlw/report-scale.ts` and `report-scale-output.log`. The initial probe invocation omitted a required internal attemptTimeout and failed during fixture setup; the corrected fixture was rerun. This evidence narrows an implementation risk without changing the proposed public retention rules.

### Source-keyed projection feasibility

A second scratch script used the same real schema and SQL-generated population to prototype an auxiliary table containing `(report sequence, sourceRunId)` only for unsettled reports. An index on `(sourceRunId, sequence)` supports existence checks. Transactional triggers maintained the prototype for insert and status/group changes; foreign-key deletion removed its row. Backfill and trigger installation ran together in an immediate transaction. This code exists only in the temporary probe, not Effectory.

The 160,001 held rows (160,000 generated invocation reports plus the armed root report) added about 16.4 MiB of database pages and took about two seconds to backfill on this run. Source lookups for pending, settled, nonexistent and large-fully-settled cases used the same covering index and completed in fractions of a millisecond. These measurements are feasibility observations under local load, not service-level guarantees or an exact storage budget for production identities.

Assertions verified that a rolled-back settlement restored every hold, a second connection saw the pre-commit state until settlement committed, a new retry generation recreated protection, each of the four unsettled statuses kept it, each settled status removed it, and deletion removed the derived entry. Updating all reports in one synthetic transaction took about five seconds: production cancellation must retain its existing batching, not copy that bulk update into the runner. No process-kill or interrupted-migration test was performed.

Source/output: `/tmp/effectory-artifact-read-evidence.6CFDlw/report-projection.ts` and `report-projection-output.log`. All assertions passed and temporary database files were removed. This resolves feasibility of a private indexed lookup; it does not approve the public retention amendment or establish correctness of an implemented reader.

## Existing query-index migration under storage exhaustion

A scratch fault-injection probe used the real createStore/createLake schema and initializeQueryIndexes implementation. It removed only the new query indexes/table/triggers to represent a pre-index store, generated 5,001 records, then set SQLite max_page_count to leave two additional pages. Initialization failed with SQLITE_FULL. Assertions confirmed the entire sqlite_master schema matched its pre-migration state, no transaction remained open, all 5,001 records remained, and the original blob still read as its original value.

After removing the artificial page cap, initialization succeeded, backfilled all 5,001 tag rows, and succeeded again idempotently. A selective identity query scanned one row. All assertions passed; temporary database files were removed. This is SQLite page-cap fault injection, not a real full-filesystem or process-kill test. Source/output: `/tmp/effectory-artifact-read-evidence.6CFDlw/query-migration-full.ts` and `query-migration-full-output.log`. No production code changed.

## Exact identity access-path correction (2026-11-07)

The runtime verification follow-up found that `scanned: 1` did not prove a selective SQLite access path. On the existing 100,000-row fixture, an exact artifact-ID query chose `lake_schema`, visiting unrelated schema records before returning its single match. Local measurements were approximately 96–116 ms; a prototype index reduced that query to approximately 0.9 ms. These are probe observations, not latency guarantees or proof that every earlier timing failure had this cause.

Initialization now creates a partial index on `(principal, schemaId, schemaVersion, artifactId, sequence)` for retained records, inside the existing immediate transaction. Existing stores receive it on initialization, including stores that already have the tag table. Query predicates, ranking, cursors and budgets are unchanged. Building this index costs storage and startup time proportional to existing records.

The regression captures the real scan SQL and checks `EXPLAIN QUERY PLAN` for an artifact-ID constraint on its index seek. It failed before the index and passed afterward. This supplements row-count assertions with an access-path assertion, without a timing threshold. The separate scan-budget fixture now inserts its same 10,000 additional records in one SQL statement and asserts the total of 10,001; its timeout and production budgets are unchanged. Both query files passed together: five tests, 87 assertions.

A separate scratch check ran a budget-exceeding query, then checkpointed and truncated the WAL from another connection. It returned `busy: 0`, `log: 0`, `checkpointed: 0`; no leaked query snapshot was reproduced. The existing statement finalization remains unchanged. Scratch scripts and logs are under `/tmp/effectory-query-investigation`; the access-path regression and fixture change are in the repository.

Final verification passed typecheck, formatting/lint and all **519 tests across 133 files, 4,371 assertions**, zero failures (1059.56 seconds). Both previously failing query cases passed in that full run. The initial typecheck caught a test-only SQL binding typed as arbitrary JSON; it was changed to the known string artifact ID and typecheck rerun successfully. A 341-file source/config manifest captured early in the full run after that correction stayed unchanged through completion. Full-suite logs are in `/tmp/effectory-query-investigation/full-tests.log`; final typecheck and check logs are alongside it.
