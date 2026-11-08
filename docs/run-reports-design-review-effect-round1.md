# Post-run reports: Claude Effect design review, round 1

Status: design critique for parent consolidation. **No report API is approved.** This review's verdict is not user approval and does not authorize implementation. It critiques the provisional direction in [run-reports-research.md](run-reports-research.md) against the constraints in [runtime-research-queue.md](runtime-research-queue.md).

Labels used throughout:

- **[Fact]** Established from source in this checkout or from a probe run for this review. File references are given.
- **[Proposal]** A recommended choice. Needs consumer review and user discussion.
- **[Untested]** An assumption that a proof gate must settle before anyone relies on it.

## Verdict

Do not ship `Report.make(spec, handler)` with a host-provided source service as a separate kind of definition. Reports should be **ordinary `Task.make` definitions**. A small `Report` module should supply:

1. the source schemas (`Report.Source`, `Report.sourceOf(target)`);
2. the result schema (`Report.result(data)`);
3. one runner-owned read capability (`Report.History`);
4. a thin attachment value (`Report.attach`);
5. a test helper (`Report.test`).

At run time a report is its **own admitted task run**. A durable obligation in the host store admits it, with deterministic deduplication. It runs on the source's pinned revision.

Two things decide this, both traced below:

- **Storage.** After the source is terminal, the lake refuses any publication under the source's identity. The only path that already has attempts, retries, vault guards, task-local Layers, logs, cancellation and restart recovery is an admitted run.
- **Types.** A "source as a host service" makes the durable source invisible to replay, deduplication and `run get`. It also leaks into Application requirements; the probe below shows this against the real `Application.make`.

Every reason to add a wrapper turns out to be about schemas, attachment validation, history access or durability. None of them needs a second handler kind.

## 1. Facts traced for this review

### Persistence boundaries

- **[Fact] One file, three connections, no cross-connection transaction.**
  - `daemon.ts:108` uses one `state.sqlite`.
  - `host.ts` builds `engineLayer(database)` (an Effect `SqliteClient`), `hostStoreLayer(database)` (`bun:sqlite`) and `lakeLayer(database, …)` (another `bun:sqlite` connection).
  - Probe: if a second connection writes while the host connection holds a transaction, it fails with `database is locked`, and neither write survives. Script: `scratchpad/reports-probe/savepoint.mts`, case 3.
  - Consequence: a host-store row cannot be committed atomically with an engine `Activity` result.
- **[Fact] Root terminal state is a host-store projection that runs after engine completion.**
  - The runner `tick` polls `execution.poll(engineId)` every 100 ms. It then calls `store.project(runId, status, payload)` in a single host-store transaction (`runner.ts` `reconcile`; `host-store.ts` `project`).
  - `project` is idempotent: it does nothing if the run is already terminal.
  - If the process crashes between engine completion and projection, the next poll repeats the projection.
- **[Fact] Graph task invocations are registered in the host store before dispatch. Their completion lives only in the engine.**
  - `invokeTask` calls `store.registerInvocation(runId, nodeId, engineId, payload)` in its own transaction, then calls `leafExecution.execute`. Each attempt runs as `Activity.make({ name: "handler/<n>" })` inside the `EffectoryTask/v1` workflow (`interpreter.ts`).
  - The host store records `AttemptStarted`. It has no completion row.
  - `stopInvocations` already discovers leaf completion by calling `leafExecution.poll(engineId)`.
- **[Fact] The lake refuses publication for a terminal or unadmitted source.**
  - The `lake.ts` `commit` transaction requires a `host_attempts` row owned by the current lease, for the exact `(runId, invocationPath, attempt)`.
  - It also requires run status in `Queued | Running | Waiting | Retrying`.
  - So a report cannot write artifacts under the source run after the source finishes.
- **[Fact] Run admission is a host-store transaction that deduplicates by `(principal, admissionNamespace, requestKey)`.**
  - It throws when the daemon is draining or when there are already 1000 active runs (`host-store.ts` `submitRun`).
  - Schedules already admit runs through it under namespace `schedule`, from inside another host-store transaction.
- **[Fact] Admitting a run inside the terminal-projection transaction is unsafe.**
  - Probe case 1: when nested admission throws, the source's terminal projection rolls back.
  - Probe case 2: commit projection and obligation together. Then promote in a later transaction that catches the nested savepoint failure. That gives "obligation stays Ready; retry later" and no lost projection.
- **[Fact] The run result is already a vault-guarded, bounded, durable record.**
  - `leafLayer` encodes success with `task.successSchema` and calls `VaultTracker.checkSerialized(serialized, tracker)` before returning from the Activity.
  - Domain errors are encoded and checked; `TaskRuntimeError` messages are scrubbed.
  - `checkJsonBudget` caps values at 1 MiB, depth 64 and 100 000 values (`json-budget.ts`).
- **[Fact] Run history is not pruned today.** Nothing deletes from `host_runs` or `host_events`. Only lake records have retention and reclamation.
- **[Fact] Engine replies appear to be kept after completion.** In pinned Effect 4.0.5 cluster storage, replies are cleared only by `Sharding.reset` (resume) and by `clearAddress` for clock entities (`node_modules/effect/src/cluster/ClusterWorkflowEngine.ts:282`, `Sharding.ts:1309`).
  - **[Untested]** No path clears a completed leaf's reply. I did not trace every reset caller exhaustively. The proposal below does not depend on this.

### Lifetimes and dependency injection

- **[Fact] Application services are shared for the life of the revision.**
  - `Application.make` captures `services` once in `Layer.effect(Registry, build)`. Every task `execute` is given that context.
  - Task-local `.provide(layer)` builds through the invocation memo map on every attempt, with publications closed before Layer finalizers run (`task.ts` `definition`/`provide`, `taskLayer`).
- **[Fact] Runner-owned per-invocation services are removed at the type level and provided by `definition()`.** The precedent is `Tag.Values | ArtifactStorage`, which is excluded from `R` in `Task.make`/`Definition.provide`.
- **[Fact] Vault protection is per attempt.** `VaultTracker.protect` opens and closes around the whole Activity body, including final encoding (`interpreter.ts` `leafLayer`).

### Swamp, from source only (not run)

- **[Fact] When reports run.**
  - Workflow-scope reports run in-process, after `run.complete()` and before the `completed` event and `saveRun` (`vendor/swamp/src/domain/workflows/execution_service.ts:4005-4035`, `4943-4961`).
  - Cancelled runs return before reports run, so cancelled runs get no workflow reports (`:4000`).
  - Method reports run after each step, on success and failure (`:2848`, `:2982`).
- **[Fact] Failures are swallowed.**
  - `executeReports` catches each report's error and persists a fallback error report (`report_execution_service.ts`).
  - `WorkflowReportRunner.runFor` also swallows and logs any error that escapes.
  - The run's status is already folded before reports run, so a report failure does not change it.
  - **[Untested]** The CLI's final exit code under report failure was not traced through the command layer.
- **[Fact] Swamp reporting is not crash-durable.** Reports run before `saveRun`. A crash during reporting loses both the reports and the run record update. Effectory should not copy this.
- **[Fact] Persistence.** Each report is persisted as paired Markdown/JSON data (lifetime 30d, garbage collection 5). Empty Markdown skips persistence.
- **[Fact] Selection.** Report selection uses `require` (optionally per method), `skip`, CLI name/label include and exclude, `skipAllReports`, and built-in default names per scope.
- **[Fact] Missing reports.** A required report that cannot be found produces a failure result and an error artifact.

## 2. Critique of the provisional `Report.make(spec, handler)` and host-provided source service

1. **It is a second task engine unless it compiles to a Task.**
   - Reports need attempts, retry, timeouts, cancellation, `NeedsAttention` for manual replay, vault tracking, the task logger, telemetry budgets, lake publication and task-local Layers.
   - Every one of these lives in `Task.make`'s `definition()` and in `leafLayer`.
   - If `Report.make` lowers to `Task.make`, its only contribution is fixing `input` and `success`. That is two spec fields, which `Report.Source`/`Report.result` already cover.
2. **A source service conflates durable data with a capability.**
   - The source identity and outcome are input: immutable, bounded and schema-owned. They must be fingerprinted for deduplication, visible in `run get`, replayed on restart, and fed to tests.
   - Task input already does all of that.
   - What really is a service is **reading more history**, which needs I/O, paging and a principal scope. Split them: source → input; history → `Report.History`.
3. **Requirement accounting leaks.**
   - [Fact, probe] With the real `Application.make`, a report handler that yields a runner-owned service keeps that service in the Application's requirements after every application Layer is provided:

     ```ts
     type ProvidedR = /* app.provide(Deployer).provide(Formatter) */;
     const remaining: [ProvidedR] extends [Report.History] ? true : false = true; // typechecks
     ```

   - A host cannot meaningfully satisfy a per-invocation capability with an application-wide Layer.
   - A `Report.make` would need its own exclusion list, its own `.provide` and its own Application slot. That duplicates `Task.Definition`.
   - The smallest fix is to add `Report.History` to the existing runner-owned exclusion set (see blocker B1).
4. **A host-side post-completion executor cannot publish artifacts.** [Fact] The lake commit rule ties publication to an admitted, non-terminal attempt. Running "after the source" in the source's context therefore has no publication path. A dedicated report run does.
5. **What a wrapper would genuinely add.** Typed source inference, compatibility checking at attachment time, and a test helper. The probes show `Task.make` plus schema helpers already infer the typed source and reject mismatched attachments. A `Report.task` sugar is optional; see decision D7.

## 3. Recommended API [Proposal]

### Library declarations (stand-ins typechecked against Effect 4.0.5)

The stand-in is `scratchpad/reports-probe/report.ts`. It typechecks with the repo's `tsc 7.0.2+effect-tsgo.0.56.0` against the real `packages/core/src` task, workflow and application modules.

```ts
// @offtree/effectory-sdk — export * as Report from "./report.ts"
export const Status: Schema.Literals<["Succeeded", "Failed", "TimedOut", "Cancelled", "Rejected"]>;
export const Failure: Schema.Struct<{
  category: Schema.Literals<["Domain", "Host", "Control"]>;
  code: Schema.optionalKey<Schema.String>;
  message: Schema.optionalKey<Schema.String>;
}>;
export interface SourceOf<V, E> {
  readonly runId: string;
  readonly path: readonly string[] | null; // null = submitted root
  readonly target: { readonly kind: "task" | "workflow"; readonly id: string; readonly version: number };
  readonly revision: string;
  readonly status: typeof Status.Type;
  readonly value: V | null;      // decoded success when Succeeded
  readonly error: E | null;      // decoded domain error when category = Domain
  readonly failure: typeof Failure.Type | null; // host/control/scrubbed failure
  readonly truncated?: true;     // value/error omitted over 256 KiB (D9); read via History
}
/** Generic source for reusable reports (extensions, built-ins). */
export const Source: Schema.Codec<SourceOf<Schema.Json, Schema.Json>, …>;
/** Typed source; memoized per target spec so Application can check identity at load. */
export function sourceOf<T extends Task.Contract | Workflow.Definition>(
  target: T
): Schema.Codec<SourceOf<T["successSchema"]["Type"], T["errorSchema"]["Type"]>, …>;
/** Report success: Markdown (≤ 256 KiB) plus declared structured data; branded for validation. */
export function result<D extends Boundary>(data: D): Schema.Struct<{ markdown: …; data: D }>;

/** Runner-owned, per report attempt; read-only; scoped to the source run and principal. */
export class History extends Context.Service<History, {
  readonly outputs: (request: {
    readonly cursor?: string; readonly limit?: number; // ≤ 200
    readonly under?: readonly string[];                 // invocation path prefix
  }) => Effect.Effect<typeof OutputPage.Type, TaskRuntimeError>;
  readonly events: (request: {
    readonly cursor?: string; readonly limit?: number; readonly afterSequence?: number;
  }) => Effect.Effect<typeof EventPage.Type, TaskRuntimeError>;
}>()("effectory/Report.History") {}

export type Scope = "run" | "invocation";
export interface Attachment<T extends Task.Contract | Workflow.Definition = …, S extends Task.Spec = Task.Spec> {
  readonly kind: "ReportAttachment";
  readonly id: string;                 // identifier(); unique per application
  readonly target: T;
  readonly report: Task.Contract<S>;
  readonly scope: Scope;               // default "run"
  readonly on: readonly (typeof Status.Type)[]; // default: all terminal statuses (see D1)
  readonly labels: readonly string[];  // for later submission-time selection
  readonly execution?: { readonly attemptTimeout?: string; readonly timeout?: string;
                         readonly retry?: { attempts: number; delay: string; when: readonly string[] } };
}
export function attach<T extends Task.Contract | Workflow.Definition, const S extends Task.Spec>(
  id: string,
  options: {
    readonly target: T;
    readonly report: Task.Contract<S> & Compatible<T, NoInfer<S>>; // input accepts sourceOf(T); success is result(...)
    readonly scope?: Scope;
    readonly on?: readonly (typeof Status.Type)[];
    readonly labels?: readonly string[];
    readonly execution?: Attachment["execution"];
  }
): Attachment<T, S>;

/** Task.test with Report.History supplied from fixed pages. */
export function test<S extends Task.Spec, R>(
  report: Task.Definition<S, R>,
  options: { readonly source: NoInfer<S["input"]["Type"]>;
             readonly history?: { readonly outputs?: readonly …[]; readonly events?: readonly …[] } }
): Effect.Effect<{ value: S["success"]["Type"]; publications: …; progress: … }, …, R>;

// Application.make gains: reports?: readonly Report.Attachment[]
```

Required core change: widen the runner-owned exclusion in `Task.make`, `Task.Definition.provide` and `Task.Implementation.provide` from `Tag.Values | ArtifactStorage` to `Tag.Values | ArtifactStorage | Report.History`.

### Consumer path

From `scratchpad/reports-probe/consumer.ts`, which typechecks. The negative cases are in `negative.ts`; all three `@ts-expect-error` lines are consumed.

```ts
const Deploy = Task.make({ id: "acme/deploy", version: 1, input: Schema.String,
  success: Schema.Struct({ url: Schema.String }),
  error: Schema.Struct({ _tag: Schema.Literal("DeployFailed"), reason: Schema.String }),
  replay: "idempotent" },
  (service) => Effect.gen(function* () { return { url: yield* (yield* Deployer).deploy(service) }; }));

// Typed report: an ordinary task. source.value is { url } | null; source.error is DeployFailed | null.
const DeploySummary = Task.make({ id: "acme/deploy-summary", version: 1,
  input: Report.sourceOf(Deploy),
  success: Report.result(Schema.Struct({ ok: Schema.Boolean })),
  error: Schema.Never, replay: "idempotent" },
  (source) => Effect.gen(function* () {
    const format = yield* Formatter;                       // application Layer
    return { markdown: `${format.heading("Deploy")}\n${source.value?.url ?? source.error?.reason ?? source.failure?.message ?? ""}`,
             data: { ok: source.status === "Succeeded" } };
  })).provide(Layer.succeed(Clock2, …));                    // task-local override

// Generic report, as an extension ships it; reads bounded history.
const OutputCount = Task.make({ id: "tools/output-count", version: 1, input: Report.Source,
  success: Report.result(Schema.Struct({ count: Schema.Int })), error: Schema.Never, replay: "idempotent" },
  (source) => Effect.gen(function* () {
    const page = yield* (yield* Report.History).outputs({ limit: 200 });
    return { markdown: `${source.runId}: ${page.items.length}`, data: { count: page.items.length } };
  }));

export default Application.make({
  tasks: [Deploy, DeploySummary],
  workflows: [Release],
  extensions: [Extension.use(Tools)],                       // contributes tools/output-count
  reports: [
    Report.attach("deploy-summary", { target: Deploy, report: DeploySummary, scope: "invocation" }),
    Report.attach("release-outputs", { target: Release, report: Tools.tasks.OutputCount }),
  ],
}).provide(DeployerLive).provide(FormatterLive);

// Test
const out = yield* Report.test(DeploySummary.provide(FormatterTest), {
  source: { runId: "r", path: ["deploy"], target: { kind: "task", id: "acme/deploy", version: 1 },
            revision: "x", status: "Failed", value: null, error: { _tag: "DeployFailed", reason: "quota" }, failure: null },
});
```

The CLI commands are listed in section 7.

### Load-time validation in `Application.make` [Proposal]

- Each attachment's report contract is registered and canonical, using the same `spec` identity rule as graph task nodes.
- The report input schema is `Report.Source`, or the memoized `Report.sourceOf(target)` instance.
- The success schema comes from `Report.result` (checked by WeakSet brand).
- The target is a registered task contract or workflow.
- Attachment ids are unique; there are at most 128 attachments.
- A report task is never also the target of an attachment's report chain. This is a load-time check; runtime recursion is also blocked by namespace (section 4).
- [Fact] `sourceOf` is keyed by `target.spec`. `Task.implementation` reuses `provider.target.spec`, so an extension implementation of the same contract shares one source schema.

## 4. Runtime semantics [Proposal unless marked]

### Trigger and scope

- **`scope: "run"`** applies to a submitted root run whose target matches: a task run or a workflow run.
  - One report per (source run, attachment), produced when the root reaches a terminal status in `on`.
  - `NeedsAttention` is not terminal: the report waits until resolution.
- **`scope: "invocation"`** applies to a `Task.Contract` target. It covers every logical invocation of that contract:
  - graph nodes;
  - `forEach` items (each item's invocation path is distinct);
  - branch-selected nodes;
  - patch graph nodes (`…/$patch/<id>/…`);
  - the root of a task run (path `["task"]`).
  - **One report per final invocation outcome, never per attempt.** Retry attempts produce a single obligation keyed by `(runId, path, attachmentId)`.
  - If an extension implementation replaces the provider, the attachment still applies, because it binds to the contract (the source schema shares the spec).
- **Inactive or skipped work produces no invocation report**: an unselected branch, or nodes never reached after a failure fence. [Gap] Root reports cannot yet list declared-but-not-run nodes with a skip reason, as Swamp's `skipReason` does. See B7.
- **Nested workflows.** [Fact] A child workflow is interpreted inline (`executeChild`) and has no host-store registration. A `scope: "invocation"` attachment on a `Workflow.Definition` is rejected at load time in the first slice. See B6.
- **Recursion.** Report runs use admission namespace `report`, and obligations are never created for runs in that namespace. A report on a report is therefore impossible by construction.

### Durable obligation capture

Add a host-store table:

```
host_report_obligations(
  sourceRunId, path /* canonical JSON or '' */, attachmentId,
  reportTaskId, reportTaskVersion, scope,
  state /* Armed | Ready | Admitted | Skipped | Failed */,
  sourceJson /* encoded Report.Source, set at Ready */,
  reportRunId, detailJson, createdAt, updatedAt,
  PRIMARY KEY(sourceRunId, path, attachmentId))
```

- **Pinning.** At `submitRun`, inside the same transaction, store `reportPlanJson` on `host_runs`: the applicable attachments from the pinned revision's registry, keyed by target id and bounded to 128. The plan, and the report contract versions, are frozen with the revision. The scheduler's `submitRun` path also needs the plan, so the schedule store's admission must receive it.
- **Root obligations.**
  - In `project()`, inside the same transaction as the transition to a terminal status, insert `Ready` obligations for each run-scope plan entry whose `on` includes the status.
  - `sourceJson` is built from the projected payload: a `Domain` detail goes to `error`; other categories go to `failure`.
  - Atomic: [Fact] same connection, same transaction.
  - Crash before projection: reconcile reprojects. Crash after: the rows exist.
- **Invocation obligations.**
  - In `registerInvocation`'s transaction, insert `Armed` rows for the task's invocation-scope plan entries.
  - This happens before `leafExecution.execute`, so dispatch implies an obligation.
  - Completion is then recorded in two ways:
    1. **Write-ahead.** After the attempt loop settles, and before the leaf workflow returns, the `EffectoryTask/v1` body performs an idempotent host-store write `completeInvocation(runId, nodeId, sourceJson)` that turns `Armed` into `Ready`. On replay the Activity result is cached, and the write repeats with the same value. The write happens before the engine persists the workflow result, so engine completion implies the host row exists. Exception: interruption, handled next.
    2. **Fallback poll.** For `Armed` rows whose run is fenced or terminal, a reconciler polls `leafExecution.poll(engineId)`, exactly as `stopInvocations` does, and records the observed exit, including interrupts mapped to `Cancelled`.
  - This design never assumes Activity completion and host-store writes are atomic. [Untested] An interrupted leaf polls as `Complete` with an interrupt cause. This needs a proof gate.
- **Promotion** happens in a separate host-store transaction, run by a promoter fiber (below):
  - `submitRun` under namespace `report`, with `requestKey = sha256(canonical([sourceRunId, path, attachmentId]))`. Raw paths may exceed the 200-character key limit.
  - Principal is the source principal; revision is the source revision; input is `sourceJson`.
  - Then mark the obligation `Admitted` with `reportRunId`.
  - If admission fails because of drain or a cap, catch the savepoint failure; the row stays `Ready` ([Fact] probe case 2).
  - Duplicate durable reports are impossible because of the unique admission key.
- **Caps and fairness.**
  - Do not count report runs against the user-facing 1000 active-run cap.
  - Do enforce a separate budget of active report runs (proposed default 32) in the promoter.
  - Report attempts already share the global 32-permit semaphore with normal work. [Untested] Whether that starves normal work under fan-out; a proof gate is listed.
  - Per source run, cap obligations at 10 000, matching the invocation limit. Excess becomes one `Skipped` row with `LimitExceeded` and a count, never a silent drop.
- **Report execution options.** [Fact] Task runs dispatch `invokeTask(run, "task", …)` with no node options. Report runs need `attachment.execution` (retry, attemptTimeout, timeout) passed from the plan into that call. It is a small change; without it, reports cannot retry.

### Lifetimes and ownership

| Thing | Owner | Scope ends | Restart |
| --- | --- | --- | --- |
| Obligation rows | host store (`state.sqlite`) | never; history record | durable |
| Promoter / armed-poll fiber | `reportLayer`, `forkScoped` in the daemon Layer graph, built after `HostStore`/`Lake`/engine (`provideMerge` order), like `runnerLayer` | daemon Layer scope closes, before store connections close | resumes from rows; no in-memory state required |
| Report run | ordinary run: engine + host store | terminal projection | existing recovery |
| Application services | revision `Registry` Layer (shared with normal tasks) | revision release at shutdown ([Fact] current audit) | rebuilt |
| Task-local `.provide` Layers | per attempt, invocation memo map | attempt end, after publications close | reacquired per attempt |
| `Report.History` instance | interpreter, per attempt, built like `taskContext` and provided next to `Tag.Values`; bound to `sourceRunId` and principal; closed with `active.value = false` | attempt end | rebuilt |
| Vault tracker | `VaultTracker.protect` around the Activity body | after final success/error encoding | per attempt |

No detached fibers. Drain: `stopAccepting` makes promotion fail and rows stay `Ready`; the promoter is interrupted with its Layer. Nothing relies on finalizers for crash recovery.

### Outcome, cancellation, restart and retention

- **Execution versus reporting outcome.**
  - Reports never change the source's status or the foreground exit code (consistent with Swamp's swallow semantics).
  - Report outcome is the report run's own terminal status.
  - A foreground `workflow run --reports wait` waits for the source's obligations to be terminal or `Skipped`/`Failed`, then prints them. Its exit code only changes with `--fail-on-report-failure`. See D3.
- **Cancellation.**
  - Cancelling a source mid-run fences it. Root obligations are created with status `Cancelled` if `on` includes it.
  - `Armed` invocation obligations resolve through the fallback poll.
  - A report run is cancelled with ordinary `run cancel`.
  - [Gap] Dismissing a `Ready` obligation that has not yet been admitted needs an operation; deferred.
- **Manual or uncertain report effects.** These reuse `admitAttempt`: a re-entered manual report attempt goes to `NeedsAttention`, like any task.
- **Restart.** Every state is durable:
  - `Armed` is completed by write-ahead replay or by the poll;
  - `Ready` is promoted;
  - an `Admitted` row is an ordinary run.
- **Revision unavailable.** If the catalog cannot load the pinned revision at promotion, the row goes to `Failed`, with `detail.code = "RevisionUnavailable"`, as a durable receipt. [Untested] The catalog's retention of old revisions across restarts for this path.
- **Retention.**
  - The report record is the report run's `result` (`{ markdown, data }`). There is one record, so a Markdown/JSON pair can never be half-written.
  - It follows run-history retention, which today means it is never pruned.
  - Authors who want lake artifacts declare outputs on the report task and publish through `ArtifactStorage` ([Fact] the report run is an admitted attempt, so the lake allows it), with normal artifact retention.
  - References in report data to reclaimed source artifacts are resolved by `LakeGet`, which reports the reclaimed state.
- **Empty Markdown.** Unlike Swamp, the result is still persisted; the CLI prints a note that the report is empty. This is deliberate, because the run result must exist.

### Source data and secret protection

- `Report.Source` is bounded:
  - The success and error JSON are already within the 1 MiB budget and passed the source attempt's vault guard.
  - `sourceJson` copies them once, so a source near the 1 MiB limit doubles its storage.
  - [Proposal] When the encoded `value`/`error` would exceed 256 KiB, store `null` for that field and add `truncated: true`; the report reads the full value through `History.outputs`. See D9.
- `History` only returns pages of at most 200 items through the existing `RunOutputs`/`RunEvents` paging code (`run-outputs.ts`, `run-history.ts`). It is limited to the source run and principal. No new artifact-content reader is added; bytes stay behind `LakeGet`/download.
- Report text, data and errors pass the report attempt's own `VaultTracker` guard at the same `leafLayer` boundary as any task. Progress and log messages are scrubbed.
- [Fact] Values that came from source history were checked only against the _source_ attempt's tracker. That is unchanged from today's `run outputs` exposure, and is not a new leak.

## 5. Blockers and smallest fixes

| # | Blocker | Evidence | Smallest fix |
| --- | --- | --- | --- |
| B1 | A runner-owned capability leaks into Application requirements | [Fact] probe `consumer.ts` `remaining` | Add `Report.History` to the exclusion union in `task.ts` (3 sites). Provide it from `definition()` like `Tag.Values`. Outside report runs, provide an implementation that fails with `TaskRuntimeError{code:"Unavailable"}` and says so; that is a clear refusal, not a hidden fallback. Add `Report.test` so tests can provide it. |
| B2 | A post-completion executor cannot publish to the lake | [Fact] `lake.ts` `commit` requires an admitted non-terminal attempt | Reports are their own admitted runs (namespace `report`). |
| B3 | No atomicity between engine completion and host-store writes | [Fact] three connections; probe case 3 | Root: obligations in the `project()` transaction. Invocation: `Armed` in `registerInvocation`, write-ahead `completeInvocation` in the leaf workflow body, fallback `leafExecution.poll`. |
| B4 | Admission inside the projection transaction rolls the projection back | [Fact] probe case 1 | Separate promoter transaction catching a nested savepoint failure (probe case 2). |
| B5 | The 1000-run cap and drain can block reports; fan-out can starve users | [Fact] `submitRun` caps; `forEach` ≤ 1000 items; 10 000 invocations | Separate report budget, exempt from the user cap; per-run obligation cap with a `Skipped` receipt; fairness gate. |
| B6 | Child workflow invocations have no durable registration | [Fact] `executeChild` registers nothing | Slice 1 rejects invocation scope on workflows. Full parity needs `registerScope` for child nodes in a later slice. |
| B7 | Skipped/not-run nodes are not recorded | [Fact] only executed nodes have engine results | Slice 1 gap. Later: derive the declared node set from the pinned graph plan (`graph-plan.ts`) in `History`. |
| B8 | Task runs carry no retry/timeout policy | [Fact] `graphLayer` `invokeTask(run, "task", …)` with no options | Store `attachment.execution` in the plan and pass it as `NodeOptions` for runs in namespace `report`. |
| B9 | Run provenance and listing compatibility | [Fact] `Run` and `RunListRequest` have no namespace | Add `Run.report: optionalKey({sourceRunId, path, attachmentId})`. Add `RunListRequest.origin: optionalKey(Literals(["manual","schedule","report","all"]))`. [Untested] Effect 4.0.5 `Schema.Struct` decoding of unknown keys by old clients. |

## 6. Achievable slice versus full parity

**Slice 1 (achievable on the current runtime):**

- the `Report` module and the B1 exclusion;
- `Application.make({ reports })` with load validation;
- run scope for task and workflow roots;
- invocation scope for task contracts in graphs (including `forEach`, branches, patches, extension implementations and root task runs);
- obligations, promoter and report runs (B2–B5, B8, B9);
- the `RunReports` RPC and CLI;
- sanitized terminal rendering.

**Deferred, and still a parity gap until done:**

| Swamp capability | Effectory status |
| --- | --- |
| Method-scope reports on every step | Slice 1 invocation scope (one per final outcome; Swamp's step-level failure reports also covered) |
| Workflow-scope reports | Slice 1 run scope. Nested child-workflow scope is deferred (B6). |
| Model-scope / model-type default reports | **Gap.** There is no model instance concept. The nearest is extension-default attachments: `Extension.make({ reports })`, selected by `Extension.use(X, { reports: [ids] })` in line with the existing implementation selection. Not in slice 1. |
| Built-in method/workflow summary reports | **Gap.** Ship as a host extension of ordinary report tasks (`effectory/summary`). Whether it is on by default is D5. |
| `require`/`skip`, per-method selection, CLI `--report`/`--skip-report`/labels/`skipAllReports` | **Gap.** Later `Submit.reports: optionalKey({ only?, skip?, labels?, none? })`, included in the submission fingerprint and applied when the plan is snapshotted. |
| Error artifact for failed/missing report | Slice 1: the failed report run is the durable error receipt. A missing report is a load-time `DefinitionError`, which is stronger than Swamp's run-time failure. |
| Paired Markdown/JSON persistence with lifetime/GC | Slice 1: one run result with no pruning. Lake publication with retention is author-optional. A host default retention is D6. |
| Report discovery (`report search/describe/get`) | Slice 1: `report list/get` per source run. Catalogue search over report definitions is deferred. |
| Skip reasons in workflow source | **Gap** (B7). |

## 7. Public boundaries [Proposal]

RPC, reusing `Cursor`, `PageLimit`, `OperationError` codes and the existing `Run` reply:

```ts
Rpc.make("RunReports", {
  payload: {
    runId: Id,
    cursor: optionalKey(Cursor),
    limit: optionalKey(PageLimit),
  },
  success: Schema.Struct({
    cursor: NullOr(Cursor),
    snapshot: Int,
    items: Array(
      Schema.Struct({
        attachmentId: String,
        scope: Literals(["run", "invocation"]),
        path: NullOr(Array(String)),
        reportTaskId: String,
        reportTaskVersion: Int,
        state: Literals(["Armed", "Ready", "Admitted", "Skipped", "Failed"]),
        reportRunId: NullOr(String),
        reportStatus: NullOr(RunStatus),
        detail: NullOr(Json),
      })
    ).check(isMaxLength(200)),
  }),
  error: OperationError,
});
```

- The report body is retrieved with existing `RunGet(reportRunId)`.
- A `SystemHello` capability `reports/v1` gates the new CLI commands against old daemons.

CLI:

- `effectory report list <runId> [--wait] [--json]`
- `effectory report get <runId> <attachmentId> [--path <json>] [--format markdown|json] [--output <file>]`
- `workflow run … [--reports wait] [--fail-on-report-failure]`

Terminal Markdown output must replace characters matched by the existing `unsafe` class (`packages/cli/src/progress-format.ts:4`, `\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}`), keeping `\n`/`\t`. `--output` writes the exact UTF-8 text. `--format json` writes the encoded result.

## 8. User decisions

- **D1.** Default `on`: all terminal statuses (recommended), or Swamp's behaviour of no report on cancel.
- **D2.** Whether report runs appear in default `run list` (recommended: hidden unless `--origin report|all`) or are always visible.
- **D3.** Foreground behaviour: never wait (recommended default), with an opt-in `--reports wait` and an opt-in failure exit code.
- **D4.** Fan-out policy: the report budget (32 recommended) and the per-run obligation cap and receipt.
- **D5.** Whether to ship a built-in summary report, and whether it is on by default. It costs one run per source run.
- **D6.** Whether report results get a host retention policy, or follow run history (no pruning today).
- **D7.** Whether to add a `Report.task(spec, handler)` sugar that fixes `input`/`success`. Recommended: not in slice 1, because the probes show no inference gap.
- **D8.** Whether report runs inherit the source's run tags. Recommended: yes, as an encoded snapshot, without re-validating against workflow tag schemas.
- **D9.** How to bound the source payload: copy up to 256 KiB with `truncated`, or always reference the source through `History`.

## 9. Proof gates

1. **Types.**
   - Constructor → `.provide` → attach → `Application.make` → `.provide` leaves exactly the application services, with `Report.History` removed after B1. This is the inverse of today's probe.
   - Mixed attachment arrays.
   - Typed `sourceOf` inference.
   - The three negative attachments.
   - An extension-contributed generic report referenced via `X.tasks.*`.
   - Invalid payloads rejected at load: non-canonical spec, wrong source schema instance, unbranded result, duplicate id, invocation scope on a workflow.
2. **Once per invocation.**
   - Retry on attempt 1, succeed on attempt 2: one obligation, one report run whose `source.status` is `Succeeded`.
   - Per-attempt counts are visible only through history.
3. **Fan-out and branches.** `forEach` of N items gives N distinct paths and N reports. An unselected branch gives none. Patch nodes are reported under `$patch` paths. An extension implementation of the contract is still reported.
4. **Crash matrix.** Run in a real daemon, killing the process at each point: before and after the leaf Activity result; before and after the write-ahead `completeInvocation`; before and after root `project()`; before, during and after promotion; during the report attempt; after the report's terminal projection. Pass criteria: exactly one obligation and at most one report run per key, and every obligation reaches a terminal row.
5. **Interrupt poll.** A cancelled source with an in-flight leaf: the `Armed` row resolves to `Cancelled` through `leafExecution.poll` (the [Untested] assumption above).
6. **Caps and drain.** Admission at the user cap and during drain leaves rows `Ready` and promotes them after restart. A 1000-item fan-out does not prevent a user `run submit` from being admitted, and normal tasks still progress (fairness under the global semaphore).
7. **Report attempt lifetimes.** For a report task with application and task-local Layers, check acquisition and release counts per attempt and finalizer order (publications close before Layer release, and the tracker stays open through final encoding). Two concurrent report runs must be isolated. Check retry on a report domain error.
8. **Secrets.** Revealing a vault secret and then putting it in Markdown, in `data`, in a domain error or in a progress message is refused or scrubbed, using the same assertions as the vault task tests.
9. **Real CLI flow.** Submit a workflow; `report list --wait`; `report get --format markdown` with control characters in the Markdown, which must be neutralized; `--output` byte-exact; a failing report shows a `Failed` report run while the source exit code is unchanged; restart while a report is `Ready`; a reclaimed source artifact referenced in report data.
10. **Compatibility.** An old CLI decoding a `Run` that carries `report`. A new CLI against a daemon without `reports/v1`.
11. **Shutdown order.** The promoter fiber is interrupted before the HostStore, Lake and engine connections close. Check this with a finalizer-order test in the daemon Layer graph.

## Probe evidence

All probes ran outside the checkout, in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/28d863be-8e63-4b38-860a-2162ade9c8b8/scratchpad/reports-probe/`, against pinned `effect@4.0.5` (symlinked from the repo's `node_modules`). They used no credentials and no network.

- `report.ts`, `consumer.ts` and `negative.ts`:
  - `tsc -p tsconfig.json` reports zero diagnostics.
  - A sanity file asserting the opposite of `remaining` failed with TS2322, which confirms these files are actually type-checked.
- `savepoint.mts` (bun, temporary SQLite file, deleted afterwards):
  - Naive nested admission rolled back the terminal projection.
  - Separately retried promotion left the obligation `Ready` at the cap and `Admitted` after the cap cleared.
  - A second connection's write inside the transaction failed with `database is locked`.
- The full repository suite was not run, per instructions. No production or draft files were edited.
