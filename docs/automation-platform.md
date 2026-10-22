# Offline Effect automation runtime

Effectory executes reusable typed operations and workflows on the user's machine. Its execution engine, definitions, run journal, outputs, approvals, and secrets must work without a Effectory account, hosted service, or extension registry. Setup may fetch dependencies; an operation may explicitly call an external system. Neither is a mandatory network dependency of the runtime.

See [Swamp workflows and an offline Effect runtime](research/swamp-effect-workflows.md) for the capability comparison, authoring API recommendations, approval semantics, and open decisions behind this direction.

## Current implementation

The offline MVP is implemented by `@effectory/runtime`, with a thin `@effectory/cli` interface and the `@effectory/sdk` authoring API. `packages/runtime/` contains task discovery, source fingerprinting, a SingleRunner/ClusterWorkflowEngine host with `@effect/sql-sqlite-bun@4.0.5`, run admission and inspection, bounded JSON artifacts, durable approval requests/decisions, and the private Unix-socket control boundary. `.effectory/automations/health-check` and `.effectory/automations/approved-health-check` demonstrate native Effect authoring and review before an idempotent local file action. The process-level tests exercise restart, rejection, cancellation, and changed-source activation.

`start` and `init` initialize the workspace. `workflow`, `run`, `artifact`, and `approval` open local runtime sessions automatically. `workflow run` and `run resume` execute in the foreground; approval records a decision separately from explicit resumption. `serve` is optional hosting for integrations. The root scripts invoke the packaged CLI directly.

Task inputs and artifacts are finite, bounded JSON. Successful run results are encoded through the native success schema's JSON codec before entering the operational index. A run may carry an explicit `inspectionError` if its native outcome cannot be decoded or its wire result exceeds the index bound. An unreadable outcome retains the last known status and retries inspection on reopen; confirmed native success remains success even when its result cannot be included. This isolates problematic outcomes without inventing terminal failures. The native engine owns execution; application SQL records admission obligations, operational history, named artifacts, approval decisions, and delivery state. Decision release, delivery, and submission reconciliation close persistent crash gaps. Activity outcomes can be reused after process death; interrupted external effects still require idempotency or reconciliation.

The first host targets macOS/Linux with a private Unix socket, a PID/start-time ownership identity, and nonce-scoped cleanup. It supports one process per workspace. Task import/fingerprint rules are intentionally bounded; see the README for the supported authoring boundary. No historical executable bundle archive is provided: changed code needed by unfinished work is refused until its original revision is restored.

## Operation and workflow model

An operation type is reusable implementation with input/output Schema contracts and typed failures. A configured instance supplies nonsecret configuration for a target. A run records the exact definition, implementation identity, inputs, attempts, outcomes, and produced artifacts. The health-check demo uses SDK activities, and task revisions fingerprint the supported source graph and dependency metadata.

Operations are ordinary Effect programs. Context services name their capabilities; Layers select implementations. Workflow authors use `Effect.gen`, typed values, bounded concurrency, error handling, and scopes. Configuration and persisted state are data. There is no separate YAML execution language, expression evaluator, or custom dependency injection container.

Use Effect primitives where their semantics fit. Fibers and scopes own live work. Stream handles incremental output and artifact content. Queue and PubSub handle bounded, in-process delivery. Ref coordinates live state. Schedule expresses retry policy. Schema defines storage and execution boundaries. None of the in-memory primitives becomes a durable journal merely by being wrapped in a service.

## Durable execution ownership

Effect Workflow is the intended execution abstraction, with named Activity boundaries for persisted outcomes and durable wait points for approvals or external input. Verify the engine/storage adapters against the pinned Effect version before choosing an implementation. A persistent local engine must pass restart tests; an in-memory engine does not meet the requirement.

One local workflow engine owns execution progress, retries, suspension, resumption, and cancellation. Keep business decisions and execution transitions explicit, but persist them through the selected local execution model. The selected MVP direction is ClusterWorkflowEngine with SingleRunner and local SQL storage. SingleRunner hosts cluster work in one process; remote runners and distributed placement remain later features. Adapter compatibility and restart behavior must pass the first implementation spike.

SQLite is the intended home for run metadata, journal entries, and decisions. Store larger immutable artifact payloads as files addressed by digest. The MVP uses `@effect/sql-sqlite-bun@4.0.5`. Small artifacts are stored as JSON in SQLite; larger file/blob storage remains future work.

The first durability spike must check how engine-owned activities and application-owned artifacts commit. Write content completely before committing a reference to it. Reconcile orphaned blobs after crashes. Never expose a successful outcome whose required artifact is missing. Persisted outputs need schema versions and implementation identities; editing a workflow must not silently change a suspended run.

## Runtime capabilities

Define services as real consumers arrive, rather than introducing empty abstractions for every module.

- Operation catalog: discover explicitly installed implementations and their Schema contracts.
- Artifact store: publish immutable outputs and inspect provenance across runs.
- Secret store: resolve a reference immediately before an authorized operation executes. Start with a local provider; keep values out of definitions and run journals.
- Process execution: spawn local tools with structured arguments, scopes, cancellation, and bounded output handling.
- Execution engine: admit, execute, inspect, interrupt, and resume pinned workflows.
- Approval store: accept durable decisions bound to the exact inputs reviewed.

Filesystem, HTTP, process, clock, and crypto services should use the Effect platform implementations already available. Tests replace capabilities through Layers. Production uses the Bun host. The CLI and any future loopback UI call the same runtime services, so closing a UI is not an execution policy.

## Failure and recovery semantics

Durable execution does not make an external side effect exactly once. A process can die after a remote service accepts work and before its result is recorded. Use stable external idempotency keys where supported. For unsafe operations with ambiguous outcomes, record that uncertainty and reconcile before retrying. Cancellation stops further work; compensation requires explicit operations.

An approval binds to a run, step, implementation revision, and input digest. Persist approval, rejection, expiry, and cancellation decisions. Handle duplicate and early decisions, and let an authorized local command resolve races atomically. Waiting must release process capacity and survive restart; an ordinary Deferred is insufficient.

Start with a single journal owner per workspace. A second owner must be rejected or coordinated by the selected storage/engine adapter. Introduce cross-process leases only when their recovery semantics can be tested. Bounded parallelism inside one run does not require a distributed worker fleet.

## Offline boundary and extension trust

No login, telemetry, update check, registry lookup, package install, or hosted entitlement check belongs in the default execution path. Installed dependencies and extensions must remain usable with the network unavailable. Explicit extension installation may require network access and must pin its resolved implementation. Runtime discovery inspects installed code rather than reaching a registry.

Operations can use external systems when configured to do so. Offline operation means Effectory itself has no required network dependency; it does not promise that a configured cloud operation succeeds without that cloud. HTTP examples use a loopback fixture so the first workflow can be exercised without internet access.

Initially execute only trusted, explicitly installed code. Schema validation is not isolation. Secret redaction reduces accidental display but does not constrain arbitrary extension code. Process isolation and restricted workers are separate future capabilities.

## MVP primitives

MVP scope recorded 2026-10-21. The seven primitives below are now implemented; the increments and acceptance checks remain a reference for the intended behavior and regression coverage.

The MVP lets a user define an automation under `.effectory/automations/<name>/`, submit typed inputs, inspect persisted results, restart the runner without losing committed progress, and approve or reject one durable gate. Build this in three increments so the ungated runner is useful before approval is finished.

| Primitive | Meaning | Minimum implementation | Current state |
| --- | --- | --- | --- |
| Operation | Reusable work | Ordinary Effect program with Schema input/output and typed failures. Reuse platform services through Layers. | Implemented. |
| Activity | Persisted execution boundary | Native named Activity around nondeterministic work. Use stable identities and read-only or idempotent operations in the first tasks. | Integrated. |
| Workflow | Typed orchestration | Native Workflow with payload/result/error schemas, explicit idempotency key, bounded parallelism, and typed result flow. | Integrated. |
| Task | Discoverable automation | Trusted `.effectory/automations/<name>/index.ts` manifest exporting description, Workflow, and implementation Layer. Derive invocation schemas from Workflow. | Implemented. |
| Run | One workflow invocation | Execution ID, task revision, accepted payload, request key, timing, and inspectable outcome. WorkflowEngine owns execution state; the application index is an operational view. | Implemented. |
| Artifact | Named output of a run | Small schema-validated JSON outputs, immutable identity, provenance, list/get by run. Publish idempotently so replay cannot duplicate an output. | Implemented for bounded JSON. |
| Approval | Persisted operator decision | One named gate, review content/digest, approve/reject/reason, pending list, and durable continuation. | Implemented. |

Schema, Context, Layer, Scope, and concurrency combinators support these primitives. They do not need new Effectory equivalents. The CLI is an interface over this model, not another execution engine.

### Runner and storage

An executing CLI command owns the workspace's engine and persistence until completion, cancellation, or an approval pause. Inspection and approval commands use a session without activating workflow execution or importing task implementations. Optional `effectory serve` hosting can own the engine for integrations. It hosts registered workflows through ClusterWorkflowEngine and SingleRunner, backed by a compatible local SQLite adapter. Other CLI invocations communicate through a private local control boundary; they do not open another SingleRunner on the same database. The control transport is a mode-0600 Unix socket at `.effectory/state/control.sock`. It is separate from engine-owned message storage. A second runner must fail clearly, including after a crash leaves ownership metadata behind.

Engine-owned tables store the journal. Application-owned tables index runs, artifacts, and approvals. The index must reconcile from authoritative engine outcomes after a crash; it must not independently schedule work or invent terminal outcomes. Admission must also be idempotent: a crash between accepting a request and submitting it cannot lose it or create a second execution on retry.

Keep the first artifact format small: bounded JSON stored transactionally in SQLite is sufficient. Blob storage, checksums for large files, retention policies, and cross-run query languages can follow actual use. Define schema versions and reject oversized output explicitly.

Capture accepted inputs and task implementation identity before execution. The first version refuses to activate a changed task while an unfinished execution needs the earlier revision. It does not need to retain or execute arbitrary historical code automatically. The implementation fingerprint must cover the supported source/import set and dependency lock, not just a hand-edited version label; settle the supported import boundary in the first increment.

### Proposed CLI contract

These commands are implemented and start their local runtime automatically:

```sh
effectory workflow list
effectory workflow describe health-check
effectory workflow run health-check --input .effectory/automations/health-check/inputs.json
effectory run list
effectory run inspect <run-id>
effectory run resume <run-id>
effectory run cancel <run-id>
effectory artifact list --run <run-id>
effectory artifact get <artifact-id>
effectory approval list
effectory approval inspect <approval-id>
effectory approval approve <approval-id>
effectory approval reject <approval-id> --reason "Revise the plan"
```

`workflow run` prints its run record after completion, failure, cancellation, or a durable approval pause. Failed and cancelled executions exit nonzero. Generate a request key once per invocation; permit an explicit key for callers retrying an uncertain submission. A new request key means a new run. Reusing a key with changed payload or task revision fails instead of silently joining different work. Status inspection remains available between invocations without activating workflows. After a crash, `run resume` recovers unfinished work; no background executor is required.

Ctrl+C and SIGTERM during foreground execution request cancellation and wait for cooperative interruption. A hard crash preserves unfinished work for a later `run resume`. Explicit `run cancel` also requests cancellation. Distinguish cancellation requested from confirmed interruption, and let the engine determine the final outcome of cancellation/completion races.

### Approval policy for the MVP

Approval records the reviewed decision without completing the DurableDeferred. Explicit `run resume` refuses pending gates, durably releases decided gates, and then delivers their deferred outcomes. Persisting release separately from delivery recovers crashes during resume without letting approval or inspection execute downstream work. Rejection marks the run failed and prevents its downstream action. Cancelling a waiting run prevents a later approval from authorizing that action.

Persist the request before awaiting its decision. Use stable gate identity and an idempotent outbox/reconciliation path so a crash between recording a decision and completing the deferred cannot lose the wakeup. Validate the exact reviewed digest and task revision when accepting a decision. Repeated identical decisions are harmless; conflicting decisions fail. The initial gate waits indefinitely; timed expiry and escalation come later.

Use a deliberate local review/confirmation flow and record the local operator context. The MVP assumes trusted code and a trusted local OS user. It does not enforce separation between humans and agents with identical OS privileges. Multi-user authorization and a stronger human-controlled approval channel are later work, not an implied guarantee of the command name.

## Implementation increments

### 1. Prove the local engine

Wire a file-backed SQLite adapter, SingleRunner, and ClusterWorkflowEngine using the pinned Effect version. Use one statically registered workflow with two named activities before extracting task discovery or application SDK abstractions.

The implementation uses Effect 4.0.5 and `@effect/sql-sqlite-bun@4.0.5`. Native SQL message storage persists work; memory runner storage is safe only because Effectory enforces one workspace owner. Process tests cover SIGKILL, graceful shutdown, committed activity reuse, and source-revision activation checks. The implementation fingerprint includes statically imported local source and dependency/configuration inputs; installed dependency contents must match the lockfile.

Acceptance:

- A workflow completes, and its result remains inspectable after process restart.
- Terminate the process after the first activity's outcome is committed. Restart and verify that activity is reused while the remaining activity completes.
- A second runner cannot take the same workspace concurrently; a crashed runner does not permanently strand it.
- The test uses local operations only and needs no account, registry, or outbound internet.

### 2. Deliver the usable task runner

Discover trusted automation directories, validate payloads, and implement task submission plus run list/inspect/cancel. Integrate minimal artifact publication and restart reconciliation. Do not invent an operation registry or a generic Task wrapper unless these consumers need one.

The first automation checks three loopback endpoints concurrently and returns a summary. It publishes named observations and a summary as small JSON artifacts. Unhealthy endpoints remain observations; use an ordinary typed policy if a task should fail on them.

Acceptance:

- Task discovery and describe expose the payload schema; malformed input fails before admission.
- Two new request keys create independent executions and outputs. Repeating a key joins its original execution; a changed payload with that key is refused.
- The concurrency bound holds, completed activities survive restart, and cancellation prevents pending work from starting.
- Fault injection around admission, engine completion, artifact publication, and index updates does not lose accepted work or expose missing successful outputs.
- Changing a task implementation cannot silently alter an unfinished run.

### 3. Complete the MVP with approval

Add Approval request/list/inspect/approve/reject and native durable waiting. Extend the demo to prepare a local action plan, persist it, wait for review, and publish an approved result to a run-specific file through an idempotent activity. A repeated write with the same digest succeeds; conflicting content is refused. This exercises recovery without an unsafe remote mutation.

Acceptance:

- Reach the gate, stop the runner, restart, inspect the same plan, approve, and complete without re-running committed checks.
- Rejection and cancellation each prevent the action. Duplicate decisions do not repeat it; conflicting or stale decisions fail.
- A crash after recording approval but before signaling the workflow is recovered without losing the decision or wakeup.
- A crash after the local action but before recording completion reconciles the file rather than producing a second action.

These three increments define the delivered MVP. Test coverage lives in `packages/runtime/test/engine.test.ts`, `packages/runtime/test/tasks.test.ts`, and `packages/cli/test/cli.test.ts`; update this document if the implementation or its guarantees change.

## After the MVP

Iterate from actual automations. Add secret resolution and a useful process operation when the first task needs them. Add a Check/Report SDK when repeated assertion/report policy emerges. Keep ordinary Effect composition available throughout.

Defer schedules, webhooks, remote workers, capability-aware placement, registries, automatic dependency installation, browser UI, agent launch, blob retention/GC, a general artifact query language, a pre-run DAG, and selective reruns from an arbitrary named step. Unsafe external actions require explicit idempotency or unknown-outcome reconciliation before they are supported.

Authoring uses the deliberate `Task.make` and `Automation.define` API from `@effectory/sdk`, backed by native Effect Workflow and Activity. See [the authoring contract](authoring.md). Installed code is trusted. A complete workflow graph and a separate declarative execution language are not MVP requirements.

## Effect references for this scope

- [Workflow](https://effect.website/docs/v4/api/effect/workflow/Workflow): typed definitions, registration, execution, polling, resumption, and interruption.
- [SingleRunner](https://effect.website/docs/v4/api/effect/cluster/SingleRunner): single-process hosting with SQL-backed message persistence.
- [ClusterWorkflowEngine](https://effect.website/docs/v4/api/effect/cluster/ClusterWorkflowEngine): persistent workflow coordination on cluster entities.
- [DurableDeferred](https://effect.website/docs/v4/api/effect/workflow/DurableDeferred): persisted external decisions and workflow waits.

These APIs remain unstable in the pinned version. Source availability establishes the intended building blocks; the first increment establishes the recovery behavior we can actually promise.
