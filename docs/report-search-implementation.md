# Report search implementation evidence

The user approved [draft 2](report-search-api-draft.md) on 2026-11-06. Implementation and repository verification are complete. [Operator guide](report-search.md).

## Implementation

- Runtime schemas add ReportSearchRequest, ReportSearchItem and ReportSearchPage. ReportSearch is capability-gated by reports.search.v1. Authoring APIs and existing report commands are unchanged.
- Immutable per-generation search rows and principal-led ordered indexes support exact filters. A separate tag index preserves literal keys and conjunctions. Arm/retry updates are transactional; startup catches up missing generations atomically.
- New insert detection uses INSERT RETURNING. The real daemon exposed that Bun's affected-row count includes retention-trigger writes, making a changes-equals-one check incorrect. Storage fixtures now enable those same triggers.
- Ordered-index intersection charges every seek and candidate check against 10,000 units per page. Batches have at most 500 units and complete their SQLite statements/transaction before Effect.yieldNow. No service, Layer or Scope is added.
- Metadata projection shares the predicate snapshot and reads no result/error bodies. JavaScript performs literal Unicode case folding. Response/candidate byte accounting includes serialized data and reserves cursor/envelope space.
- Cursors retain the original watermark/expiry and the first unexamined candidate. Status remains live; latest-generation membership is selected before filters.
- The CLI supports all reviewed filters, repeated statuses, complete shell-quoted continuation commands and quiet JSON output. Daemon start allows two minutes for the blocking migration and explains that a timeout may leave it running.

## Tests and observed evidence

| Evidence | Covers |
| --- | --- |
| `packages/platform-bun/test/report-search.test.ts` | Unadmitted records, ownership, dotted/slashed conjunctive tags, Unicode text, default/multiple statuses, corrupted error-body independence, retry watermark, latest-before-time/status, cancellation projection, invalid/cross-query cursors, root/source split, byte-limited pages, metadata budget, atomic rollback and old-writer catch-up |
| `packages/platform-bun/test/report-search-paging.test.ts` | 14,004 interleaved generations, disjoint indexed predicates, superseded status rows, creation/text residuals, independent traversal reference, empty-page progress, limit 1/200 and expiry |
| `packages/platform-bun/test/report-search-scale.test.ts` | 250,001 generations / 500,002 tag entries, backfill/reopen, rare/dense conjunctions, 500/10,000-unit instrumentation, old watermark after many retries, real Effect interruption and a second-connection WAL checkpoint, seek query plans |
| `packages/platform-bun/test/report-search-cli.test.ts` | Real daemon and task/workflow reports, search-to-get, multiple statuses, executing the printed continuation, quiet JSON, validation exits and restart |
| `packages/cli/test/report-search.test.ts` | Typed capability/validation failure, shell/control-character quoting with exact Bash/zsh argument preservation |
| `packages/cli/test/watch-compat.test.ts` | A real older-protocol HTTP stub receives no ReportSearch request; CLI exits 3 after capability preflight |

The initial large-history run measured 12,534 ms for backfill and 23.7 ms for the sparse conjunction; the maximum observed batch used 500 units. These timings include the actual implementation on this machine and are not latency promises. Earlier stand-in probes and their limitations remain in [query evidence](report-search-query-evidence.md) and the two design reviews.

A separate real-daemon startup proof appended 250,000 generations through an old-writer path, then ran the actual daemon-start command. Ready was reported after 6,418 ms, with all 250,001 generation rows and 500,002 tag entries indexed; search returned generation 250,001. The temporary repository was removed. Harness: `/tmp/effectory-report-search-probes/startup.ts` (SHA-256 `3248512fd62595515bec79b5e0ec203a2c9cafdbd62f9672001967ca73b7935e`); log: `/tmp/effectory-report-search-probes/startup.log`. This measures current implementation on this machine, not a startup guarantee.

The first full suite hit the existing console oversized-tail integration test's five-second timeout. Its four subprocess invocations passed independently in 4.4 seconds. The test timeout is now 30 seconds, with identical assertions; it passed in the final full suite.

Final verification on 2026-11-06: `bun run typecheck`, `bun run check` and `bun test` all passed. The suite passed **409 tests across 110 files, 3461 assertions, zero failures** in 627.46 seconds. The final scale test measured 4,025 ms for migration, 2.67 ms for the sparse conjunction and 36.47 ms for its slowest batch; every batch stayed within 500 work units. These are observations, not latency guarantees.

All 304 source, test, fixture and build-input hashes matched the manifest captured before the final run, with no new files in those directories. Manifest: `/tmp/effectory-report-search-final-manifest.json`. Logs: `/tmp/effectory-report-search-final-typecheck.log`, `/tmp/effectory-report-search-final-check.log`, `/tmp/effectory-report-search-full-tests-rerun.log`. This run was on macOS; it does not claim new Linux evidence. No production deployment, publication or commit is part of this work.
