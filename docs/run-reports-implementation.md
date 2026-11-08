# Run reports implementation

The user approved contract revision 2 on 2026-11-06, after clarifying the purpose of reports. The [approved contract](run-reports-api-draft.md) remains the implementation target. The approved slice is implemented and its final repository-wide verification passed.

## Core work in place

- Report.Source, sourceOf, result and make, with canonical schema/target provenance and captured execution policy.
- Report.History, source/outcome/history schemas and a private runtime-to-service bridge.
- History provision inside Task.definition, around task-local Layers; its requirement is excluded alongside Tag.Values and ArtifactStorage, including Layer input requirements.
- Application report registration, duplicate and count limits, and canonical target/reporter checks.
- Report.test with lazy fixture validation, typed outcome decoding, bounded history pages and invocation closure.
- SDK exports and regenerated host module loaders.
- Core tests for ordinary-task refusal, fixture decoding, registration, schema provenance, concurrent Layer lifetimes, service precedence, paging and closed readers. Type-only cases reject wrong targets, missing task scope, ordinary task schemas and undeclared retry tags.

## Durable source tracking in place

- Manual and scheduled admission capture the pinned attachment plan in the host transaction. A tag/description/report-plan edit does not reset a schedule's generation or watermark.
- Invocation registration arms one durable source per logical invocation, regardless of attachment count. Root completion records its status and failure category in the same transaction as the run's terminal projection.
- The existing runner tick polls up to 200 armed invocation sources, with a persisted rotating cursor. Sources whose roots have finished remain discoverable; unresolved early work cannot monopolize the scan after restart.
- Native outcome normalization is shared with `run outputs`. Own results and typed failures take precedence over later fences. Interrupted siblings become Cancelled or TimedOut from terminal root provenance; a sibling's error details are never copied.
- No-native, zero-attempt, and inconsistent suspended sources are distinguished. Missing native work is never executed to manufacture a report result. Final source facts are immutable, and temporary observation failures remain inspectable and retryable.

## Automatic execution in place

- Compact, deterministic report group/generation records reference the captured source and attachment plan. WaitingSource work becomes Queued or NotApplicable after source settlement.
- Promotion admits ordinary task runs in a private report namespace, atomically with the generation-to-run link and dispatch outbox. It rotates across source runs and enforces four active report admissions separately from the normal 1000-run budget.
- Report provenance and stored execution policy appear on Run, history summaries and watch snapshots. Report runs inherit source tags, use the source's pinned revision, and never recursively create reports.
- A daemon-wide four-permit semaphore bounds report attempts before they acquire ordinary task permits. Report root runs now use their captured timeout, attempt timeout and retry policy.
- Each reporting attempt receives a source-bound History service through the private runtime bridge. It supports typed outcomes and bounded invocation/event pages, works in task-local Layer acquisition/finalization, and refuses escaped readers after the invocation closes.
- Single-report cancellation and retry have persistent receipts. Cancelling WaitingSource work survives later settlement. Retry receipts are checked before latest-generation/active-state conflicts; retries use the same source and attachment plan.

## Operator integration in place

- Source-scoped bulk cancellation captures a sequence fence in its acceptance transaction, excludes later invocations/retries, stops promotion immediately, and drains at most 200 selected records per tick. Its receipt and progress survive restart.
- Report pages use signed cursors and fixed generation membership. Status projections and aggregate counts remain current. SQL computes counts without loading report bodies; definition lookup selects only the relevant attachment entry.
- RunReports, ReportGet, ReportRetry, ReportCancel and RunSummarize are registered on the control plane under `reports.v1`. Report commands and explicit origin filters check that capability before sending the operation.
- CLI report list/get/wait/retry/cancel commands, source bulk cancellation, run summary, origin filtering, safe terminal Markdown and exclusive output files are wired. Foreground source commands retain their outcome and print one reporting hint.
- Task/workflow description identifies attachment plans and report schemas. SystemStatus exposes separately bounded report counts and a lower-bound flag.
- Read-time summaries have a 10,000-invocation/five-second cooperative budget, at most 20 failure samples and no source input/result bodies.
- Root task completion keeps the JSON already encoded and scanned inside the attempt's vault guard. A regression probe first demonstrated that a stateful success codec could otherwise introduce a secret on a later encode; the fixed report deadline/root path no longer invokes that codec after its tracker closes.
- README usage and `examples/reports/effectory.ts` document the authoring and operator paths.

## Integration evidence

- Real CLI: Markdown/data/JSON, exclusive output refusal, aggregate and single-generation waits, parent approval independence, source hints, summaries and origin filters. Generation 2 reads the same pinned source after daemon death. Killing the daemon during active report execution recovers the same report IDs/run IDs, without duplicate generations.
- Installed extension: a built archive goes through fake-gh download, trust, generated facade, publisher/consumer typechecking, revision loading and real daemon restart. Both source-specific and generic extension reporters read their source correctly, including generation 2 after restart. This uses synthetic fixtures, not a published release.
- Scale: 1,000 invocation sources with 16 attachments produce 16,000 records. Five scans see all 1,000 sources once; inspection remains bounded, daemon counts indicate truncation, and 80 cancellation batches each process 200 records. No claim of a 160,000-record benchmark is made.
- Capacity: four blocked report handlers leave a normal task runnable and release all permits. Thirty-two NeedsAttention reports do not exhaust admission. Draining prevents promotion while preserving queued work for a new instance.
- Cancellation/retry: receipts, generation conflicts, transactional admission rollback, durable cancellation before source settlement, fixed bulk membership, later invocations/retries and reopened cancellation progress are covered.

The full Swamp parity goal remains open. Subsequent approved slices implemented child-workflow boundary reports and submission-time report selection. Configured-model defaults and automatic lake publication/report retention remain gaps.

## Verification checkpoint

Final verification on 2026-11-06: `bun run typecheck` and `bun run check` passed. The integrated `bun test` run passed **352 tests across 90 files, with 2652 assertions and zero failures**, in 507.28 seconds. Log: `/tmp/effectory-reports-complete-tests.log`. No runtime source changed during this full run; one test-only TypeScript narrowing correction was made and typecheck/check passed again. Subsequent edits only finalized documentation.

Executed integration proofs:

- `/tmp/effectory-report-cli-recovery-tests.log`: real CLI and daemon recovery, 23 assertions, including restart during active reports with unchanged report/run IDs.
- `/tmp/effectory-report-extension-tests.log`: installed typed and generic reporters, seven assertions, including generation 2 after real daemon death.
- `/tmp/effectory-report-final-focused.log`: 26 core/storage/execution/operator tests, 486 assertions, including the 16,000-record backlog, attention/drain capacity and four-handler isolation. The final full suite also includes the capability-preflight refusal test.
- `/tmp/effectory-report-guard-probe.log` records the deliberately failing secret-encoding regression before the correction; the regression now passes in the execution suite. No real credentials were used.

These logs supplement the repository’s test sources; they are local scratch output, not portable release artifacts. The integrated report slice has not been rerun in Linux in this checkpoint, and no live GitHub release was published for these extension fixtures.

Cross-run report search is implemented in a subsequent approved slice; see the [search guide](report-search.md) and [verification record](report-search-implementation.md).

Workflow invocation reports are implemented in a subsequent approved slice; see the [usage guide](workflow-invocation-reports.md) and [implementation record](workflow-invocation-reports-implementation.md).
