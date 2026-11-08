# Workflow invocation reports — research

Status: research completed; the user approved implementation on 2026-11-06. The original observations below describe the pre-implementation tree. This document records current source and scratch evidence, not a new public contract or an independent review.

## Consumer need and Swamp evidence

Attach one report to each execution of a reusable child workflow, rather than only to its individual tasks or the submitted parent. For example, a deployment fans out a regional workflow; each region should have a report over its own outcome, independent of when the parent finishes.

In the pinned Swamp source, `execution_service.ts:7122` starts a nested workflow through `childService.run`. The same service's normal completion path invokes `runWorkflowReports` before emitting completion (`:4016–4033`). Its report runner treats absent operator filters as no filtering (`:7981–7984`), and the child call does not forward the parent's report filters. Cancellation returns before workflow reporting (`:3995–4002`). These are source observations, not a Swamp runtime test. Effectory should retain its existing explicit root selection and reporting on stopped sources rather than copy those differences accidentally.

Effectory currently rejects `Report.make({ target: Child, scope: "invocation", ... })` both statically and at construction (`core/report.ts`). Child tasks are separately registered in `host_invocations`, but the child workflow boundary is not. `executeChild` runs the child graph inside its parent native execution. Every graph node already has an engine-owned durable result through `DurableDeferred.raceAll`; it is not necessary to add a second execution journal just to observe a completed child.

## Tested against the real host and pinned Effect

Scratch directory: `/tmp/effectory-child-report-probe/`. `probe.ts` imports the real SDK, interpreter, host Layer, SQLite engine, runner and store. It uses a synthetic catalog with a fixed revision, not the daemon's saved-bundle loader. `write` and `read` are separate Bun processes over the same SQLite files. No production source or repository tests were edited.

| Case | Observed result |
| --- | --- |
| Child task returns 42 while parent remains unfinished | `WorkflowEngine.deferredResult(nodeResult('["child"]'))` returns the encoded success |
| Fresh process reads that child's durable result | Returns 42 with zero handler executions in the new process |
| Child fails with a declared `ProbeFailure` | The child deferred contains `ExecutionFailure` with category Domain and the encoded error |
| Fresh process reads the failed child | The same failure is available without a handler execution |
| Child workflow has no tasks and returns its input | Returns 41; parent reaches Waiting; no task handler runs |
| Child is asleep when its root is cancelled | Root becomes Cancelled; the child's durable result remains absent |
| Two child workflows fail concurrently | The winning child has a cached failure; the interrupted sibling has no child result, even in a probe where its task's own native result contains a domain failure |

The last two observations rule out deriving the child outcome simply from its task results. An absent child result does not mean the child never started. Effect's `DurableDeferred.recordExit` deliberately does not persist an interrupt-only exit. A started marker and terminal root facts are necessary to distinguish unfinished, never-entered and interrupted child work.

Result lookup requires `WorkflowInstance`. The typechecked probe supplies an instance for the **existing root execution ID**, with an explicitly acquired and released closeable Scope. It calls only `deferredResult`; it does not execute or resume the workflow. `WorkflowInstance.initial` without an owned scope would allocate a scope that the caller must close.

Logs: `write.log`, `read.log`, `failure-v2.log`, `empty.log`, `cancel.log`, `siblings.log`, `siblings-simultaneous.log`. `typecheck.log` passed for `probe.ts` under the repository TypeScript settings with the Effect suggestions plugin disabled. The sibling probes ran but were not separately typechecked. The first failure probe attempted host teardown before terminal projection, stalled during cluster shutdown, and was terminated; `failure-v2` waits for the terminal projection before closing and completed. That first probe is not evidence of successful shutdown.

## Proposed direction to discuss

Allow the existing `scope: "invocation"` on a workflow target. Keep `Report.sourceOf(Child)`, ordinary reporter tasks, `Report.History`, selection, report retries and companion runs. Each activated child path gets one identity, including keyed fan-out and patch/branch paths. Workflow replay must reuse that identity. Inactive branches must not create synthetic child executions.

For consistency with directly submitted task runs, the recommended interpretation is that invocation-scope workflow attachments also apply to a directly submitted workflow root. Existing omitted/run scope continues to mean only a submitted root; it must not start firing for nested uses silently. The user subsequently approved this consistency rule.

The user chose child-subtree History. The remaining contract is in the [proposal](workflow-invocation-reports-api-draft.md), awaiting approval. Today's invocation history has task-shaped rows and today's event history is root-wide. Scoping cannot be advertised as a cosmetic change: it needs attribution, cursor ownership, sparse-page behavior and tests against sibling activity. ArtifactReader remains a separate capability with its existing principal and retention rules.

Existing report search distinguishes the submitted root (`--workflow`) from task sources (`--task`). It has a generic source-target index internally but no workflow-source selector. A proposed `--source-workflow` filter can reuse that index; it must not change the meaning of `--workflow`.

## Internal requirements and unresolved proofs

1. Register a selected child obligation and its stable locator before entering the child body. Record successful entry separately from terminal outcome. Registration, selection and recovery cannot depend on a live fiber or a finalizer surviving a crash.
2. Keep the outcome in the native durable deferred. Poll through Effect, without querying or editing engine tables. A bounded rotating scan must survive a crash between deferred completion and report materialization, including completed roots.
3. Cache success/typed failure for each child boundary and preserve the original child cause before root-wide fencing replaces it. `stopWithFailure` currently returns the first recorded root reason. It is not yet proven that every concurrent-failure path preserves a suitable child-local error. Root failure precedence must stay unchanged when fixing this internal boundary.
4. If a native child result is absent, keep it pending while the root is unfinished. After a terminal fence, classify entered interrupted children from the stop reason; never attribute a sibling's domain error to them. Do not call a zero-task child NotStarted merely because it has no task attempts. An unexplained missing result after a successful root is an observation failure, not an invented success.
5. Arm source protection before descendants can publish. Use the existing report hold on the root's publications; no per-child reference ownership or automatic reclamation change is implied.
6. Expand admission candidates to include reachable workflow identities and the root invocation. The selected plan stays immutable across retries, deployment and schedules. Required immunity and `on` filtering retain their approved meanings.
7. Keep task invocation tables and the leaf recovery scanner type-safe. Do not insert workflow locators into tables that recovery assumes contain leaf payloads. Root cancellation must still wait for task/resource cleanup.
8. Bound child registrations using the existing graph expansion limit. At most sixteen attachments per target/scope and 128 per application remain. Reporting must not recursively trigger reports or consume the normal run capacity lane.
9. Reuse report record/source schemas where their existing combinations suffice. Audit path previews, history, search, test fixtures, source outcome decoding, cancellation/retry receipts and older readers for assumptions that every non-null invocation ID is a task execution ID.
10. Required implementation proofs include process kills at registration/entry/completion/materialization, an empty workflow, an unfinished parent, sibling failure and rejection, parent/child deadlines, cancellation, manual leaf recovery, nested fan-out and patches, restart/revision pinning, selection, report retention, and bounded history queries under heavy sibling traffic.

No claim is made yet that the complete public contract is ready for implementation. The existing 425-test green suite predates this research and is not verification of child workflow reports.

## Scoped pagination feasibility

After the user chose subtree history, `paging.ts` tested a labelled stand-in attribution index in SQLite. It walked 250,003 events with 250,000 unrelated sibling rows, returning the two matching child rows over 26 pages (25 empty). Every page advanced and examined at most 10,000 rows. Literal segment-prefix matching handled a child name containing percent, underscore, quotes, backslash, slash and Unicode, and rejected a similar sibling name. It used completed batch statements rather than an open iterator.

This probes the proposed traversal strategy, not production History. It proves row-budget progress and matching for those paths; it does not prove the byte/time budgets, actual event attribution, cursor signing, cancellation, or migration. Those remain implementation gates. The recorded timing in `paging.log` is a local measurement, not a latency guarantee.

## Subsequent implementation

The approved API is implemented; see [usage](workflow-invocation-reports.md). The earlier scratch authoring and pagination probes were followed by real SDK, host, CLI and installed-extension tests. Those tests cover typed workflow fixtures, independent reports, subtree event attribution, 250,000 sibling events, three restart boundaries and source-publication retention. Verification details are maintained in the implementation record.
