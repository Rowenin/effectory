# Swamp workflows and an offline Effect runtime

Research snapshot: 2026-10-21. Effect version inspected: 4.0.5, matching this repository's pinned dependency.

This is a reference for API and architecture decisions, not a claim that Effectory implements the features described here. Recheck upstream documentation and the installed Effect version before relying on a recovery or scheduling guarantee. The active project direction is documented in [the offline architecture](../automation-platform.md).

## Working conclusion

Local execution update: Effectory now follows Swamp's foreground CLI lifecycle: `workflow run` executes until an outcome or approval pause; `approval approve` only records the decision; `run resume` explicitly continues execution. Local commands do not require `serve`. Historical discussion of automatic approval continuation below describes the earlier design.

Implementation update, 2026-10-21: the [local MVP](../automation-platform.md#current-implementation) now includes native persistent workflows, task discovery, run/artifact inspection, and durable approval. Authoring now uses [the Effectory Activity/Automation API](../authoring.md) over native Effect execution. The initial snapshot and broad capability comparison below remain historical design context; they are not an implementation checklist.

The [MVP breakdown](../automation-platform.md#mvp-primitives) turns this research into seven primitives and three implementation increments. It records proposed defaults for local hosting, artifact storage, and approval continuation; the comparison below remains the broader capability reference.

Use native Effect Workflow and Activity for execution. Add a small application SDK for task discovery, approvals, artifacts, checks, reports, and triggers. Avoid introducing a second retry engine, execution state machine, dependency injection system, or workflow language.

A complete DAG before execution and arbitrary reruns from a named step are the two requirements most likely to justify an explicit step graph alongside Effect. Ordinary TypeScript workflow composition does not provide these capabilities automatically.

Swamp is a useful capability reference. Its workflow engine is accompanied by storage, indexing, secrets, reports, approval administration, recovery controls, and remote placement. A CLI that hosts Effect Workflow can provide the execution foundation, but matching that operational experience requires application code.

## Scope and classification

The following 38 comparisons group the current Swamp workflow options, execution behavior, approvals, recovery, and related CLI flags. They do not reproduce every compatibility spelling or claim parity with all Swamp server, extension, and worker-fleet features.

- **Effect primitive:** the execution behavior can be expressed through native Effect composition. Hosting, persistence configuration, and operator presentation still require integration.
- **Our runtime:** Effect supplies useful machinery, but Effectory must implement the application contract.
- **Different semantics:** native Effect behavior is not a direct equivalent. Decide whether to adopt Effect's semantics or add an explicit model.
- **Remote, later:** outside the initial single-machine offline runtime.

At this snapshot, Effectory supports local workspace initialization, a typed HTTP-check operation, and file-backed check history. Durable workflow hosting, SQLite journaling, task-directory discovery, approval commands, and the proposed SDK below are not implemented.

## Definition and authoring

Swamp sources: [workflow reference](https://swamp-club.com/manual/reference/workflows) and [reference section](https://swamp-club.com/manual/reference/workflows). The Effect mappings and classifications are our design judgments.

| Swamp option or capability | Mapping | Effect approach and remaining work |
| --- | --- | --- |
| id · name · description · version · tags | Our runtime | A task manifest supplies discovery metadata; Workflow tags and schema annotations supply some native metadata. Record code revision and run tags separately. |
| inputs · defaults · trigger.inputs | Our runtime | Workflow payload Schema handles typed input. Our CLI merges flags/files/defaults, validates them, and snapshots the accepted payload. |
| jobs · steps | Effect primitive | Use functions, Effect.gen, and named Activity boundaries. Logical phases are code structure; readable phase names need an event convention. |
| behavior · methodName · inputs · globalArgs | Our runtime | Invoke typed Effect operations with explicit configuration. A catalog supplies discoverable names, schemas, and independently configured instances. |
| behaviorType + behaviorName | Our runtime | Automatic creation of configured instances would be our catalog feature. Passing configuration directly avoids needing persistent instance creation. |
| CEL · self/model/inputs/env/vault/data/file/run | Different semantics | Use typed values and Effect services. Snapshot nondeterministic reads in activities. A data query or secret lookup still needs its corresponding application service. |
| validate · schema get · evaluate · --last-evaluated | Different semantics | Typechecking and Schema cover contracts. Safe pre-execution evaluation and an inspectable cached plan require an explicit planning model; arbitrary TypeScript cannot be safely evaluated as data. |

## Dependencies, concurrency, and task types

Swamp sources: [workflow reference](https://swamp-club.com/manual/reference/workflows) and [execution model](https://swamp-club.com/manual/explanation/the-workflow-execution-model). The Effect mappings and classifications are our design judgments.

| Swamp option or capability | Mapping | Effect approach and remaining work |
| --- | --- | --- |
| dependsOn | Effect primitive | Compose dependencies through yielded results, Effect.all, and fibers. A shared prerequisite must run once and its result must be passed or joined explicitly. |
| succeeded · failed · completed · skipped · always · and/or/not | Effect primitive | Branch on Exit or explicit outcome values with normal boolean logic. Preserve a skipped outcome when operators need to distinguish skipping from success. |
| weight | Different semantics | Explicit code order controls sequencing. Matching Swamp's weighted, level-based scheduling needs a scheduler; ordinary Effect concurrency does not reproduce that exact ordering. |
| workflow/job/step concurrency · host ceiling | Our runtime | Effect.all/forEach provide bounded concurrency. Nested limits and a shared semaphore can enforce a host budget; Swamp's exact inheritance rules would be application policy. |
| forEach · item/index · dynamic names/targets | Effect primitive | Use Effect.forEach over a captured collection and dispatch through typed functions or a catalog. Give activities stable, unique identities for each logical iteration. |
| allowFailure | Effect primitive | Capture a step's Exit and continue deliberately. Keep its failed outcome in the run view instead of converting failure into an apparent success. |
| guard | Effect primitive | Branch before an activity. Persist relevant observations and record skips. A guard alone cannot make an external side effect exactly once. |
| workflow · nesting | Our runtime | Call child Workflow.execute with stable child keys. Effect supplies child coordination; our UI tracks relationships and our policy defines depth, cycles, and cancellation behavior. |
| assert · severity · --fail-on · --junit | Our runtime | A Check service can collect typed assertion outcomes and apply a severity threshold. JUnit serialization and CLI exit policy are application features. |

## Human approval, suspension, and recovery

Swamp sources: [workflow reference](https://swamp-club.com/manual/reference/workflows) and [suspension model](https://swamp-club.com/manual/explanation/understanding-workflow-suspension). The Effect mappings and classifications are our design judgments.

| Swamp option or capability | Mapping | Effect approach and remaining work |
| --- | --- | --- |
| manual_approval · prompt · timeout | Our runtime | DurableDeferred supplies the wait; DurableClock supplies durable time. Approval adds review content, an authoritative deadline, pending requests, and decision validation. |
| approvals · approve · reject · decision record | Our runtime | Build an Approval inbox and commands. Record the trusted decision source, time, reason, reviewed digest, and workflow revision; enforce first-decision and authorization rules. |
| approve versus resume · autoResume | Different semantics | Swamp separates recording a decision from executing the remainder. Completing an awaited DurableDeferred can wake the workflow. Manual continuation needs a separate release gate or admission policy. |
| nested approvals | Our runtime | Native child workflows and durable waits cover execution. Our inbox must show which child gate blocks which parent, with explicit permission and cancellation policies. |
| resume --input / --input-file / --stdin | Different semantics | Prefer typed durable signals for new information. Workflow.resume takes an execution ID, not replacement payload fields. Mutating original inputs is not a native equivalent. |
| recover · unknown · --acknowledge-unknown | Our runtime | Cluster persistence supports replay and recorded outcomes. We still need an interrupted-operation policy and reconciliation for side effects whose external outcome is uncertain. |
| retry failed steps · --from | Different semantics | Workflow.resume does not provide arbitrary DAG invalidation. Selective reruns need an explicit plan and attempt model, or a new execution linked to selected prior artifacts. |
| run/resume --timeout · cancel · signals | Our runtime | Use interruptible Effects, Workflow.interrupt, and durable deadlines where restart matters. The CLI must distinguish caller detachment, cancellation requested, and confirmed termination. |

## Artifacts, secrets, and reporting

Swamp sources: [workflow reference](https://swamp-club.com/manual/reference/workflows) and [reference section](https://swamp-club.com/manual/reference/workflows). The Effect mappings and classifications are our design judgments.

| Swamp option or capability | Mapping | Effect approach and remaining work |
| --- | --- | --- |
| dataOutputOverrides · specName | Our runtime | An Artifact service publishes named, schema-validated outputs with run/activity provenance. Activity result persistence alone is not a user-facing artifact store. |
| lifetime · garbageCollection | Our runtime | Implement expiry and version retention, including job/workflow-scoped policies if wanted. Pin anything required by unfinished runs; journal cleanup is a separate concern. |
| tags · vary | Our runtime | Index artifact tags and dimensions such as region or environment. Use run-scoped references for data flow and explicit queries for cross-run history. |
| vaultName · sensitive outputs | Our runtime | Secret-aware publication and retrieval need storage and redaction rules. Redacted values do not prevent trusted code from exposing a raw secret. |
| vaults · inherited restrictions | Our runtime | A scoped SecretStore layer can narrow accessible vaults. Nested tasks must intersect permissions; Context/Layer dependency injection is not a sandbox. |
| reports · require/skip · report/check selection flags | Our runtime | Use report/check registries with labels and run policy. Persist outputs and distinguish required-report failure from operation failure; handle resumed execution explicitly. |
| history · search/filter · logs | Our runtime | Build a queryable run/artifact index and persisted log stream. Workflow.poll covers one execution's result; it does not provide Swamp's searchable operational history. |

## Triggers, remote placement, and inspection

Swamp sources: [workflow reference](https://swamp-club.com/manual/reference/workflows) and [reference section](https://swamp-club.com/manual/reference/workflows). The Effect mappings and classifications are our design judgments.

| Swamp option or capability | Mapping | Effect approach and remaining work |
| --- | --- | --- |
| trigger.schedule | Our runtime | ClusterCron supplies persisted scheduling machinery. Our host registers tasks, captures scheduled inputs, defines missed-run/overlap policy, and provides inspection commands. |
| webhooks | Our runtime | An Effect HTTP endpoint verifies the sender, applies input policy, and admits a workflow with an idempotency key. Signature validation, deduplication, and queue limits remain ours. |
| target · labels · platform · queueTimeout | Remote, later | Cluster routes entities across runners, but that is not equivalent to capability-aware worker placement. A compatible remote execution protocol and dispatcher would be a later feature. |
| affinity | Remote, later | Same-worker execution and worker-local files require explicit placement/session semantics. Ordinary sharding alone does not establish this contract. |
| --server · --token · remote ownership | Remote, later | A local RPC boundary can grow into remote control. Authentication, authorization, ownership, and access to remote artifacts require application design. |
| get --graph | Different semantics | Raw TypeScript workflows can discover branches at runtime. We can show observed execution traces; a complete pre-run DAG requires a declared plan or restricted authoring API. |
| create · get/search · edit/delete · trigger commands | Our runtime | Directory discovery and manifest conventions support task management. CLI scaffolding, version handling, trigger administration, JSON output, and useful errors are product work. |

## Local host design

Effect's [SingleRunner](https://effect.website/docs/v4/api/effect/cluster/SingleRunner) supports a single-process cluster host and uses SQL-backed message storage. It still needs a SQL client even when runner storage is configured as in-memory. Cluster does not imply that multiple machines are required.

The intended host combines:

- ClusterWorkflowEngine as the WorkflowEngine implementation.
- SingleRunner with a compatible persistent local SQLite adapter.
- Registered workflow implementation Layers.
- Platform services for filesystem, HTTP, processes, clocks, and crypto.
- Application services for artifacts, approval requests, secrets, and operational history.

[ClusterWorkflowEngine](https://effect.website/docs/v4/api/effect/cluster/ClusterWorkflowEngine) coordinates executions, activities, durable deferred completions, resumption, interruption, and durable timers through persisted entities. This provides execution machinery, not a complete task catalog or operator database.

A running process is required for work to progress. A separate local runner lets a submitting CLI exit while work continues. Persistence allows recovery when the runner starts again; it does not execute work while the machine is off.

Offline means no mandatory Effectory account, hosted API, registry lookup, or entitlement service. Dependency installation may need package access, and an explicitly configured operation may call an external system. The local runtime must remain usable without internet access after installation.

## Proposed authoring convention

Keep each automation in its own directory:

```text
.effectory/automations/
  health-check/
    index.ts
    http-check.ts
    inputs.json

.effectory/state/
  runtime.sqlite
  artifacts/
```

This historical sketch predates the current implementation. Authored code now lives in `.effectory/automations/`, with SQLite history in `~/.effectory/workspaces/<workspace-hash>/runtime.sqlite` and sockets and local action outputs in `.effectory/state/`.

An automation exports a small manifest around native Effect definitions:

```ts
// .effectory/automations/health-check/index.ts
export default {
  description: "Check HTTP endpoints and summarize their health",
  workflow: HealthCheck, // Workflow.make(...)
  implementation: HealthCheckLive, // HealthCheck.toLayer(...)
};
```

The manifest is our discovery convention. It does not implement execution. The host imports trusted, installed modules, registers their Layers, validates invocation payloads, and calls native Workflow APIs. Imported TypeScript is executable code, so discovery is not a sandbox or safe static planning pass.

A Task.define helper could later provide typing for this manifest. Introduce it when real CLI consumers establish what fields are needed. Payload schemas should come from Workflow rather than being duplicated in Task metadata.

An operation remains an ordinary typed Effect program. An Activity marks a durable execution boundary around an operation. A Workflow composes those activities. A CLI task is the discoverable registration of that workflow.

## Mapping the first-automation demo

The [Swamp tutorial](https://swamp-club.com/manual/tutorials/your-first-automation) demonstrates concurrent endpoint checks, a summary, and queryable result history.

Our equivalent would:

1. Define one HTTP-check operation with Effect Schema configuration and results.
2. Supply several named monitor configurations as workflow payload data.
3. Run one named Activity per monitor with bounded Effect.forEach concurrency.
4. Build the summary directly from that execution's typed results.
5. Publish/index the observations and report for inspection across runs.

Use stable, unique activity identities for the captured monitor collection. Pass a new request ID for a new measurement; reusing an idempotency key addresses the same workflow execution. Prefer run-scoped outputs for downstream data flow, with explicit artifact queries when cross-run history is intended.

For an offline demonstration, point the monitors at loopback fixtures. HTTP failures, timeouts, and connection failures can be recorded observations rather than workflow failures; a separate check or policy decides whether they fail the automation.

The workflow journal preserves execution outcomes. The cross-run artifact query experience needs an additional index and storage contract.

## Approval API direction

Approval is a useful application helper because a durable wait alone does not provide a reviewable request, a pending inbox, decision authorization, expiry, or an audit trail.

A proposed workflow fragment is:

```ts
const plan = yield * planRestart(input); // A named durable activity.

const decision =
  yield *
  Approval.request({
    key: "restart-service",
    title: `Restart ${plan.service}`,
    review: plan,
  });

if (decision.outcome === "rejected") {
  return yield * Effect.fail(`Restart rejected: ${decision.reason}`);
}

return yield * executeRestart(plan); // Execute the reviewed plan.
```

Approval.request is proposed Effectory API, not an Effect export. Its implementation should use [DurableDeferred](https://effect.website/docs/v4/api/effect/workflow/DurableDeferred), with [DurableClock](https://effect.website/docs/v4/api/effect/workflow/DurableClock) where durable deadlines are required.

The approval contract needs:

- A stable identity scoped to the execution and gate.
- The exact review content, input digest, and implementation revision.
- A trusted decision source, decision time, and optional reason.
- Atomic rules for duplicates, conflicting decisions, expiry, and cancellation.
- Durable indexing so pending requests can be listed without a live workflow.
- A deliberate continuation policy.

Swamp distinguishes approve from resume. Completing an awaited Effect DurableDeferred can wake the workflow. To preserve separate human review and later execution, record the decision separately from the continuation signal or add a second release gate. If automatic continuation is chosen, document it as our behavior rather than calling it exact Swamp parity.

An agent that can invoke every approval command can approve its own work. Enforced human approval needs a human-controlled channel or distinct authority. A text field claiming a person's identity is not sufficient.

## Recovery decisions to preserve

Persisted activities do not guarantee exactly-once external effects. A process can die after an external service accepts a request and before the activity outcome is committed. Reuse stable external idempotency keys where supported, and reconcile unsafe unknown outcomes before retrying.

Workflow.resume is not a general DAG editing or invalidation API. Implementing Swamp-style selective retries or --from behavior requires an explicit attempt/dependency model, or new executions with deliberate reuse of selected prior artifacts. Do not directly mutate engine journal rows as an application rerun API.

New information after suspension should normally arrive through typed durable signals or decisions. Replacing an original workflow payload on resume is a different contract and could invalidate earlier results or approvals.

Pin the implementation and configuration used by an execution. Decide how old implementations remain available after source changes. A version label alone is not proof that code has not changed.

Persist artifact content before exposing a successful reference. Keep active and suspended runs' required data pinned. Treat artifact retention, run-history retention, and engine-journal retention as separate policies.

## SDK recommendation

For agent execution specifically, see [Swamp agent calls and standard Effectory activities](swamp-agent-activities.md). It traces the agent-runner extension, documents the first standard process activity, and proposes agent and review activities over the existing authoring API.

Keep these responsibilities small and explicit:

- **Task:** discovery metadata, configuration conventions, and implementation registration.
- **Approval:** review requests, decisions, deadlines, and continuation policy.
- **Artifact:** schema-validated outputs, provenance, indexing, and retention.
- **SecretStore:** scoped runtime credential resolution and sensitive-output handling.
- **Check:** assertion outcomes, severity thresholds, and machine-readable test output.
- **Report:** inspectable summaries, required-report policy, and presentation.
- **Trigger adapters:** cron/webhook admission, captured inputs, deduplication, and overlap policy.

Keep Workflow.make, Activity.make, Effect.gen, ordinary error handling, and Layer composition visible to authors. Build the first durable workflow with these APIs before extracting a broader wrapper.

## Open decisions

- Do we require a complete graph before execution, or are observed traces sufficient?
- Do we need same-run selective reruns, or can a new execution explicitly reuse earlier artifacts?
- Does approval continue execution automatically or require an explicit resume?
- Which SQLite adapter and engine configuration pass restart tests on the pinned runtime?
- How do we enforce one journal owner per workspace?
- How do we persist and index approval requests without a gap around suspension?
- What defines implementation identity and how are old revisions retained?
- Which artifact queries are necessary initially?
- How is human authority distinguished from agent authority on a single local machine?
- What are the missed-schedule, overlap, and cancellation policies?

## Sources and review history

Primary Swamp references:

- [Workflow reference](https://swamp-club.com/manual/reference/workflows).
- [Workflow execution model](https://swamp-club.com/manual/explanation/the-workflow-execution-model).
- [Workflow suspension](https://swamp-club.com/manual/explanation/understanding-workflow-suspension).
- [Manual approval guide](https://swamp-club.com/manual/how-to/gate-a-workflow-with-manual-approval).
- [Idempotency and recovery](https://swamp-club.com/manual/how-to/make-workflows-idempotent).
- [Remote execution](https://swamp-club.com/manual/how-to/remote-execution).
- [First automation tutorial](https://swamp-club.com/manual/tutorials/your-first-automation).

Primary Effect references:

- [Workflow](https://effect.website/docs/v4/api/effect/workflow/Workflow).
- [Activity](https://effect.website/docs/v4/api/effect/workflow/Activity).
- [DurableDeferred](https://effect.website/docs/v4/api/effect/workflow/DurableDeferred).
- [DurableClock](https://effect.website/docs/v4/api/effect/workflow/DurableClock).
- [ClusterWorkflowEngine](https://effect.website/docs/v4/api/effect/cluster/ClusterWorkflowEngine).
- [SingleRunner](https://effect.website/docs/v4/api/effect/cluster/SingleRunner).
- [ClusterCron](https://effect.website/docs/v4/api/effect/cluster/ClusterCron).
- [ClusterSchema](https://effect.website/docs/v4/api/effect/cluster/ClusterSchema).

The comparison also checked the locally installed Effect 4.0.5 source for Workflow, Activity, DurableDeferred, SingleRunner, ClusterWorkflowEngine, and core composition APIs. Workflow and Cluster APIs are marked unstable in the inspected version.

2026-10-21: Initial comparison and authoring/approval recommendations recorded. Future revisions should state the versions checked, distinguish native capabilities from proposed helpers, and update implementation status independently from desired feature coverage.

## Implementation validation notes

The delivered MVP has process-level tests for persistent native activities, SIGKILL and graceful recovery, single-owner reclamation, idempotent admission, artifact conflicts/bounds, approval decisions and outbox delivery, cancellation, and transitive-source revision refusal. See `packages/runtime/test/engine.test.ts`, `packages/cli/test/cli.test.ts`, and `packages/runtime/test/tasks.test.ts`.

Independent review identified that native decoded success values cannot be persisted with plain JSON.stringify. The runtime now encodes through the workflow success schema's JSON codec. `packages/runtime/test/codecs.test.ts` covers BigInt, Date, Void, transformed wire values, completion-index gap recovery, malformed native replies, oversized results, and the finite-JSON input restriction. Inspection errors are diagnostic data, separate from native workflow failures. A problematic result does not block unrelated work or workspace startup.

These tests establish the exercised single-machine Bun/SQLite path. They do not establish power-loss durability, untrusted-code isolation, multi-user approval enforcement, remote worker behavior, or safe replay of arbitrary non-idempotent external actions.
