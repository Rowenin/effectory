# Implementation readiness and first release

Current V1 direction (2026-11-07): [runtime correctness, upgrade/revision lifecycle and agent harness/skills setup](runtime-v1-plan.md). Additional provider extensions and UI concepts are deferred by the user. The milestones below remain the historical bounded-v0 plan.

Current runtime design research is tracked in [the research queue](runtime-research-queue.md), starting with Effect Scope, Layer ownership and runtime dependency injection.

Historical scope note: this roadmap defined bounded v0. Durable scheduling and scheduled task occurrence context were implemented afterward; references below to cron/schedules as deferred describe the original v0 boundary. Use [implementation status](implementation-status.md) and the [current parity audit](swamp-analysis.md#feature-mapping) for present delivery status.

The bounded v0 implementation and its local/live distribution proof gates are complete; see [current evidence and deferred scope](implementation-status.md). The planning status below records the original proposal, not the latest code coverage.

Status: planning pass 5 of 5. This is the entry point and proposed implementation order for the five planning passes. It refines the earlier [delivery plan](delivery-plan.md). This ledger is the original planning record. Current implemented contracts and test evidence are maintained in [implementation status](implementation-status.md); proposal syntax below should not override those executable contracts.

## Read the proposals in order

1. [Graph composition and policies](graph-composition.md): references, operators, scope, retries, concurrency and deadlines.
2. [Task implementation](task-implementation.md): typed handler context, services, publication, idempotency, errors and a test seam.
3. [Extension composition](extension-composition.md): contributions, host selection, replacements, patches and activation.
4. [Durability and recovery](durability-and-recovery.md): authoritative records, durable handoffs, callback registration and crash cases.
5. This roadmap: proof gates, first demonstration and bounded v0 delivery.

The [CLI/server catalogue](cli-server-api.md) remains the operating surface. MCP and a separate public client SDK are outside this implementation pass.

## Decision ledger

| Area | Status | Working direction |
| --- | --- | --- |
| Authoring shape | User selected | Graph workflows; `Task.make(spec, handler)` and `Workflow.make(spec, constructionEffect)`; Effect-based construction |
| Product requirements | User requested | Effect-native library, daemon/RPC CLI, background work, GitHub extensions, overridable workflow pieces and queryable lake |
| Input/reference typing | Proposed; type proof required | `graph.input(schema)`, opaque refs, explicit field access and mixed literal/ref inputs |
| Handler ergonomics | Proposed; type proof required | `(input, context) => Effect`, output-typed publication and ordinary service Layers |
| Execution policy | Proposed | Bounded declared retries, explicit deadlines and graph-owned durable waits |
| Extension composition | Proposed; bundle proof required | Installed package selection, canonical-contract replacement and before-step patches |
| Persistence ownership | Proposed; engine proof required | Effect owns execution outcomes; host owns admission, external wait decisions and artifacts |
| Platform | Proposed default | One repository daemon, Bun, SQLite/local blobs, authenticated loopback HTTP and pinned Effect 4.0.5 |
| Recovery scope | Proposed | Idempotent or manual replay; inspect/cancel uncertain manual work, with reconciliation deferred |

The selected authoring shape is a constraint on the prototype. If inference cannot support a proposed convenience, show the concrete type failure and smallest API adjustment. Do not silently widen to `any` or treat these recommendations as user approval of every new method.

## Bounded v0

| Area | Include in v0 | Defer |
| --- | --- | --- |
| Task authoring | Schema boundaries, typed context, Layers, scoped resources, JSON publication and a one-attempt test harness | Binary/stream publication, named configured instances |
| Graph | Task/refs, pure map, Boolean branch, bounded keyed fan-out, linked workflows, `after`, durable sleep | Arbitrary loops, races, all-settled, detached runs, pipeline sugar |
| Policies | Leaf concurrency, bounded retry, task/attempt/workflow deadlines | Arbitrary Effect Schedule, distributed rate limits, compensation |
| Interaction | Approval, typed user input, signal waits and register-before-trigger | Broadcast, pre-registration buffering, public webhook hosting |
| Control plane | Proposed CLI/RPC discovery, validation, planning, run/wait control, lake and extension methods | MCP, remote serving, role-administration UI, source editing |
| Lake | Exact JSON artifacts/versions, provenance, bounded AST queries, declared JSON paths and snapshot pagination | Joins, arbitrary SQL, binary search, automatic TTL/GC and migration tooling |
| Extensions | Locked GitHub bundles via `gh`, explicit inclusion, application-wide task replacement, additive before-step patches | General graph rewrites, infrastructure-provider replacement, hosted registry publishing |
| Operations | Restart recovery, diagnostics, explicit cancellation, retained revisions and tested offline backup/restore procedure | Arbitrary result injection, retry-anyway, cloud workers and cron |

Default v0 artifacts are retained. Deferring automatic deletion means retention policies in the broader lake design are not yet promises; unsupported policy options must be rejected. Bound admission, query work and payloads, and report storage exhaustion without losing accepted records. Add reference-aware GC only after proving it protects waiting runs, query snapshots and retained bundles.

This scope still leaves Swamp gaps: configured behavior instances, vault administration, schedules, reports and richer recovery. They do not block the requested task/workflow, extension and lake foundation, but must remain visible.

## Milestone 0: repair the scaffold and prove authoring types

Reconcile the root's removed workspace dependency and stale scripts, restore a working install/check pipeline, and establish only the package boundaries already proposed in [architecture](architecture.md). Keep platform imports out of core. Keep upstream source/check exclusions and the Effect pin; do not combine this with an unexplained dependency upgrade.

Build a small executable type fixture, not the full interpreter. It must prove:

- `graph.input(schema)` retains its type in an independently assigned construction Effect, and a mismatched declared codec fails validation without unchecked casts.
- Mixed literal/ref inputs preserve optional fields, discriminated unions and readonly arrays; invalid inputs and branch outputs produce useful errors.
- `(input, context)` infers declared output names/value types without circular task self-reference. External service requirements `R` remain unsatisfied until the appropriate Layer is supplied; host services are a specific known set.
- Boundary codecs round-trip decoded/encoded representations; domain errors remain distinct from host errors and defects.
- A replacement compiled separately can resolve the canonical contract/service identity. Matching JSON Schemas alone must not authorize a replacement.
- A [typed installed extension import](extension-task-consumption.md) can supply a task to a local workflow with input/result/error inference, normal editor resolution and retained external service requirements.

Exit: positive examples compile, negative type fixtures fail as intended, and the runtime codec-identity checks work. Any incompatible ergonomic proposal is revised before building consumers around it. This gate establishes API feasibility only.

## Milestone 1: prove the persistent engine adapter

Assemble the pinned Effect persistent workflow engine with SingleRunner, SQLite and required platform services. Use one task, one external wait and a tiny host outbox. Do not create a second graph execution journal to cover an unexplained gap.

Prove stable dispatch identity and acceptance/outbox recovery, completed-result lookup before replay decisions, and idempotent event/status projections. Explicitly configure/intercept Activity's default interruption retries. An interrupted manual task must enter NeedsAttention without silently running again.

Exercise stale-owner fencing at host publication and engine result acceptance; a check before returning a result is not enough if commit can race ownership. Commit a WaitStore decision, kill the process before engine notification, restart and observe exactly that recorded decision. Verify deadline recovery, cancellation and bounded finalization, including short durable delays.

Exit: deterministic crash tests pass at the relevant [recovery matrix boundaries](durability-and-recovery.md#crashrecovery-matrix). Failure to enforce interruption policy, ownership or result recovery blocks the runtime build. Record the specific adapter gap before considering another engine or changing the public durability promise.

## Milestone 2: the first complete consumer demonstration

Build application loading and immutable revision retention, a straight-line graph, one task before an approval, one publication task afterward, and the minimal CLI/RPC path. Include schema discovery immediately. Add exact artifact reads, versions and bounded metadata/tag/declared-JSON equality queries now, so the lake is demonstrably queryable rather than only an opaque output store. The authentication, authorization and payload-limit prerequisites described in Milestone 5 apply before this listener opens; they are not deferred to release time.

The repeatable demonstration is:

1. Export the application from `effectory.ts`; start its repository daemon.
2. Describe the workflow schema and submit it through CLI/RPC in the background.
3. Observe the first task complete and the approval become an open durable wait.
4. Stop/kill the daemon, restart, and inspect the same run and wait IDs.
5. Approve from another CLI process; the daemon continues without a resume command.
6. Observe the final task publish a schema-backed artifact and complete the run.
7. Query that artifact by a declared field/tag and inspect its exact version and producer run. Replay a lost-response submission/approval without duplicating it.

Exit: this works with no original CLI process alive, invalid inputs never invoke handlers, changed duplicate payloads conflict, and a crash after publication does not create another artifact version. Snapshot/watch handoff must not miss a fast terminal event. This is the first demo, not the full v0 release.

## Milestone 3: complete the bounded graph and interaction language

Add pure map, Boolean branch, bounded keyed fan-out, linked workflows, explicit ordering, durable sleep and declared execution policies. Add user-input requests, signals and register/trigger/await. Extend the task test harness alongside these features; durable behavior still needs the persistent runtime harness.

Exit: inactive branches never execute; fan-out keys and result order survive restart; child concurrency does not deadlock; waits consume no worker slot; deadlines do not reset; invalid answers leave waits open; rejected/expired waits settle the documented control outcome. Test callback-before-trigger-return, trigger failure after a callback, timeout/cancel races and scoped receiver IDs. Returning a workflow result must still wait for other activated work.

## Milestone 4: GitHub extension composition

Implement manifest validation, `gh` resolution/download, locked digests, archive validation, immutable cache and explicit Application selection. Add canonical task replacement and compiler-owned before-step patch barriers. Complete extension operation/status RPCs with installed-registry and active-application revisions.

Generate typed contract imports from named exports and prove fresh-checkout locked restore before application loading. A local workflow must compose an extension task with a local task without redeclaring schemas. Detect missing selection and stale bindings, and retain contract snapshots across extension updates.

Ship a fixture extension contributing a task and an approval patch. Demonstrate installation alone does not select a replacement, explicit inclusion exposes the contribution, and a selected approval patch prevents the target from starting. Demonstrate a second implementation satisfying the same canonical task contract.

Exit: conflicts and missing targets fail activation; branch/item patch scopes remain correct; public/private downloads and offline locked restore work; changed assets fail verification; interrupted update/reload cannot overwrite a newer application; existing runs retain their old provider/patch bundle. Trust is explicit because in-process extensions are privileged; no sandbox claim is made.

## Milestone 5: finish the control plane and release checks

Complete the scoped [CLI/RPC catalogue](cli-server-api.md), including read-only doctor, history/log/output paging, bounded drain and operation inspection. Finish the bounded lake AST, declared-field projection, snapshot ordering/cursors and query budgets from the [lake design](data-lake.md). Compare queries with a reference evaluator and exercise concurrent writes while paging.

Define the initial authorization model before exposing the Milestone 2 listener: repository identity, authenticated local principal, operation checks and wait actor recording. V0 can support one trusted repository owner without inventing a multi-user role system. Preserve checks before pagination/counts and idempotent receipt lookup. Loopback transport still requires authentication and protocol handshake; non-loopback binding remains unsupported.

Concrete schema limits are implementation work, not optional hardening: requests, results, waits, graph expansion, query depth/work, logs/events, archive expansion and observer buffers all need bounded, advertised defaults and typed limit errors. Choose and test them before exposing each corresponding endpoint. Verify input file parsing, JSON/JSON-Lines output, exit codes and uncertain-delivery reporting.

Exit: required checks pass, crash/race tests pass, a waiting run survives a tested offline backup/restore including blobs and bundles, and bounded-load tests do not lose accepted work or retain unlimited observer memory. A named release checklist records which APIs and guarantees were actually exercised. Current evidence is recorded in the [release checklist](release-checklist.md); this sentence originally described the planning-only pass.

## Choices to settle and what can wait

Before freezing authoring exports, review explicit schema-bound workflow input, typed callback context, schema-backed pure mapping and bounded retry syntax against the type prototype. Before shipping extensions, confirm application-owned selection and the constrained patch scope. Confirm that v0's manual recovery is inspection and cancellation, with unresolved external-effect evidence retained.

These are real consumer tradeoffs, not permission gates for writing a prototype. Exact helper names, convenience overloads, extra CLI aliases, named integration instances, arbitrary schedules and advanced recovery can wait. Engine ownership, replay safety, boundary validation and revision retention cannot be postponed past the features that depend on them.

The implementation has completed the authoring and engine proofs, restartable demonstration, graph language, extension composition and bounded v0 release checks. Each milestone leaves runnable evidence and explicit remaining gaps rather than treating all proposal text as an implemented contract.
