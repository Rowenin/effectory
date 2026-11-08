# Workflow invocation reports — implementation record

The user approved the [contract](workflow-invocation-reports-api-draft.md) on 2026-11-06. [Usage](workflow-invocation-reports.md) and the [complete example](../examples/workflow-reports/effectory.ts) describe the public API.

## Implementation

- Workflow attachments accept invocation scope. Graph-scoped report selection visits reachable workflow identities, including selected patch graphs. Workflow defaults remain run scope; direct submissions match both scopes when separately attached.
- Private `host_workflow_invocations` rows store stable root/path identity and an entered marker, separately from task payloads and manual-recovery state. Registration arms selected report obligations transactionally before execution. Empty workflows enter without inventing task attempts.
- The native child deferred is the outcome authority. Observation uses the original root execution and an explicitly owned Effect Scope; it never resumes the source. Deterministic execution-ID lookup also covers a crash before the host saved that ID. Root invocation sources poll the native root result.
- A cached child failure retains its own validated category while the root retains its first fence reason. An entered child with no cached result waits until the root ends, then follows the approved stop mapping. A never-entered child becomes NotApplicable/NotStarted.
- SQLite triggers record event/task attribution in the inserting transaction, including the lake connection's publication events and wait settlement. Deadlines pass their path explicitly. The private projection avoids loading sibling event bodies and matches complete JSON path segments, including Unicode and punctuation.
- Scoped History processes short synchronous batches, yielding between them with no live SQLite iterator. It preserves the original snapshot/expiry and emits continuation cursors after row, attribution-byte or cooperative-time exhaustion, including empty pages. Matching oversized event bodies are rejected before loading them in full.
- Search uses the existing ordered source-target index for `sourceWorkflowId`. `--workflow` still filters the root. The new CLI flag requires `reports.workflow-invocations.v1`; task and workflow source filters cannot be combined. When the filter is absent, its key is omitted from the cursor fingerprint to preserve older search cursors.
- Existing report queues, four-handler capacity, retries, cancellation, retained source publications and report-reader exemptions are reused. No new runner service or author-facing Scope/Layer abstraction was introduced.

## Executed integration evidence

Repository tests, rather than only the earlier scratch models, cover:

- Two child reports finishing while the parent waits, with typed values, distinct identities and sibling-free task/log/publication/deadline history.
- Direct-root invocation and run attachments together; empty workflows; keyed fan-out; inactive branches; a workflow inside a selected extension before-step patch.
- Child domain and input-boundary failures, child deadlines, approval rejection, cancellation before/after entry, and concurrent child failures with distinct schemas. Root first-fence precedence remains intact. Rejection without a cached child result maps that child to Cancelled while the parent stays Rejected.
- A real daemon killed with an entered child waiting; killed after native child completion before materialization; and killed after materialization before report admission. Test-only SQLite triggers pause the host transitions, never engine tables. The original report ID survives, and explicit report retry preserves the child source.
- An installed extension's workflow attachment through package building, generated facade, consumer typechecking and daemon restart. Existing typed task and generic reporters remain covered.
- The actual attribution/paging implementation over 250,000 sibling events: empty pages advance, a 2 MiB sibling body is excluded, Unicode/prefix-like names stay separate, snapshot membership is fixed, cursors cannot cross sources/principals, response-byte cuts do not skip events, matching oversize fails, and interrupted scans leave no transaction open.
- Typed `Report.test` workflow fixtures, capability refusal before using the new filter, complete continuation flags, and root/source workflow search distinction.
- Root-publication retention and reporter pin exemption with 1,025 versions for both existing run reports and workflow-invocation reports, including projection rebuild and transactional rollback.

Local focused logs: `/tmp/workflow-lifecycle-tests.log`, `/tmp/workflow-integration-tests.log`, and `/tmp/workflow-final-focused.log`. These supplement committed-style test sources in the working tree; they are not portable release artifacts. No live extension release was published.

## Verification

Final verification on 2026-11-06: `bun run typecheck`, `bun run check` and `bun test` passed. The complete suite passed **442 tests across 116 files, with 3,670 assertions and zero failures**, in 842.91 seconds. All 316 source/test/example files matched `/tmp/workflow-verified-manifest.json` after the run, with no added or removed files.

Logs: `/tmp/workflow-verified-typecheck.log`, `/tmp/workflow-verified-check.log`, `/tmp/workflow-verified-tests.log`. The legacy-cursor correction also passed 11 focused search tests with 409 assertions before the full rerun. No Linux-specific verification was added in this slice.
