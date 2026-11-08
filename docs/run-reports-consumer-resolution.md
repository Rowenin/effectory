# Run reports — consumer review resolution notes

Status: historical consolidation notes. The Effect review has now arrived and [contract revision 2](run-reports-api-draft.md) is the authoritative proposal for user discussion. Where these notes differ (notably stopped-sibling classification and bulk cancellation), revision 2 supersedes them. No user approval or implementation authorization is implied.

The [consumer review](run-reports-review-consumer-round2.md) conditionally approves presentation after F1–F9 and explicit user choices. The following records the intended resolution and the source corrections needed before editing the contract.

## Correctness and receipt fixes

**F1 — source outcomes.** Normalize the native result before deciding whether reporting applies. Preserve success, the task's own domain/host/defect failure, and a genuine typed timeout. For interruption-only results or synthetic dispatch Control/Cancelled, use a recorded control fence's outcome; a sibling-failure fence means this invocation was cancelled, not that it raised the sibling's error. Without a meaningful fence, self-interruption stays a defect. Do not replace an independently completed result with a later parent outcome.

An invocation with no admitted attempt gets a NotApplicable report record with reason NotStarted. Existing RunOutputs keeps its current status union and shows the normalized stopped/deadline outcome; NotApplicable describes reporting eligibility only. Explicitly test admission deadline expiry before the first attempt, a timed-out attempt racing another fence, rejection with an active sibling, sibling fail-fast, cancelled retry backoff, self-interruption, and a successful task followed by parent cancellation. This is a proposed precedence rule, not a claim that those tests already pass.

**F2 — source waiting.** Replace immediate refusal of a nonterminal source with observation through execution, timers and retry delays. Use the existing foreground predicate: NeedsAttention, or Waiting with an open approval/input/signal, needs outside action and exits 4. Waiting alone does not. Recheck the final source state to settle ordinary observation races. Once terminal, wait for report generations. This is distinct from plain run watch, which can remain attached to external waits.

**F3 — record completeness.** Add `reportRunStatus: RunStatus | null` and `reason: "NotStarted" | null`. Define the full report-state union once, including NotApplicable. Keep source outcome statuses separate from report lifecycle statuses.

**F4 — cancellation.** Use the explicit receipt `{ reportId, reportRunId, acceptedAt, actor, reason, requestKey, replayed, status }`, with nullable run ID and reason. Cancelling a terminal record is an idempotent no-op. Derive a delegated RunCancel key from the report ID and request key; direct run cancellation also updates the report record. Receipt status is the accepted operation's status, not a promise of current status on replay.

**F5 — retry.** Scope keys to principal and logical report group. Check a prior receipt before checking whether the latest generation is active. A matching replay returns the generation that key created at its current status. Include the requested report ID in the fingerprint, so using the same key against another generation conflicts rather than silently changing intent. For a new key, recommend requiring the named report to be the latest generation and Succeeded, Failed or Cancelled. NeedsAttention must be cancelled first; NotApplicable cannot be retried. The user-facing contract must state this ordering.

## Capacity, compatibility and discovery

**F6 — fairness.** Round-robin promotion across source runs, oldest ready obligation first within each source. The 32 admitted report runs and four executing report attempts remain proposed limits. Both normal admission and normal-active health counts must exclude report-origin rows. Expose separately bounded report backlog counts; do not imply an exact cheap count over arbitrary history. Promotion fairness cannot guarantee latency when already-running reports stall.

**F7 — foreground hint.** In human foreground mode, print one best-effort stderr line pointing to `report list` when the pinned source has matching attachments, including a stop for approval. Keep stdout and the source exit code unchanged. A failed hint write must not replace the actual outcome.

**F8 — capability preflight.** Explicit `run list --origin` requires the reports capability before making the filtered request, just like report commands. Old daemons must not silently return unfiltered rows.

**F9 — scope and extension typing.** A directly submitted task has both a root and a task invocation, so two attachments with different scopes produce two reports. A generic extension reporter gets JSON outcomes unless it imports the target contract for a typed read. History is a regular host-installed service, not a Context.Reference. Replace the nonexistent NeedsAttention “resolve” remedy with cancellation.

## Choices to present, not quietly adopt

The consumer review has already critiqued these alternatives. Recommendations below remain proposals and await the Effect review and user approval.

1. Require scope for task targets; workflow targets can default to run scope. This avoids silently skipping tasks invoked inside workflows.
2. Add the reviewed single-record wait form, `report wait --report <report-id>`, so an invocation report can be awaited while its parent waits for approval. It follows that exact generation and does not wait for unrelated source work.
3. Keep report runs visible with provenance and an origin column/filter, and disclose the volume: one attachment on 10,000 invocations creates 10,000 ordinary task runs.
4. Count an operator-cancelled report as failure for aggregate waiting. When all latest records are terminal or NeedsAttention, exit 4 takes precedence over exit 1; success requires all Succeeded or NotApplicable.
5. Disclose that reporter retry and timeout policies require new admission plumbing even though execution reuses tasks. Persist the resolved policy and expose it in report/run inspection. The proposed 30-second attempt and five-minute total defaults need explicit approval.
6. Bulk cancellation/retry is not designed yet. Do not claim individual commands are practical at 160,000 obligations. Either explicitly defer bulk operations and state that limitation, or design and review a bounded source-scoped cancellation operation before adding it. A live source can create more obligations during cancellation, so a naive paged loop is not a complete contract.

The `report get` exit table should be explicit and independent of JSON formatting: Succeeded and NotApplicable exit 0 (NotApplicable creates no content file); Failed and Cancelled exit 1; WaitingSource, Queued, Running and NeedsAttention exit 4. The built-in summary reply needs its own name, distinct from the existing RunSummary history-row schema.

No production files were changed for these notes. The attachment feasibility probe, source checks, and six-case probe of the real runner's native outcomes are recorded in [the evidence document](run-reports-persistence-evidence.md). The runtime probe confirms the interruption/fence distinction and the no-attempt case; it does not implement or validate the proposed report mapping.
