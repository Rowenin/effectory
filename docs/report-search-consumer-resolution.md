# Report search — review consolidation

Both round-1 reviews have completed. Their required corrections are incorporated into [draft 2](report-search-api-draft.md), which the user subsequently approved. This file preserves the consolidation rationale. The user approved draft 2 on 2026-11-06; implementation and verification are complete; see the [evidence record](report-search-implementation.md).

## Consumer corrections incorporated into draft 2

- Correct the motivation: run list --origin report already finds admitted report runs through provenance. The new capability covers records without runs, source/attachment filters and scalable discovery. A separate report-record search remains warranted.
- Apply every generation-varying predicate, including created bounds, after latest-generation selection at the fixed watermark. Group-invariant predicates may be pushed down only where equivalence is proven. Add the Monday-success/Friday-failed-retry counterexample.
- Correct the Swamp survey: only current stored Markdown per owner/name, unknown owners fail, labels come from currently loaded definitions, and the CLI citation ends at line 272. Map its type and scope filters honestly; no configured behavior instance equivalent exists.
- Use root acceptedAt rather than duplicate root revision. Explain that newest means generation creation, so a retry for an old source can appear first.
- Require the SQL status predicate and returned normalized report status to agree, including bind and cancellation transitions.
- Print a complete shell-quoted continuation command for every non-null cursor in human mode. Never interpolate user strings without quoting; do not put sentence punctuation into the command itself. Explain final empty results and exact ID matching.
- Specify JavaScript substring matching over bounded metadata; byte-limited short pages are normal, and an individually oversized item is a defensive corruption/limit guard.
- Preserve principal filtering when --run names an unowned run; return empty without revealing its existence.

## Proposed user decisions

Recommend repeatable --status, with an explicit set of statuses in the request, and default to all except NotApplicable. This avoids burying three failure reports under 9,997 excluded fan-out records. The user's approval is required for the default and repeatable surface; it has not been inferred from the review.

Recommend continuation pages instead of QueryBudgetExceeded for ordinary search-work exhaustion. This differs from existing history/lake reads and must be stated, including empty non-final pages for structured-only requests if the final work strategy needs them. The parent's [query evidence](report-search-query-evidence.md) shows why bounding only substring work is insufficient. Do not claim the selective tag query solves broad predicates.

Recommend keeping per-source-run/group results and historical root tags. Explicitly name Swamp's current-report-per-owner dashboard and definition labels as remaining gaps. This slice is not complete report parity.

## Additional parent findings for the Effect consolidation

- Broad indexed tag subqueries still took 637–1,284 ms while returning 51 rows on a 200,000-row model. A 256-position window was fast but changes what consumes the request work budget. Resolve this before user presentation.
- A subsequent bounded-position paging model passed 72 filter combinations across 5,667 pages using the real signed cursor service. It preserved byte-limited items and fixed-watermark membership while retries arrived, including 1,879 empty continuation pages. This supports the alternative's correctness, not its approval; sparse exact filters would also consume unmatched positions and may need multiple pages. Full evidence and limits are in the query-evidence document.
- A group/sequence index avoids scanning generations beyond an old watermark. Confirm monotonic generation/sequence during backfill.
- A metadata projection using the real host schema worked without reading a corrupt error body; reusing the current detail getter and dropping fields afterwards is insufficient.
- Effect RPC's default decoder strips unknown keys, but Effectory already strictly validates raw payloads before RPC dispatch (`daemon.ts:76–95,230–253`). The initial framework-only concern is withdrawn: no new codec is needed. Clarify that malformed wire payloads receive the existing HTTP 400 response, while semantic filter validation can use typed InvalidInput.

## Effect corrections incorporated

Draft 2 adopts ordered-index intersection with 10,000 work units per page and 500 per synchronous batch, immutable per-generation search/tag rows, SQL residual status/scope/creation checks, and principal-led indexes. It adds every-startup atomic catch-up, explicit migration cost, checkpoint-based ownership proofs, and the review's full implementation gates. This retains the full search scope and improves sparse conjunctions over the parent's window-only alternative.

Three implementation clarifications avoid carrying an inaccurate mechanism into the contract:

- Use a dedicated metadata projection in the same batch transaction as admission predicates. The review's suggested records.get would read error bodies, contrary to the metadata-only requirement; the real-store probe establishes that distinction.
- Preserve the original 16 MiB **serialized UTF-8 metadata** budget, with explicit byte accounting, rather than renaming UTF-16 units as bytes. Text matching still uses JavaScript Unicode case folding. Schema-derived batch bounds prevent materializing a batch beyond the remaining metadata allowance.
- A work-budget stop during index alignment must retain the unexamined candidate. Its exclusive cursor bound is candidate sequence plus one; only a fully examined candidate can be skipped. Test strict progress and no omissions at that boundary. The review's shorthand “last examined” is insufficient for a partially aligned candidate.

These are internal clarifications, not additional public surfaces. Neither reviewer requires another full round after the specified corrections. User decisions remain the recommended package at the end of draft 2.
