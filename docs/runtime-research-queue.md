# Runtime research queue

Current priority (2026-11-07): [V1 runtime correctness, upgrades and agent setup](runtime-v1-plan.md). The user redirected the goal away from broad Swamp parity, deferred further extensions until needed, and required harness/skill setup for V1. UI concepts are deferred. Start with upgrade compatibility, runtime correctness and revision lifecycle; the older entries below are evidence/history, not an instruction to continue provider expansion.

Upgrade progress: [real host-layer subprocess probes](runtime-upgrade-research.md) reproduce incompatible-ABI refusal, show that project upgrade does not resolve it, and preserve a waiting workflow plus completed manual activity through refusal and original-host restart. Controlled ABI constants simulate different builds; actual release compatibility remains unproved. The [upgrade policy and command contract](runtime-upgrade-api-draft.md) is approved for implementation. Startup inspection and scoped revision ownership are implemented; certified transitions and offline upgrade commands remain in progress. Exact-build legacy admission still applies.

Agent setup: [source research and acceptance requirements](agent-setup-research.md) separate project instructions, discoverable skills, update ownership and optional harness launch. The user selected Codex and Claude Code and approved project-local setup/status/remove, which are implemented. Live harness discovery and model authoring remain separate quality gates; UI is deferred.

Design constraint from the user: heavily reuse Effect primitives. Treat Context, Layer and Scope as first-class design tools, rather than assuming capabilities must be passed through a handler context parameter. Research must inform both consumer APIs and runtime ownership. Public API changes still require the existing Claude Effect/consumer review and user discussion.

## Completed slice: live watch transport buffering

The binary-artifact Effect review identified that pinned Effect 4.0.5's unframed JSON HTTP RPC collects the server response queue and reads the full response text on the client. Current daemon/client use that transport for `RunWatch`. A real CLI probe on 2026-11-05 started the greeting workflow in the background, waited for its durable approval, then ran `run watch --jsonl`: no snapshot or event arrived within 6.5 seconds, and the watch process was still running. Source confirms this is response buffering, rather than evidence that the store lacks events. The scratch probe stopped its own processes and removed its temporary repository.

The next proposal is [live run observation](live-run-watch-api-draft.md), approved by the user after separate Claude Effect and consumer reviews and now implemented and verified. No watch transport code is changed by the binary artifact implementation.

This is an existing correctness gap; prior stream unit tests and completed-run CLI tests do not establish live delivery through HTTP. Track a separate fix with a backward-compatible transport contract; do not silently change `/rpc` framing for old clients as part of binary artifacts. Required proof: receive the initial snapshot and an intermediate event while the run remains waiting, then cancel/disconnect and observe release of the observer and response-lifetime permits. Include slow-reader backpressure and bounded parser buffers. Scratch evidence: `/tmp/effectory-watch-stream-probe.mts`; reviewer evidence: [binary Effect review](binary-artifacts-review-effect-round1.md).

## Next: Scope, Layers and runtime dependency injection

The [original ownership audit](runtime-ownership-audit.md) traced eager retained-Layer ownership. The approved upgrade work now uses [scoped revision ownership](runtime-upgrade-implementation.md#scoped-revision-ownership), with an active pin and per-operation/native-execution borrowers. Inactive bundles remain stored without holding their Layers open. A real-daemon retry/approval/restart test also confirms per-attempt acquisition, cleanup before durable suspension, and reuse of completed activities without reacquiring their Layers.

The user has now explicitly requested `yield* ArtifactStorage` for publication too. Treat invocation capabilities as Effect services by default; preserve task-specific typing through explicit schema/spec arguments and state runtime membership checks honestly. Do not use lost ambient output-name inference as a reason to revert to handler-context capabilities. See [ArtifactStorage DI review proposal](artifact-storage-di-proposal.md).

ArtifactStorage implementation evidence: a successful-acquisition `Layer.tap` alone does not cover a Layer that publishes, acquires another resource, and then fails. The implementation now builds task-local Layers with the invocation MemoMap explicitly and decorates leaf acquisition exits to close publications before failure unwinds resources. Effect.provide forks the ambient memo map, so merely decorating CurrentMemoMap was insufficient. Tests pin partial and parallel acquisition failure, memo sharing, and caller interruption. See [the implemented JSON contract](artifact-storage.md). Custom manually nested resource scopes remain author-owned.

Further lifecycle research reproduced a nested-scope self-wait through real ArtifactStorage: a binary source publishing JSON during task Layer acquisition could close its own enclosing invocation. The [private correction](invocation-nested-scope-fix.md) distinguishes active operation ancestry in both Scope registration and Layer acquisition. Focused SDK and real-daemon regressions pass. Full verification passed typecheck, formatting/lint and all 466 tests across 120 files, with 3,795 assertions and zero failures. This changes no public API and does not approve the Checks proposal.

Requested by the user while discussing `yield* Team.value()` as an alternative to `context.readTag(Team)`. The tag reader now uses the approved `Tag.value()` DI API. Its implementation established per-invocation snapshots, a fresh Layer memo map, preserved non-tag requirements, and task-local acquisition/finalization. Continue the broader lifetime research below; these findings do not settle background work, waiting workflows or durable cleanup.

Questions to resolve against the pinned Effect implementation and this runtime:

- **Ownership and lifetimes:** distinguish daemon, loaded application revision, workflow run, task attempt and individual operation lifetimes. Which service instances and resources belong to each? Which lifetimes actually require an Effect Scope? A durable run's logical lifetime is not automatically one continuously live process Scope.
- **Layer construction and sharing:** when are application and extension Layers built, memoized, shared and released? How do provider overrides interact with run-specific services? Prevent request metadata from being captured into a long-lived shared Layer or leaking between concurrent runs.
- **Task service provisioning:** how can a reusable Effect such as Team.value access run metadata through a required Context.Service? Specify who provides it in execution and Task.test, preserve inferred service requirements, and distinguish runner-owned services from application-supplied dependencies. Avoid fallback services that hide missing provisioning.
- **Retries and interruption:** which acquisitions repeat per attempt, which are shared intentionally, and when do finalizers run on failure, cancellation, timeout and daemon drain? Test that one attempt's cleanup does not release resources another attempt/run still owns.
- **Background work:** explicitly own scheduler, worker and child fibers; inspect scoped forking and supervision. Work admitted by a short-lived CLI/RPC request must have an appropriate daemon owner after that request ends. Do not detach fibers merely to make them outlive a scope.
- **Durability and restart:** identify what is persisted and what must be reacquired after process restart. Scope finalizers cannot be assumed to run after a crash, and neither Scope nor Layer itself supplies durable cleanup or replay semantics.
- **Waiting workflows:** decide whether resources should remain acquired while a workflow waits for approval, input, a timer or a signal. Research suspend/reacquire behavior and revision retention without assuming every paused run retains live resources.
- **Extensions and revisions:** establish service identity across host-shared modules, resource lifetime for pinned revisions, and cleanup when a revision can be retired. Test app/extension provider composition and duplicated-module failure behavior.
- **Testing and ergonomics:** demonstrate real Layer substitution, concurrent run isolation, acquisition/release counts and typed requirements. Keep consumer code ordinary Effect; introduce wrappers only for domain capabilities or durability contracts that existing primitives do not express.

Expected output: a source-backed ownership/lifetime design, small executable feasibility probes, concrete public API examples, and focused Claude critiques from Effect and consumer perspectives before approval. Do not infer that this research request authorizes broad API migrations or replaces the ongoing Swamp-parity goal.

## Recurring design checkpoint

For each runtime capability, state who owns its service and resources, which Layer provides it, how its Scope ends, how retries/restarts affect it, and how it is supplied in tests. Explain deliberate choices where a plain value or explicit parameter is simpler; not every value needs its own service or Layer.

## Run status after timer/backoff wake

New evidence and fix (2026-11-07): [real persistent-runtime probes](runtime-status-research.md) show Waiting with one active handler after both sleep and retry; root polling differs between those cases. A related stale-projection race now checks durable stop fences transactionally, preserving cancellation and stalled-finalization status. The broader wake/foreground behavior was approved and implemented; see [verification](runtime-wake-status-evidence.md).

Verification follow-up: the full suite passed 517 tests and hit two existing lake-query timing failures; both affected files passed unchanged in isolation. Preserve the production budget and investigate timing sensitivity separately if it recurs. The exact results and source-state audit are in the status research record.

The live-watch consumer review found that the runner projects Suspended to Waiting, while only initial dispatch and settling an external wait project Running. Timer/retry wake therefore leaves Waiting visible during later execution. SignalRegistration also creates an Open wait before its AwaitSignal node. Current status plus WaitList cannot prove that all work is blocked on an outside action. Track a separate projection fix and, if needed, an explicitly designed durable awaited-wait distinction; do not change public statuses or wait/event schemas under the live-watch transport correction. Evidence: [consumer round 2](live-run-watch-review-consumer-round2.md).

## Approved slice: human-readable live execution display

Swamp's foreground workflow command renders execution events as they arrive (`vendor/swamp/src/cli/commands/workflow_run.ts`, `consumeStream`). The [console contract](live-console-api-draft.md) passed both Claude reviews and received user approval; implementation and full verification are complete. Foreground commands and plain watch display progress on stderr, with fixed-barrier history draining, machine-mode suppression and graceful display degradation on a broken sink. See [verification](implementation-status.md#human-readable-live-console). The separately approved wake correction is recorded above; it adds no awaited-wait marker.

## Vault ownership integration

The user-approved vault slice uses typed per-vault services and ordinary Layers. Private build/invocation References keep attempt tracking out of public task contexts. A host-owned handle refuses fresh untracked roots; the tracker remains owned through the Activity's final encoding. Local provider setup is lazy, so key/database state is an operation-time failure. See [vaults](vaults.md). Remaining parity work includes remote writes, field-level sensitivity, refresh hooks, audit history, provider adapters, migration and access policies; none is silently authorized by this slice.

## Completed slice: post-run reports

The user-approved report slice is implemented and verified. It uses ordinary tasks, explicit attachments and an injected History service, with durable report runs and CLI/RPC administration. See the [implementation proof record](run-reports-implementation.md). Child-workflow boundary reports, configured-model defaults and automatic report retention remain gaps in the full parity goal.

## Current parity design: artifact reads inside tasks and reports

Swamp can read stored resources during execution. The [reader proposal](artifact-reads-api-draft.md) was approved on 2026-11-06 and is implemented: a separate yielded ArtifactReader, typed reads, queries, fixtures, durable consumer/report protection and shared binary read/write admission. Focused storage, lifecycle, real-runner and SIGKILL/restart tests pass. The stable full suite passes 383 tests with 2,902 assertions, alongside typecheck and formatting/lint; see [reader usage](artifact-reads.md) and [implementation evidence](artifact-reads-implementation.md).

Independent internal work has improved existing lake query candidate selection without changing its public grammar. Exact run/task/artifact and conjunctive tag filters are tested against 100,000 unrelated records, while latest-before-filter and snapshot semantics remain covered. The full 356-test suite, typecheck and formatting/lint passed. See [evidence](artifact-reads-evidence.md#existing-query-optimization--implemented-independently). Those earlier results concern query optimization; the reader implementation has separate ownership and retention tests.

## Approved slice: manual recovery

The user approved the reviewed manual recovery contract on 2026-11-06. The implementation uses durable per-attempt uncertainty, one-entry authorizations and sequenced continuation obligations; native Effect workflows still own execution results and suspension. Scope-owned entry reservations include task-local Layer cleanup. The real-interpreter SIGKILL proof, real CLI recovery, six-report restart/retention/Vault proof and 10,000-invocation storage probe pass. Typecheck, formatting/lint and the full 398-test suite pass; results are recorded in [implementation evidence](manual-recovery-implementation.md). See [operator usage](manual-recovery.md). External action reconciliation remains the author's responsibility; this adds neither result injection nor automatic cross-host ABI migration.

## Cross-run report search

The approved search slice is implemented with metadata-only pages, ordered indexes, bounded partial pagination and startup catch-up. See the [operator guide](report-search.md) and [implementation evidence](report-search-implementation.md). Verification on 2026-11-06 passed typecheck, formatting/lint and all **409 tests across 110 files, 3461 assertions**, with zero failures (627.46 seconds).

## Report selection at admission

The user-approved [selection contract](report-selection-api-draft.md) is implemented and verified (425 tests, zero failures). It reuses typed classification tags, captures choices for manual and scheduled runs, preserves required attachments, and records exclusions without creating report obligations. See the [operator guide](report-selection.md) and [verification evidence](report-selection-implementation.md). Child-workflow boundary reports were subsequently implemented below; report retention remains a separate parity gap.

## Workflow invocation reports — approved and implemented

The user approved the [contract](workflow-invocation-reports-api-draft.md) on 2026-11-06, including child-subtree History, direct-root consistency and source-workflow search. Implementation uses native child deferred results and separate durable controller entry facts. See [usage](workflow-invocation-reports.md) and the [implementation verification record](workflow-invocation-reports-implementation.md). Full verification passed: typecheck, lint/formatting, and 442 tests across 116 files.

## Automatic artifact retention — approved and implemented

The user approved default-off automatic policy collection. The [contract](automatic-artifact-retention-api-draft.md) is implemented with repository enable/disable/status commands, a scoped daemon collector, indexed resumable traversal, current protection checks and shared manual/automatic cleanup receipts. It preserves newest versions, consumer pins and report holds; it does not remove final versions or prune report/run history. [Operator usage](automatic-artifact-retention.md) covers restore behavior and diagnostics. [Implementation evidence](automatic-artifact-retention-implementation.md) records real 200,000-version traversal, SIGKILL recovery and CLI/backup tests. Full verification passed: typecheck, formatting/lint and all 460 tests across 118 files, with 3,776 assertions and zero failures. [Earlier research](automatic-artifact-retention-research.md) remains distinct from implementation proof.

## Explicit checks and JUnit — approved and verified

The user approved the [Checks/JUnit contract](workflow-checks-api-draft.md). The SDK service, captured thresholds, durable records, bounded inspection and JUnit exporter are implemented. See [usage](workflow-checks.md) and [implementation evidence](workflow-checks-implementation.md). Typecheck, formatting/lint and the full suite passed: 488 tests, zero failures, 4,028 assertions across 126 files, with an unchanged source manifest. Earlier research stand-ins are not counted as implementation proof.

## Completed run-history reclamation — approved and implemented

The approved offline plan/apply/inspect/compact slice is implemented. It retires whole completed report families and native execution histories while preserving permanent submission identity, artifact content and consumer protection. See [operator usage](run-history-retention.md) and [implementation evidence](run-history-retention-implementation.md). Typecheck, formatting/lint and the full suite passed: 501 tests, zero failures, 4,224 assertions across 129 files, with an unchanged source manifest. Automatic run retention and retained-revision pruning remain separate parity gaps.

## AWS Secrets Manager vault extension — approved and verified

The user approved the [AWS read API](aws-secrets-manager-vault-api-draft.md), explicitly requiring extension delivery. The implementation in `extensions/aws-vault` uses lazy extension exports, existing Vault Layers and bundled Distilled dependencies. Durable tests cover real Distilled requests, HTTP/direct-process cancellation, generated consumer declarations, installation, daemon startup without credentials, rotation, secret-output rejection and restart. Typecheck, formatting/lint and the 516-test full suite passed, with a separate final 12-test extension run covering the last credential-error correction. See [implementation evidence](implementation-status.md#aws-secrets-manager-vault-extension). [Earlier research](aws-secrets-manager-vault-research.md) remains separate from implementation evidence; its AWS Promise SDK findings do not describe Distilled.

Use Distilled for all supported third-party integrations. Existing GitHub release/commit transport is a migration candidate; binary downloads and gh authentication need compatibility proof. Distilled's 1Password package covers Connect reads, which does not establish service-account/desktop support. The inspected Azure Key Vault operation is control-plane metadata, so secret-value data-plane coverage needs checking. The [coverage audit](aws-secrets-manager-vault-research.md#other-integration-coverage) records these precise boundaries. Remote mutations and richer provider lifecycle features remain queued.

## Deferred provider research: 1Password local CLI extension

Deferred by the user's runtime/V1 reprioritization. Its outstanding public API decision does not block runtime work.

The user selected Desktop/CLI authentication on 2026-11-07. The [revised proposal](onepassword-vault-api-draft.md) uses the installed official `op` through Effect's scoped subprocess primitives, with an explicit account and no Connect/service-account fallback. This is a documented Distilled coverage gap; Distilled remains the choice for future Connect access.

The [research record](onepassword-vault-research.md) preserves real Distilled/Effect 4.0.5 evidence, synthetic subprocess ownership proofs and alternate SDK/WASM Worker feasibility. None is a live desktop read or an installed 1Password extension. The earlier service-account-first recommendation is superseded. Remaining public approval concerns the concrete CLI factory, limits and conservative failed-read behavior: without a structured CLI NotFound contract, missing remote values fail rather than becoming `getOption` None. No production implementation has been added.
