# Report source and persistence evidence

Research for the unapproved [report design](run-reports-research.md). No report implementation exists. Findings below are source-read unless explicitly marked as a probe. They constrain the contract; they are not a promise of a particular public API.

## Execution and reporting are not yet one transaction

`packages/platform-bun/src/host.ts` passes the same SQLite filename to the host store, lake and Effect engine. However, the host uses its own Bun SQLite connection and `engine.ts` supplies a separate Effect SqliteClient. Sharing a filename does not put engine activity completion and host writes in a single transaction.

`interpreter.ts` has a stable native workflow for a logical task invocation, keyed by run ID and invocation path. Its retry loop stores each handler attempt with `Activity.make`, and a native workflow result is returned only after success or a final non-retryable failure. `host_invocations` stores the native execution ID and payload before executing that workflow. It does not contain the task's final result or failure.

`run-outputs.ts` explicitly reads native Effect outcomes by polling those execution IDs. This provides a candidate recovery source for task reporting without re-running a successful task. It also distinguishes a still-pending/suspended logical invocation from a final failed attempt: a retryable attempt failure is not yet a completed logical task. The reporting contract must not infer completion from `AttemptStarted`/`RetryScheduled` events alone.

`host-store.ts` projects a root run's terminal status, result/error and RunStatus event in one local transaction. Projection returns early if the run is already terminal or already in the requested status. A reporting obligation added outside that transaction could be lost after a crash unless another durable record or reconciliation rule repairs the gap. An existing terminal row also will not naturally pass through the projection path again after restart.

The current runner reconciliation scans active runs. A proposed recovery scan that only follows that scan would miss report obligations discovered after a root becomes terminal. Any obligation ledger, work queue or reconciliation strategy must account for terminal sources explicitly and avoid scanning all historical runs on every tick.

## Task, linked workflow and skipped work are different sources

Task invocations are registered durably in `host_invocations`, bounded to 10,000 per root run. Their execution IDs are stable across restart. A task already completed before an approval can be inspected even though the root has not finished.

Linked child workflows currently execute their graph inside the root, sharing its run ID. They do not receive independent host run rows or native workflow execution IDs at that boundary. Therefore child-workflow reporting cannot simply reuse a hypothetical root-run completion hook. A skipped branch has no registered task invocation; absence of an invocation is not a stored task failure or completion.

These are implementation facts, not reasons to quietly omit nested or task-level reports. The public design must either establish the missing completion records or explicitly name the incremental boundary and remaining parity gap.

## Existing history pagination is not an immutable report snapshot

`inspection.ts` freezes the upper host-invocation row ID for an outputs page cursor. `run-outputs.ts` polls each task outcome when the page is read. Thus the cursor freezes the set of rows, not the value of every outcome while the run is executing. A pending outcome can become successful between reads at the same snapshot.

The page has a 2 MiB serialized budget and at most 200 items. Ordinary task boundary JSON is capped at 1 MiB (`core/src/json-budget.ts`), but unbounded nested invocation-path strings can add substantial envelope size. A report cannot safely assume every legal source fits in one page or one ordinary task input. Paging over sources is necessary; retaining a whole list in a service value merely moves the unbounded allocation.

The current helper also uses cursor expiry and operational errors intended for interactive inspection. A durable report should not persist an expiring cursor as its only way to resume source traversal. If report-source schemas/streams are introduced, define their snapshot and recovery semantics explicitly.

## Executed source recovery probe

On 2026-11-05, `/tmp/effectory-report-source-probe.ts` exercised the compiled macOS arm64 executable from the vault verification against a disposable repository. It submitted the existing greeting workflow, waited for its approval, read the preceding task output, killed the daemon with SIGKILL, restarted, then rejected the approval. The task output page was byte-for-byte equal as JSON before restart, after restart and after the root reached Rejected. The source remained `example/greet`, node `["greet"]`, status Succeeded, result `Hello ReportSourceProbe`; the parent changed from Waiting to Rejected. The probe exited 0 and removed its repository and processes. Output: `/tmp/effectory-report-source-probe.log`.

This proves the existing native task result is recoverable before root completion and remains inspectable after root rejection. It does not prove report obligation admission, report execution, exactly-once external effects, or a future report API. It used the existing example and no real secrets or remote providers.

### Cancellation probe

The separate `/tmp/effectory-report-interrupt-probe.ts` started a real task whose handler is `Effect.never`, waited for AttemptStarted, cancelled its root, inspected its output and killed/restarted the daemon. The root became Cancelled, but existing `run outputs` returned the task as Failed with the generic Defect message `Task execution failed unexpectedly`. That page survived restart unchanged. The probe exited 0 and removed its repository/processes; evidence is `/tmp/effectory-report-interrupt-probe.log`.

This exposes a limitation in the existing inspection mapping, not a report implementation failure. `run-outputs.ts` maps a failed native Exit without a typed ExecutionFailure to a generic defect; it does not distinguish an interrupt-only cause plus an explicit control fence. The report contract must use the native Exit/fence and test this case instead of deriving source status blindly from that presentation. The proposed contract includes making the existing inspection mapping consistent for cancellation/timeout, subject to API review and user approval.

## Swamp report failures have caller-specific effects

The executor in `vendor/swamp/src/domain/reports/report_execution_service.ts` collects failures and persists fallback error artifacts when it can. That does not imply all callers ignore failures:

- `vendor/swamp/src/libswamp/models/run.ts` accumulates method/model report failures and sets the final method-run view to `failed` when the count is positive, even after successful method execution.
- `vendor/swamp/src/presentation/renderers/model_method_run.ts` marks that final failed view as a failed run. `cli/commands/model_method_run.ts` sets exit code 1 when the renderer reports failure.
- `vendor/swamp/src/domain/workflows/workflow_report_runner.ts` ignores the returned failure count and catches report-loading/execution exceptions, warning so report failures cannot mask the workflow result.
- `vendor/swamp/src/domain/workflows/method_report_runner.ts` similarly awaits the reports for graph methods but does not consume their returned failure count. Its callers still need checking for exceptions thrown outside the executor's per-report catch.

A consistent Effectory rule that preserves source execution status would be a deliberate choice, especially for directly submitted tasks. It must be presented rather than claimed as exact Swamp behavior. Whether foreground commands await asynchronous reporting is another separate choice.

## Protection and retention constraints

New report execution must retain the vault tracker's host-owned lifetime through both report content serialization and final durable encoding. Merely calling a user Effect outside `Task.execute`/the interpreter protection would lose guards and task-local Layer behavior.

Existing source results were already checked at their original task boundaries, but source inputs and previously persisted arbitrary metadata are not newly proven secret-free by reading them. A reporter must not implicitly receive a raw credential store or promise retroactive scrubbing of data for secrets it never read. Its text/JSON outputs need the same explicit accidental-disclosure scope as other task outputs.

Lake reclamation is manual and currently protects unfinished producing runs. A future report that reads another run's artifacts introduces a cross-run consumer: that dependency is not protected by the existing rule. Metadata-only reporting can point at immutable references without promising that content remains available. If reports read artifact contents, reclamation and open-reader ownership must be addressed in that same public contract.

## Executed task-wrapper and Layer probe

The stand-in `/tmp/effectory-report-shape/proof.ts` constructs a real `Task.make` with null input and a schema for Markdown plus typed report data. It exposes only a scratch helper, not an SDK Report implementation. Its handler reads a scratch source service and a client Layer that also reads that source. It consumes a bounded sample through an ordinary Effect Stream.

On 2026-11-05 the probe typechecked under the repository's strict TypeScript settings, including exact optional properties and unused checks. Assertions establish that the literal report ID and a decoded literal-union field survive the wrapper; a wrong structured-data value is a compile error; after `.provide(clientLayer)` the remaining requirement is precisely the source service. The initial probe incorrectly read `Task.test`'s result as `.result`; the corrected code uses its actual `.value` field, and the final typecheck passed with no output.

Two real `Task.test` invocations then ran concurrently with different source values. A short Effect sleep forced their lifetimes to overlap. The recorded order was acquire one, acquire two, release one, release two, and each output and finalizer read its own source. The finalizers re-read the service rather than relying only on a captured string. Both outputs passed their real task schemas. Runtime and typecheck logs are `/tmp/effectory-report-shape/runtime.log` and `/tmp/effectory-report-shape/typecheck.log`.

This supports reusing task schema handling, Layer substitution, per-invocation memoization and testing for reporting. It does not establish application registration, extension inference, durable report admission or safe provisioning around the application's captured context. Those remain contract and implementation obligations.

## Automatic discovery does not automatically preserve requirements

Current `Application.make` computes its service requirements from explicitly registered task definitions, selected extension requirements and declared vault services. Its `workflows` parameter is an erased array of workflow definitions. Linked workflows are discovered later by building and walking graphs at runtime. A report discovered only during that walk cannot contribute a previously erased service type to the application's compile-time requirement union.

The design therefore must either retain the necessary report types through authoring/registration, or explicitly register report implementations and derive requirements there, as tasks already do. A promise of automatic discovery is insufficient on its own. This is a source/type-boundary finding, not an adopted public signature.

## Existing-client response decoding probe

On 2026-11-05, `/tmp/effectory-report-shape/compat.ts` used the real current Run, RunPage and RunWatchFrame schemas as the old client. A stand-in server extended their replies with a proposed report provenance object while retaining `kind: "task"`. The probe used real Effect RpcServer/RpcClient instances over a Bun loopback socket, once with JSON serialization and once with NDJSON. For both transports, RunGet, RunList and a finite RunWatch stream decoded successfully and ignored the unknown provenance field. A negative control changing the run kind to `report` failed the old decoder as expected. The final strict typecheck and runtime process exited 0. Logs: `/tmp/effectory-report-shape/compat-typecheck.log` and `/tmp/effectory-report-shape/compat-runtime.log`.

This verifies response schema/transport compatibility for the additive field, not new request flags, a released old executable, infinite-stream liveness or a future report implementation. The stand-in has no authentication layer; it tests the response decoding path specifically. Its first typecheck rejected passing HttpEffect's web handler directly as Bun's two-argument fetch callback; the final probe uses a one-argument adapter, matching the repository's existing server tests.

The source check also corrected a factual mistake in the consolidated draft: SystemHello already exists, and both Hello and Status use the shared capability list. `connect()` performs the identity handshake; current feature commands obtain capabilities through SystemStatus. No new client capability-negotiation mechanism is required. Only that factual sentence was corrected while revision 1 was under review; the proposed behavior is unchanged.

## Attachment compatibility probe

On 2026-11-06, `/tmp/effectory-report-shape/attachments.ts` checked stand-in source/result schema helpers and an attachment signature against real Task and Workflow definitions under the repository's strict TypeScript configuration. A target-specific reporter attached to its target, and a generic reporter attached to both another task and a workflow. Expected compile errors rejected a mismatched target, invocation scope on a workflow, a success schema without the report shape, and a retry tag absent from the reporter's error schema. Type assertions retained the target's literal ID and version. Runtime decoding rejected a different target, and the generated JSON Schema retained the narrowed identity fields.

The final typecheck and runtime exited 0. The typecheck emitted only an Effect language-service suggestion to use TaggedStruct for a scratch tagged schema. Logs are `/tmp/effectory-report-shape/attachments-typecheck.log` and `/tmp/effectory-report-shape/attachments-runtime.log`. This proves feasibility of the modeled signatures, not an implemented Report API, canonical registration, extension facade preservation, or host-service requirement exclusion.

## Consumer-review source corrections

The round-2 consumer review correctly identifies missing cancellation precedence and a poor nonterminal-source wait rule. Two refinements are needed when consolidating its suggestions:

- `stopForeground` in `packages/cli/src/observation.ts` stops at NeedsAttention, or Waiting with an open external wait. Waiting alone is not actionable: durable timers and retries use it too, and the status can remain Waiting after a timer. Report waiting must reuse the actual predicate rather than the review's shorthand of stopping on every Waiting status.
- `RunOutput.status` has no NotApplicable variant. A report can be NotApplicable because its source never admitted an attempt without adding that status to existing output inspection. Normalize the source outcome separately from deciding whether a report applies.
- A genuine leaf timeout must not become cancellation merely because a different fence is recorded later. `interpreter.ts` produces a typed Control/TimedOut result for its own deadline; synthetic dispatch refusal produces Control/Cancelled for any existing fence. Those cases need separate precedence rules. A deadline can also expire at admission before any `host_attempts` row exists, so zero attempts alone must not erase a genuine timeout from output inspection.

Those initial observations came from source inspection. The following additional runtime probe tests several of them; the proposed consolidated mapping still needs the complete crash/cancellation tests listed in the draft.

## Native outcome and fence matrix

On 2026-11-06, `/tmp/effectory-report-shape/outcomes.ts` exercised the current real HostStore, Runner, workflow interpreter, native Effect workflow engine and RunOutputs in six disposable stores. It inspected native completion, the recorded fence and admitted-attempt rows after root termination. These are existing runtime components, not a modeled report implementation.

| Trigger | Root status | Long task's native result | Fence | Attempt rows | Current RunOutputs |
| --- | --- | --- | --- | --- | --- |
| Operator cancel after acquisition | Cancelled | Interrupt-only | Control/Cancelled | 1 | Failed/Defect |
| Reject parallel approval | Rejected | Interrupt-only | Control/Rejected | 1 | Failed/Defect |
| Expire parallel approval | TimedOut | Interrupt-only | Control/TimedOut | 1 | Failed/Defect |
| Parallel task raises ProbeFailed | Failed | Interrupt-only | Domain/ProbeFailed | 1 | Failed/Defect |
| Long task's own 50 ms attempt timeout | TimedOut | Typed Control/TimedOut | Control/TimedOut, with deadline and node | 1 | TimedOut/Control |
| Cancel after registration, with all global permits held | Cancelled | Interrupt-only | Control/Cancelled | 0 | Failed/Defect |

The sibling-failure case separately retained the failing task's own typed Domain/ProbeFailed result. Every acquired long-task resource finalized before the root became terminal. The permit-held task never acquired its resource and had no attempt row, but its registered native workflow still reached Complete. The probe asserted these lifecycle facts and expected root statuses. It released its held permits and removed every temporary store.

This establishes why native completion plus fence provenance is necessary, and why attempt presence is a separate reporting-eligibility check. It does not validate the proposed normalization implementation, which does not exist. It also does not establish the synthetic typed dispatch-refusal case, a deadline before first admission, self-interruption, concurrent competing fences, restart of these six cases, or report obligation recovery. Earlier separate CLI probes cover only the restart cases they name.

Runtime output is `/tmp/effectory-report-shape/outcomes-runtime.log`; the six-case process exited 0. The probe's strict typecheck uses `/tmp/effectory-report-shape/tsconfig.outcomes.json`, with output in `outcomes-typecheck.log`. The source is outside the checkout; no production files changed.

## Installed extension contract path

Source inspection on 2026-11-06 establishes the following existing behavior:

1. `extension-bindings.ts` generates a direct import of the extension's contracts entry and a lazy import of its implementation. It does not regenerate task schemas from JSON Schema.
2. `Extension.installed` keeps those imported contracts; `Extension.load` requires each exported task's implementation to use the exact same `spec` object as its contract. Equivalent serialized schemas do not satisfy this check.
3. `Task.contract` keeps `spec.input`, `spec.success` and `spec.error` as the actual schema objects. `Application.make` spreads each resolved task into its runtime registry and wraps execution without replacing those schemas or its spec.
4. The disposable extension validator checks contributions against the manifest and checks that task fields are schemas. It does not know whether a future source/result pair is a valid report; that remains attachment validation during Application registry construction.
5. Both application bundles and installed extension code must resolve the future Report export and any private provenance registry through the existing host-shared SDK module mechanism. The generated loader currently has no Report export because the API does not exist yet. Adding the package export and regenerating loaders is an implementation requirement, not something this evidence has already verified.

The existing targeted integration test `a generated facade preserves emitted types, exposes canonical services and loads implementations only on inclusion` passed on the current checkout: one test, 13 assertions, zero failures. Command: `bun test packages/platform-bun/test/extension-bindings.test.ts --test-name-pattern 'a generated facade preserves emitted types'`. Log: `/tmp/effectory-report-shape/extension-baseline.log`.

That test publishes the fixture archive, installs it into the verified cache, generates and typechecks consumer bindings, verifies lazy loading, loads an application revision, executes the extension task, prepares and activates another revision, retains the old revision, and rejects mismatched manifest contributions. It supports the existing contract/import path only. It contains no Report helpers, report attachments, report-specific private markers or report source history. Those remain required implementation tests, including a target-specific contract used by both publisher and consumer, a generic extension reporter, the new SDK subpath, and intentionally duplicated SDK provenance.

For authoring, the implication is to declare the reporting task contract once in the extension's contracts module and implement `Task.make(Contract.spec, handler)` in its implementation module. Reconstructing an equivalent task spec separately already fails installation's canonical-contract check. A source-specific helper must key its target association by the canonical task spec, not by the wrapper object returned by `.provide` or `Task.make`; those wrappers can differ while the contract remains identical.
