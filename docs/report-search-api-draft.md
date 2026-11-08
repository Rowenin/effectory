# Report search across runs — draft 2

Status: revised after the consumer and Effect reviews, with their required corrections incorporated. User-approved on 2026-11-06; implemented and verified. See the [implementation evidence](report-search-implementation.md). This preserves the reviewed contract for the feature. No report authoring change is proposed.

## Problem and evidence

Today `report list <run-id>` requires a source run ID, while `run list --origin report --target <reporter> --tag team=platform` already finds admitted report runs across sources through their report provenance and inherited tags. The missing cases are report records without runs (WaitingSource, NotApplicable, unbound Queued and failed observations), plus source workflow/task, scope and attachment filters. RunList also filters target/status in JavaScript under its 10,000-row history budget. ReportSearch is separate because report records are not necessarily runs. It leads to the existing `report get <report-id>`, including for definitions absent from the active application.

Swamp has `report search [query]`, with behavior/workflow, scope, exact report type and conjunctive definition-label filters (`vendor/swamp/src/cli/commands/report_search.ts:240–272`). Its catalog returns only the current non-pending Markdown report per owner/data name, not per-run history (`vendor/swamp/src/infrastructure/persistence/catalog_report_adapter.ts:58–90`). Search uses case-insensitive substring matching and sorts by data creation time (`vendor/swamp/src/libswamp/reports/search.ts:169–214`). Unknown behavior/workflow IDs fail in Swamp; this proposal returns empty results to support historical identities. Swamp reads labels from the currently loaded registry. Local human mode can open an interactive preview; remote mode is a plain list. These are source observations, not executed Swamp tests.

Swamp's `--type` roughly maps to `--reporter`, and method scope to invocation scope. Behavior/workflow scopes roughly map to run scope. Effectory's `--workflow` includes invocation reports inside that workflow; add `--scope run` for root-only reports. Configured behavior instances have no direct counterpart. Effectory's reports have different identity: one group per source run/invocation/attachment, with explicit retry generations and durable waiting/failed records. The approved report contract already names global discovery as a remaining gap. Search must retain those distinctions instead of returning an ambiguous latest artifact per workflow name.

Other parity candidates considered: first-party remote vault adapters, schedule overrides, nested-workflow report boundaries and history retention. They remain real gaps. This proposal selects cross-run report discovery because existing discovery omits unadmitted records and source/attachment filtering. It does not redefine the overall parity goal around this feature.

## Proposed operator API

Examples are proposed syntax, not executable implementation evidence:

```sh
# Discover reports across every source run in this repository.
effectory report search

# Find cost reports from deployments, then read an exact generation.
effectory report search cost --workflow deploy --tag team=platform --status Succeeded
effectory report get <report-id>

# Find an invocation report for a task inside a workflow.
effectory report search --workflow deploy --task upload --scope invocation

# Inspect failed reporters, including earlier retry generations.
effectory report search --reporter summarize --status Failed --history

# Continue a page: repeat the original filters and limit.
effectory report search cost --workflow deploy --tag team=platform --status Succeeded --cursor <cursor>
```

Add `report search [query]` with these optional flags:

| Flag | Meaning |
| --- | --- |
| `--run <id>` | Source root run ID, including groups not yet admitted as report runs. |
| `--workflow <id>` | Root source run has kind workflow and this target ID. |
| `--task <id>` | Report's source target has kind task and this ID; includes direct task runs and task invocations inside workflows. |
| `--reporter <id>` | Exact reporter task ID captured by the attachment. |
| `--attachment <id>` | Exact attachment ID. |
| `--scope run\|invocation` | Existing report source scope. |
| `--status <ReportStatus>` | Existing record status: WaitingSource, Queued, Running, NeedsAttention, Succeeded, Failed, Cancelled or NotApplicable. Repeatable: OR within the status set, AND with other filters. Default: all except NotApplicable. |
| `--tag key=value` | Repeatable AND matches against the source root run's immutable tags. Reuse existing tag parsing, duplicate-key rules and limits. |
| `--created-after`, `--created-before` | Inclusive report-generation creation timestamps, using the existing history timestamp normalization; an inverted interval is InvalidInput. These are not source-run or completion times. |
| `--history` | Include every retry generation instead of the latest generation per group at the first-page watermark. |
| `--limit`, `--cursor` | Existing pagination conventions; default 50, maximum 200. |

All supplied filters are conjunctive. Empty search yields all matching groups; unknown IDs give an empty result, not NotFound. Searching never executes a reporter, builds an application revision, reads a secret, loads an extension or reads artifact content. It uses stored metadata only. Search succeeds with exit 0 even when a returned report failed; `report get`/`report wait` retain their status exit rules.

The optional query is a literal case-insensitive substring, at most 200 UTF-16 units. It matches attachment ID, reporter task ID, source target ID or root target ID. It does not match Markdown, typed data, errors, input, tag values or invocation paths. Normalize with JavaScript toLowerCase; an empty string is equivalent to omission, without trimming other characters. No SQL wildcard, regular-expression or fuzzy-ranking semantics.

The proposed default is all statuses except NotApplicable; unlike the existing report list, this avoids burying actual reports under excluded fan-out records. Explicit `--status NotApplicable` includes those records. Repeated status values are deduplicated; the request accepts 1–8 distinct statuses, normalized as a sorted set for cursor binding. Omission binds the default set. Waiting, queued and failed records remain searchable, unlike Swamp's stored-result search. Use `--status Succeeded` to discover readable results. Default generation selection does not discard older source runs: it selects the latest retry generation independently for each source/attachment group. If generation 2 failed, generation 1's success is not a fallback; use `--history --status Succeeded` to find it.

Human/default and `--json` output follow existing JSON page printing (pretty versus compact). No TUI/picker, automatic paging or new background service. A page with a non-null cursor always has more candidate work to inspect, even when items is empty. For every non-null cursor, the CLI prints a best-effort stderr note in non-JSON mode containing the complete shell-quoted continuation command, including normalized filters and limit. Sentence punctuation is outside the command. A final empty page notes that ID filters are exact and case-sensitive. Scripts must test cursor, not items.length, for completion.

## Proposed RPC and page shape

Add ReportSearch and advertise `reports.search.v1`. CLI checks this capability before sending ReportSearch; an older daemon yields Unavailable/exit 3 with compatible-build restart guidance. Do not change RunReports or its older capability. Existing report commands and authoring definitions keep their behavior.

The request is an Effect Schema Struct, with unknown keys rejected by the daemon's existing strict HTTP payload prevalidation before Effect RPC decoding. Malformed wire payloads receive the existing HTTP 400 response; semantic filter combinations and CLI validation use InvalidInput:

```ts
// Shape sketch only; use the existing schema values in implementation.
interface ReportSearchRequest {
  readonly query?: string;
  readonly runId?: string;
  readonly workflowId?: string;
  readonly taskId?: string;
  readonly reporterId?: string;
  readonly attachmentId?: string;
  readonly scope?: "run" | "invocation";
  readonly statuses?: ReadonlyArray<ReportStatus>;
  readonly tags?: RunTags;
  readonly createdAfter?: string;
  readonly createdBefore?: string;
  readonly history?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}
```

One search item reuses ReportRecord's metadata fields, omitting `error` and `execution`. Keep reportId, groupId, generation, attachmentId, reporter ID/version/provider, reportRunId/status, createdAt, settledAt, notApplicableReason, pathPreview and SourceIdentity exactly as defined today. Add `root: { kind: "task" | "workflow", targetId, acceptedAt, tags }` from the source root run, whose ID is already source.runId. This distinguishes an upload task's invocation report from its enclosing deploy workflow. Root tags are included to explain tag matches; the 4,096-byte tag limit remains unchanged. SourceIdentity already carries the pinned revision. No result/error body or retry-policy body enters a search page. “Newest” means generation creation sequence, not source admission or settlement time: retrying last month's report moves it to the top. Use root.acceptedAt and settledAt to judge source/result recency.

Page: `{ items: ReportSearchItem[], cursor: string | null, snapshot: number, scanLimited: boolean }`. Items at most 200; encoded response at most 2 MiB including the signed cursor. No aggregate count, total match count or content preview. `scanLimited` means the work-unit or candidate-metadata budget, rather than requested item count, ended this page; it is not a claim that any returned record is incomplete. The cursor may be non-null with either value. Returned items always satisfy every filter in the same batch snapshot as their metadata projection. Work-limited pages, including empty pages, apply to every filter combination, with or without text. Byte-limited pages below the requested item count are normal; scanLimited is false when the response-byte limit alone stops the page.

Use existing OperationError codes: InvalidInput for invalid filters; Conflict for a cursor from different filters/principal; CursorExpired after one hour; Unavailable for unsupported capability; existing storage error mapping (including StorageFull where applicable) for storage failures. LimitExceeded for a single oversized item remains a defensive guard: valid bounded metadata cannot reach the 2 MiB item limit. ReportSearch does not use QueryBudgetExceeded for work-budget exhaustion. This deliberately differs from RunList/lake reads so a no-match search over long history can finish through continuation. Never represent an incomplete search as a successful final page. The partial-page convention is an explicit proposed public choice, not already approved by an earlier search API.

## Pagination and mutable state

Order is host report sequence descending (newest generation created first), with no offset paging. First page captures the maximum report sequence. Later pages exclude newer rows. With history false, choose the greatest generation whose sequence is at or below that watermark for each group **before every other filter**, including creation bounds, status and text. Group-invariant filters may be pushed down only where equivalent. A Monday success followed by a Friday failed retry is omitted by `--created-before Wednesday`; it does not return Monday as a fallback. A retry after page 1 does not replace a member halfway through traversal. No fallback to an older generation when the selected generation fails a filter.

Statuses, source outcome and reportRunStatus remain live, as with existing RunReports. A report that changes status after its position was passed is not revisited; rerun from the first page to refresh. This is not a transactionally frozen search of statuses. Immutable root tags and definition identities come from the source run/pinned report plan, never from current definitions.

The signed cursor binds principal, normalized filters, history, limit, initial watermark, exclusive upper sequence bound for the next unexamined position and original expiry. The cursor advances over nonmatches as well as matches. Repeated requests with the same cursor can reflect updated status but preserve ordering and generation membership. Existing single-owner authorization applies, with principal filtering inside every candidate query; do not build a global result and filter ownership in JavaScript.

## Internal implementation and work bounds

Reuse Effect Schema, the existing signed cursor service and HostStore. No SDK service, Layer, Scope, background worker or author callback is added. The page is a request-owned Effect loop over short synchronous database transactions, yielding only between batches.

**Search storage.** Add an immutable search row per report generation, keyed by host_reports.sequence, containing principal, sourceRunId, root kind/target ID, source kind/target ID, scope, attachmentId, reporterId, createdAt and groupId. Principal-led indexes end in sequence: principal alone, sourceRunId, root kind/target, source kind/target, reporterId and attachmentId. Add a WITHOUT ROWID tag index on `(principal, key, value, sequence)`, at most 32 entries per generation. Keys containing dots or slashes are literal bound values, never JSON paths. Insert search/tag rows in the same transaction as arm/retry creates the generation. Do not duplicate mutable status, error/result bodies or lowercase text. A group/sequence index supports latest-at-watermark checks without scanning later retries.

**Bounded traversal.** Each supplied indexed equality filter supplies a descending seek: one statement returns the greatest sequence at or below a bound from its matching index. Intersect those ordered indexes by lowering the bound whenever a seek returns a smaller sequence, and checking all participants until they agree. With no indexed equality filter, use the principal/sequence index alone. Scope and the normalized status set are SQL residual predicates on the agreed row; status reads the existing host_reports column. Latest-at-watermark and creation bounds are also residuals. Equality predicates can participate before latest checking only because the latest residual still rejects every superseded generation; there is no fallback. No COUNT, unbounded sort or planner selectivity estimate chooses the traversal.

Every seek costs one work unit, and every agreed candidate's residual check/projection costs one more. A page has at most **10,000 work units**, with at most **500 per synchronous batch**. A seek is at most one SQL statement; the residual operation uses a bounded primary-key projection with the group/sequence latest check. No unbounded query is hidden inside a unit. SQL statement plans and instrumented counts must establish this. This is a work bound, not a latency guarantee: a batch still blocks the daemon event loop while SQLite executes.

All exact residual predicates and the metadata projection use the same short read transaction. Stored report status must equal the existing normalized status derived from its bound run; test every status-writing path. Use a dedicated metadata projection, **not** records.get followed by dropping fields, because that getter reads error bodies. No unrelated report/error/result metadata is transferred to JavaScript just to find a match.

Literal substring matching runs in JavaScript over attachmentId, reporterId, sourceTargetId and rootTargetId, using toLowerCase/includes. `%`, `_` and backslash are literal. Do not use SQLite lower/LIKE or persist folded text: SQLite folding is ASCII-only. The page also caps fetched candidate metadata at **16 MiB of serialized UTF-8 JSON**, measured explicitly rather than conflating bytes with UTF-16 string length. Each batch is sized to the remaining budget using the schema-derived maximum candidate size; actual bytes are charged even for candidates rejected by text. No response exceeds **2 MiB including its signed cursor**, or 200 items. These independent budgets apply to every query. A budget may end a page before any match, especially for old creation ranges or many superseded generations.

Creation timestamps do not reliably increase with sequence because wall clocks can move backwards. Treat both creation bounds as residual checks; never infer sequence bounds from time. Matching an old interval can therefore require empty continuation pages.

**Ownership.** Each batch completes every statement before returning: use completed get/all calls, or prepare with finally-finalize. No iterator or transaction survives Effect.yieldNow. Bun's inTransaction flag cannot detect an outstanding iterator snapshot; validate release with a checkpoint on a second connection. Interruption between batches discards the page without a write. Batch state contains only items, cursor/traversal state and counters; no additional Scope is needed.

**Cursor boundaries.** The token stores watermark W and an exclusive bound P; the next request searches sequence < P and <= W. After examining or returning candidate S, P may become S. If a seek proves there are no common matches above S but S is not yet fully checked, keep P = S + 1; do not discard that candidate at a work-budget stop. The same rule keeps the first unreturned matching item when the response-byte budget stops the page. Partial index-alignment state may persist between batches within a request; it need not be serialized if restarting from P rechecks the unexamined candidate. Bound the participant count by request limits, and test that even budget exhaustion during alignment makes strict progress across pages. Cursor null means traversal exhausted; an unproven remainder always keeps a cursor. Preserve original expiry across pages.

**Migration.** On every startup under the lease transaction, create missing search structures and catch up all generations beyond the last atomically indexed prefix, with all tag rows included. Search writes preserve that prefix thereafter. This catches reports inserted by a pre-search binary or restored from an older backup. Catch-up is SQL-only, idempotent and atomic; failure must leave no partially usable index. Startup waits for it before reporting ready. The reviewer measured about 18 seconds for a 264,000-generation backfill on one laptop, not a time guarantee. Startup timeout/doctor behavior must tolerate and describe the migration; no new “search not ready” API is proposed. Index/tag duplication adds disk cost proportional to retained generations and tags.

Evidence: [Effect review](report-search-review-effect-round1.md) for ordered-index intersection, real-schema query plans, migration and snapshot ownership; [parent probes](report-search-query-evidence.md) for metadata-only projection, old-watermark indexing and bounded paging. These are feasibility probes, not implementation tests. The parent window-only alternative also bounded work but could require many empty pages for sparse exact conjunctions; ordered-index intersection preserves the same full search scope with better sparse-filter behavior.

## Compatibility and scope boundaries

New clients refuse unsupported daemons before sending the new RPC. New daemon replies and current commands are otherwise unchanged. The synchronous catch-up migration above adds startup time/disk cost proportional to retained report metadata; preserve old records and receipts exactly, and fail startup atomically if migration cannot finish. This does not prune reports or alter any run's execution/status.

This closes cross-run report discovery for Effectory's existing report identities. Swamp's behavior/model instances, variant names, definition labels, interactive preview and full report-type discovery are distinct remaining gaps. Source-run tag filtering is not a claim of parity with definition labels. Swamp's current-report-per-owner dashboard is also a separate gap: this search retains one result per source/invocation/attachment group, so 365 nightly runs can yield 365 groups, rather than one current result per workflow. Existing child-workflow boundary and report-retention gaps remain explicit. First-party vault adapters and schedule overrides also remain outside this slice.

## Proof gates and presentation decisions

Required implementation evidence:

1. Real daemon/CLI: workflow/direct-task roots, invocation/root attachments, retries and historical revisions. Search then report get retrieves the intended generation. No application code executes. Existing report list/get/wait stay unchanged.
2. At least 250,000 real-schema generations: sparse/dense exact filters and tags, interleaved disjoint indexes, many retries, old creation ranges, Unicode/no-match text and another principal. Record EXPLAIN, per-batch/page latency and actual unit counts. No unbounded sort/scan inside a seek or residual. Rare indexed conjunctions among 100,000 unrelated rows finish in one page without transferring unrelated metadata to JS.
3. Full traversal equals an independent reference on immutable fixtures, including empty pages, limit 1/200, exact work/metadata/response boundaries and an unreturned byte-limited item. Exhaust the budget during index alignment and immediately before a candidate check; preserve that candidate and guarantee progress.
4. Latest-before-every-filter, including the Monday/Friday creation example. Insert retries between pages; initial membership stays fixed, fresh search sees the retry. History returns every generation once. Retrying an old source sorts first while root.acceptedAt remains old.
5. Stored/returned status equality after bind, run projection, cancel, recovery, retry and report cancellation; Cancelling normalizes to Running. Every returned status belongs to the requested set. Live changes after a passed position are not revisited.
6. Principal/query/limit/history cursor mismatches, tampering and expiry. Unknown or unowned --run returns empty without revealing existence. Default and explicit status sets normalize consistently. No other principal's IDs/tags appear.
7. Complete metadata projection never reads result/error bodies; malformed synthetic error JSON cannot break search. Root/source identity, scope, tags and acceptedAt match the pinned record, including child, patch and fan-out task invocations.
8. Migration equals join-derived reference; rollback on injected failure; repeat startup is idempotent; pre-search inserts and restored backups catch up. Record startup cost, disk growth and CLI startup behavior on the large fixture.
9. Interrupt a real search between batches, then obtain busy=0 from another connection's WAL checkpoint. No iterator crosses a yield. New generations above the watermark never appear; existing statuses may change between batches as documented.
10. JavaScript Unicode folding (Ä and İ), literal %, underscore and backslash; empty query normalization; 201-unit rejection. CLI escaping, repeatable statuses, continuation commands on every non-final page, final empty note, HTTP malformed-request behavior and semantic error exit codes. Old-daemon capability refusal sends no ReportSearch.
11. Full `bun run typecheck && bun run check && bun test` after implementation.

## Recommended package for user approval

- Add report search / ReportSearch with metadata substring, exact source/reporter/attachment filters, source tags and repeatable statuses. Default excludes NotApplicable; it remains explicitly searchable.
- Return latest generation per source/invocation/attachment group by default, with all filters applied afterwards. History includes older generations. Status remains live while watermark membership is fixed.
- Return bounded continuation pages, including empty pages, for any filter combination. Follow cursor until null; this deliberately differs from QueryBudgetExceeded in existing history APIs.
- Include historical root tags and acceptedAt, but no report/error bodies or total counts. Preserve per-run history rather than adding Swamp's current-per-owner dashboard in this slice.
- Perform atomic catch-up before daemon readiness. Large retained histories can make startup slower (reviewer measurement: about 18 seconds for 264,000 generations).

The alternative to continuation is the existing budget error, which prevents some long-history searches from completing. The alternative to blocking startup is background backfill with a new readiness state; neither is recommended here. Both reviewers' required corrections are incorporated; reviewer feedback does not authorize implementation. The user approved this package on 2026-11-06.
