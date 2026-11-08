# Post-run reports: next parity design

Status: research and provisional design only. No report API is approved and no implementation is authorized. The broad Swamp parity goal remains open. The preceding vault implementation is complete; this is a separate feature.

## Evidence and missing capability

The vendored Swamp source has a report definition with method, model and workflow scopes. Its handler returns Markdown and structured JSON. Report selection combines declared reports with require/skip and CLI filters. The executor loads extension reports, emits report lifecycle events, persists paired Markdown/JSON artifacts, and records report failures separately in its execution summary. Empty Markdown skips persistence. These statements come from source, not running Swamp:

- `vendor/swamp/src/domain/reports/report.ts`
- `vendor/swamp/src/domain/reports/report_context.ts`
- `vendor/swamp/src/domain/reports/report_selection.ts`
- `vendor/swamp/src/domain/reports/report_execution_service.ts`
- `vendor/swamp/src/domain/reports/builtin/workflow_summary_report.ts`
- `vendor/swamp/src/libswamp/reports/report_views.ts`

The [persistence and caller evidence](run-reports-persistence-evidence.md) traces report failures through Swamp's callers: direct method reports can change the final view and CLI exit to failure, while workflow reporting preserves the workflow result. Catching errors in the report executor alone would not establish this distinction.

Effectory currently offers run results, events, attempts, outputs, logs and artifacts. It has no report declaration or post-completion report execution surface. `packages/core/src/index.ts`, `task.ts`, `workflow.ts`, `application.ts` and `packages/runtime/src/rpc.ts` establish the current authoring and control-plane boundaries. The existing doctor diagnostic report is unrelated.

## Consumer outcome

An author should be able to attach a reusable report to a task or workflow. After execution, including failure, an operator can find a concise human report and its machine-readable data. Installed extensions can provide reports, and application/test Layers can supply or replace their dependencies. Reports remain linked to the source execution and pinned implementation revision. Report failures must be inspectable, and a daemon crash must not silently lose work accepted for reporting.

Investigate both task invocations inside a graph and submitted root runs. Do not label root-only reporting as full method/workflow parity. Configured model-instance reporting has no direct counterpart yet. Keep any incremental boundary explicit.

## Provisional authoring direction to critique

Prefer an ordinary Effect handler, supplied as the second argument of a spec constructor, and normal `.provide(Layer)` composition. A possible domain wrapper is `Report.make(spec, handler)` with declared output-data and error schemas. The handler would return Markdown plus decoded structured data. A report source would be a required Effect service supplied by the host, not a callback context bag. Definitions attached to task/workflow specs would be discovered and validated by the application.

This is not a settled signature. Compare it against using normal `Task.make` definitions as reporting tasks, with a thin attachment spec. Reuse task execution, retry, publication and secret-protection machinery where sound. Avoid implementing a second task engine or assuming every domain concept needs a new service. A wrapper only earns its place if it removes repetition while preserving type inference and normal Effect requirements.

The alternatives must show a complete consumer path: definition, attachment, two dependency Layers, a task-local override/test, an installed extension report, and CLI retrieval. Before presentation, choose exact names and supply typechecked stand-ins where the implementation does not exist.

## Contracts that must be resolved before presentation

1. **Trigger and scope.** Define whether task reports run once per logical invocation or once per attempt; root tasks, graph tasks, nested workflows, fan-out, skipped work, cancellation and uncertain manual effects need explicit behavior. Retries must not silently create duplicate reports. State what happens when a graph's task contract is replaced by an extension implementation.
2. **Source data.** Specify a schema-owned immutable source identity/outcome and how a report obtains bounded steps, outputs and artifact references. Do not load unbounded run history into one context value. No new general artifact-content reader is implicitly approved by this feature. If one is needed, design and review it explicitly, including retention and binary streaming.
3. **Durability.** Resolve atomic capture of the reporting obligation with source completion, revision pinning, deduplication, daemon restart, interrupted manual/idempotent reports, retry policy and durable failure receipts. Source task completion may occur inside an Activity before root-run terminal projection; investigate the real transaction boundaries.
4. **Lifetimes.** Define the daemon owner of background report work, per-report attempt Scope and Layer memoization, cancellation/drain, shared application providers and secret tracker lifetime through final encoding. No detached fibers or reliance on Scope finalizers for crash recovery. Report output must pass the same secret guard as task output.
5. **Execution outcome versus reporting outcome.** Decide whether reports delay foreground completion or alter its exit code. If reporting is asynchronous, provide a concrete way to await/inspect it. Avoid reports recursively triggering reports. Decide whether report jobs are ordinary visible runs with provenance or a distinct operation surface, and explain why.
6. **Storage and retrieval.** Prefer the existing lake and retention machinery over a second content store. Decide one structured record versus paired Markdown/JSON publications, stable identity/version rules, partial publication recovery and reclaimed-content behavior. Specify terminal rendering and file output without interpreting untrusted terminal controls.
7. **Registration and extensions.** Show how attached definitions contribute Effect requirements, how canonical identity is enforced, how installed extension exports or contributions are selected, and how old bundles retain the original reporter. Do not assume that a value exported by an extension is automatically registered or selected.
8. **Public boundaries.** Exact library declarations, schemas, CLI commands and RPC payload/reply shapes must agree. Reuse existing pagination, error codes, capabilities and client compatibility patterns. State limits and operational recovery rather than adding caps without a way to proceed.
9. **Swamp comparison.** Separate built-in summaries, custom reports, method/workflow attachment, label selection, automatic persistence, error artifacts and discovery. Identify any deferred capability as a gap; do not silently reduce the parity target to a single built-in text formatter.

## Proof gates

- Type inference and remaining service requirements through constructor, attachment, Application and `.provide`; mixed report arrays; extension canonical identities; invalid payloads.
- Final failures and successes, retry-once versus per-attempt behavior, fan-out identities, skipped branches and cancellation.
- Crash before/after source completion, obligation admission, report publication and acknowledgement. No missing obligation and no duplicate durable report.
- Real CLI flow from submitted workflow to report retrieval, including report failure, pending work, restart and reclaimed content.
- Concurrency/isolation and Layer finalizer order; secret guards on report text/data/errors and provider reads.
- Bounded history traversal and storage; large workflows; fairness with normal execution; shutdown closes reporting resources before stores.

The design and consolidated-contract reviews are complete. Revision 2 of the [consolidated contract](run-reports-api-draft.md) folds in both reviewers' conditional presentation fixes. It selects ordinary task reporters, declarative bindings, metadata input plus a History service, and separate task runs with incremental invocation reporting. It also specifies source outcome normalization, four report slots, individual and bulk cancellation, and explicit waiting. The user approved contract revision 2 on 2026-11-06. See the implementation checkpoint for the code and executed verification.
