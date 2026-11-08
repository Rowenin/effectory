# Report selection feasibility evidence

Historical pre-approval probes, dated 2026-11-06. The [proposal](report-selection-api-draft.md) has since been approved; see the separate [implementation evidence](report-selection-implementation.md). No production code or repository tests were changed for these probes. They do not constitute implementation verification or independent reviewer approval.

## Candidate traversal

`/tmp/effectory-report-selection-probes/graph-and-wire.ts` builds an actual Application with the existing Task, Workflow, WorkflowPatch and Extension APIs:

- A direct task in the root.
- Both branches of a conditional whose condition is literally true.
- A task inside an empty fan-out template.
- A linked child called both directly and inside that fan-out.
- A task introduced by a selected extension's compiled before-step patch.
- An unrelated task and a run-scope report attached to the child workflow.

A labelled stand-in candidate resolver uses `Workflow.allNodes` and a visited set over `registry.workflows`. It finds all six reachable task identities plus the root workflow's report, omits the unrelated task and child's root report, and visits the shared child definition once. A counter in every task handler remains zero. These are actual compiled graph structures, including the extension patch; the resolver itself is scratch code, not a new SDK API.

The earlier `selection.ts` probe demonstrates why this traversal is needed: today's reportPlan captures both an applicable task attachment and an unrelated one. Runtime invocation registration prevents the latter from running, but the broader list is unsuitable for proposed graph-scoped selector validation.

## Response compatibility and size

The graph/wire probe defines the proposed SelectionDecision schema as a stand-in using Effect Schema. It extends the **real current Run schema** with an optional field and checks:

- The current Run decoder drops the added field.
- The proposed optional field accepts an older Run without a decision.
- The current RunSummary decoder omits the field, preserving compact list/watch records.

The populated decision uses 128 distinct valid 200-character IDs, repeated across requested inclusion/exclusion and selected/required sets, plus two 32-entry tag maps. Its encoded size is **111,183 bytes** (the full small-input Run is 111,491 bytes). The tag maps are within, but do not exhaust, their 4096-byte budgets, so this is a large concrete example, not the maximum.

A conservative bound follows from the proposal's invariants: four groups of at most 128 ASCII identifiers at 203 JSON bytes each, two tag maps at 4096 bytes each, plus fixed field/envelope overhead fit within 128 KiB. Selected and excluded together count as one group because they partition the candidate set; required is a subset of selected. Stored-decision validation must enforce these invariants rather than assuming independent array length checks prove them.

The real daemon's maxRequestBodySize is 1,048,576 bytes (`packages/platform-bun/src/daemon.ts:255`). A selector therefore shares the body budget with input and RPC framing. This is now explicit in the draft. No HTTP integration test of the new field was run; the schema probe alone does not establish old/new binary transport compatibility.

## Selection model and existing tags

`selection.ts` uses actual `Tag.make` and the existing normalization helper to verify encoded values, frozen maps and rejection of bare declarations. Its labelled stand-in selection function checks eight cases: default inclusion, skip-all with required immunity, explicitly skipping a required attachment, simultaneous include/skip, inclusion tags, name-plus-tag intersection, conjunctive exclusion tags and unmatched tags.

This does not validate the future Report.make or schedule signatures, idempotency fingerprints, captured selection persistence, or admission behavior. Those remain approval-dependent implementation gates in the proposal.

## Artifacts and verification boundary

Scratch scripts/logs are under `/tmp/effectory-report-selection-probes/`. Their assertions use Bun with the repository's Effect 4.0.5 and real imported SDK/runtime modules. They use no external accounts or credentials and create no daemon/repository state.

The repository's 409-test green run belongs to the prior report-search implementation. Its 304-file source manifest remained unchanged during this design work. Only proposal/evidence documentation changed here; formatting/lint is checked separately.
