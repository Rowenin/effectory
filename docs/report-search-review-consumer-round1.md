# Report search: consumer/operator review, round 1

Reviews `docs/report-search-api-draft.md` (draft 1) from the consumer/operator side. Reviewer approval is not user approval, and the user has not approved this API. Nothing here authorizes implementation.

Evidence labels: **[read]** means I read the current source and did not execute it. **[vendored]** means vendored Swamp source, not an executed Swamp test. **[inference]** means reasoning from read code. No probes were run: every finding below comes from reading the code, and none needed a store to confirm it.

## Verdict

**Revise before presenting to the user.** The draft is not a redesign candidate. The identity model is right: a group per source run, invocation and attachment, explicit generations, and records that are not yet admitted. The root/source split, the latest-at-watermark rule and the content-free pages are also right. Four contract gaps or contradictions need edits before the user can decide on accurate terms (B1–B4). Four presentation choices belong to the user and need clearer framing (D1–D4). The rest are small internal corrections.

## Blockers (must fix before presentation)

### B1. The problem statement leaves out an existing cross-run path

**[read]** Report runs inherit the source root's tags (`host-store.ts:1484-1498`, `resolvedTags: root.tags`). They also carry `report` provenance with `reportId`, `sourceRunId`, `attachmentId`, `generation` and `sourceInvocationId` (`protocol.ts:31`, `report-record.ts` Provenance). `RunSummary` exposes both (`history-protocol.ts:31-42`). So today this works:

```sh
effectory run list --origin report --target summarize --tag team=platform --status Succeeded
effectory report get <item.report.reportId>
```

It finds admitted report generations across runs without knowing the source run ID. The draft's sentence "an operator must first know a source run ID" is therefore overstated.

The real gap is still large, and it justifies a dedicated RPC:

- Records that never become runs are invisible to that path: WaitingSource, NotApplicable, Queued-before-bind, and Failed observations with no report run.
- There is no filter by source workflow or task, scope, or attachment.
- `run list` filters target and status in JavaScript after the SQL scan. Past 10,000 scanned report runs it throws `QueryBudgetExceeded` (`run-history.ts:56-113`).

**Edit:** In "Problem and evidence", replace the first sentence with: "Today `report list <run-id>` requires a source run ID. `run list --origin report --target <reporter> [--tag]` can locate _admitted_ report runs across sources through their `report` provenance, because report runs inherit root tags. It cannot locate WaitingSource, NotApplicable or unbound records. It cannot filter by source target, scope or attachment. Its target and status filters run in JavaScript under the 10,000-row history budget." Then state why ReportSearch is a separate RPC rather than more RunList filters: report records are not runs.

### B2. It is not specified which filters apply after latest-generation selection

The draft says that status and text filters apply after latest selection. It does not say this for `--created-after/--created-before`, which also differ between generations.

**Counterexample:** a group has gen 1 created Monday (Succeeded) and gen 2 created Friday by a retry (Failed). Run `report search --created-before Wednesday` without `--history`.

- If the created filter runs before latest selection, gen 1 is returned as if it were current. That contradicts "no fallback".
- If it runs after, the group is omitted.

The two readings give opposite results.

**Edit:** In "Pagination and mutable state", state: "With history false, latest selection at the watermark happens first. _Every_ other predicate (status, created bounds, text and the group-invariant structured filters) then applies to that selected generation only." Add the Monday/Friday case to proof gate 3.

### B3. The budget convention contradicts itself and diverges from existing history without saying so

- **Inside the draft.** The page contract says scripts must always loop on `cursor` and that `scanLimited` can be true. The internal plan applies the 10,000-candidate / 16 MiB budget only "for the substring query". So it is undefined whether `--status Failed` with no query can return a scan-limited empty page. With latest-before-status, an index on status alone cannot drive that query without per-row superseded checks, so it may need a budget too.
- **Against the codebase. [read]** Every existing bounded read reports exhaustion as the `QueryBudgetExceeded` error: `run-history.ts:107-113`, `operation-history.ts:72`, `inspection.ts:196,279`, `run-summary.ts:42,74` and `lake-query.ts:33`. The draft's error list leaves this code out and introduces partial pages without citing the precedent.

**Edit:**

- State that `scanLimited` may be true for any request, with or without a query.
- State that ReportSearch never returns `QueryBudgetExceeded`, or name exactly when it does.
- Add one sentence: "This deliberately diverges from RunList/lake `QueryBudgetExceeded`, so that a no-match search over long history stays answerable."

Decision D2 then becomes a real user choice.

### B4. The source survey of Swamp leaves out properties that change the parity claim

**[vendored]**

- Swamp searches only `is_latest = 1 AND is_pending = 0` Markdown data, deduplicated per (model type, model ID, data name) (`vendor/swamp/src/infrastructure/persistence/catalog_report_adapter.ts:58-90`). Its result is "the current stored report per owner and report name", not run history. See D3.
- An unknown `--behavior` or `--workflow` is a NotFound error in Swamp (`vendor/swamp/src/libswamp/reports/search.ts:140-160`). The draft returns an empty result instead, which is defensible for historical IDs but differs from Swamp.
- Swamp's `--label` filter reads labels from the _currently loaded_ report registry (`search.ts:112-115,185-198`). So Swamp labels are not historical either.
- The CLI flag citation should be `report_search.ts:240-272`; the file has 272 lines.
- The `search.ts:169-214` citation is accurate.

**Edit:** Add these four facts to "Problem and evidence". Map the flags explicitly: Swamp `--type` corresponds to `--reporter`, Swamp scope `method`/`behavior`/`workflow` corresponds to `invocation`/`run`, and Swamp `--behavior` has no equivalent.

## User decisions (present explicitly; reviewer recommendation given)

### D1. Default statuses and one status per request

**[read]** `records.arm` inserts a WaitingSource row for every invocation of a task that has an invocation-scope attachment (`report-records.ts:214-244`). The row becomes NotApplicable(`OutcomeExcluded`) when the outcome is not in `on`.

**Counterexample:** a fan-out of 10,000 `upload` invocations with a `triage` attachment `on: [Failed]`, where 3 fail. `report search triage` returns 9,997 NotApplicable rows newest first, and the 3 real reports are scattered among them. Unfiltered, NotApplicable rows also use up the substring scan budget.

A single `--status` cannot express "anything that produced or tried to produce a report". It also cannot express "Failed or Cancelled".

**Recommendation (user's call):**

1. Make `--status` repeatable: OR within status, AND across fields. In the request this is `statuses?: ReadonlyArray<ReportStatus>` with 1–8 unique values, normalized as a sorted set in the cursor fingerprint. It costs one SQL `IN`.
2. Choose a default. My preference is **all statuses except NotApplicable**: a NotApplicable record says no report applies, so it is not a search hit. The alternative is unrestricted, matching `report list`. Either way, state that the default status set is part of the cursor scope.

### D2. Partial scan-limited pages versus QueryBudgetExceeded

Partial pages are strictly more complete: a no-match substring query can traverse all of history instead of failing. The cost is that consumers now face two conventions, and human users may get empty pages. Recommendation: accept partial pages, with the B3 wording and the CLI fix in C4.

### D3. Per-run rows versus Swamp's "current report per owner" view

Swamp's bare `report search` acts as a dashboard of current results. Effectory's returns one row per source run. With 365 nightly runs, `report search cost --workflow nightly` returns 365 rows; that particular question can be answered with `--status Succeeded --limit 1`. There is no way to list the current cost report for every workflow at once.

The user decides whether to:

- accept this and name it in "Compatibility and scope boundaries" as a distinct remaining gap (recommended for this slice), or
- add a collapse mode later.

Do not imply parity silently.

### D4. Source-root tags instead of report labels

Accept. Root tags are immutable, historical and already indexed by `host_run_tags_lookup`, and report runs inherit them. Swamp's labels are current-registry metadata (B4), so even Swamp cannot filter labels historically. The draft already disclaims label parity correctly.

## Internal corrections (no user decision needed)

**C1. `root.revision` duplicates `source.revision`.** **[read]** `report-sources.ts:99-108` sets `source.revision = run.revision` from the same root run. Drop `revision` from `root`. Add `acceptedAt`, the root admission time: consumers need it, because `createdAt` is generation time, and an old run's retry gets a fresh sequence and jumps to the top of a newest-first list. Item shape: `root: { kind, targetId, acceptedAt, tags }`.

**C2. Document what the sort order means.** The order is generation creation sequence. It is neither source admission nor settlement time. Generation 1 is created at arm time, which is source admission for run scope and invocation start for invocation scope, not when the report finishes. A retry of last month's report sorts first. Add this sentence: "'Newest' means most recently created generation; use `root.acceptedAt`/`settledAt` to judge recency of the source or result." The proof gate already covers retries; add the old-run-retry ordering case.

**C3. The status predicate must match the projected status.** `ReportRecord.status` is projected from the live report run when `reportRunId` is set (`report-records.ts:172`). **[read]** The stored `host_reports.status` is updated in the same transaction as each `host_runs.status` change (`host-store.ts:384-392, 536→568, 1264-1277`; `report-records.ts:431-440`). So filtering on the stored column in SQL looks sound. This is an invariant the plan relies on but does not state. Add to proof gate 5: "the SQL status predicate equals `ReportRecord.status` returned for every examined row, including Cancelling→Running and bind-while-Queued."

**C4. CLI continuation.** A cursor requires the client to resend identical filters and limit, because the fingerprint covers the full query (`pagination.ts:18-21,58-63`). That keeps it consistent with `report list`/`run list`. Making the user retype seven flags for each of up to N empty scan-limited pages is the actual usability cost. **Edit:** whenever the cursor is non-null in non-JSON mode, the stderr note prints the complete shell-quoted command to continue, not only when `scanLimited` is true. When the result is final and empty, also note that IDs are exact and case-sensitive. That covers the silent-empty typo case left by the NotFound difference in B4.

**C5. `LimitExceeded` cannot be reached.** One item is bounded at roughly 8 KiB of path preview + 4 KiB of tags + fixed IDs, far below 2 MiB. Keep the code as a defensive guard but say so. Note one real consequence instead: 200 items with maximal path previews and tags (~12 KiB each, ~2.4 MiB) cannot fit in one page. Byte-limited pages with fewer than `limit` items and a non-null cursor are normal, and gate 4 should include that case.

**C6. Query normalization location.** Matching uses JavaScript `toLowerCase`, and SQLite `lower()` is ASCII-only. State that the substring test runs in JavaScript over the bounded candidates, never as `LIKE`/`instr(lower())` in SQL. Otherwise non-ASCII IDs would match differently between implementations.

**C7. `--run` with an ID the caller does not own** returns empty, where RunReports returns NotFound. That is consistent with "unknown IDs give empty". Add it to gate 3 so it does not reveal whether the run exists.

## Accepted tradeoffs

- Live status with watermark-fixed membership, no re-visiting, and "rerun from page 1 to refresh". This matches RunReports.
- No aggregate or total count, no content or error body, and `report get` for details. Failed items show status without an error; this is acceptable.
- `--workflow X` includes invocation reports inside X; Swamp's workflow filter covers only workflow-owned reports. `--scope run` gives the Swamp-equivalent view. Keep this, and state the mapping (B4).
- `--task` covers both direct task roots and invocations. **[read]** This is correct: run-scope plans arm only on a root target match (`report-sources.ts:124-140`), and invocation plans arm on the task ID (`:142-156`).
- `--created-*` means generation time and differs from `run list --created-*`. The draft states this; keep it.
- Exact, case-sensitive IDs and literal substring matching, with no ranking.
- No TUI or picker. Pretty-JSON human output is consistent with every other command.
- Not added, and not required for this slice: a source-outcome filter such as "reports for failed deploys". It can be added later as `--source-status` if users ask for it.

## Exact small edits (summary)

1. Problem section: B1 replacement sentence and the RunList justification.
2. Problem section: B4 Swamp facts (`is_latest`/dedupe, NotFound, current-registry labels) and the `240-272` citation.
3. Pagination section: B2 rule that every predicate applies after latest selection, and the Monday/Friday gate case.
4. Page/error section: B3 wording that `scanLimited` applies to any request, the `QueryBudgetExceeded` stance and the divergence sentence. Internal plan: say whether structured-only queries are budgeted.
5. Flags/request: present D1 (repeatable `--status` / `statuses`, default set) as a user choice.
6. Item: `root: { kind, targetId, acceptedAt, tags }` (C1). Add the ordering note (C2).
7. Gates: the C3 status-projection invariant, the C5 byte-limited short page, the C6 JavaScript-only substring matching, the C7 non-owned `--run`, and the C2 old-run retry ordering.
8. CLI: C4 full continuation command on any non-null cursor, and the empty-result hint.
9. Scope boundaries: D3 "current report per owner" view named as a distinct remaining gap.
10. Presentation list: add D1's default and multi-status choice, and D3.
