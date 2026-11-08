# Post-run reports: consumer design review, round 1

Status: independent consumer critique of [run-reports-research.md](run-reports-research.md) for parent consolidation. **Not user approval. No API is approved and no implementation is authorized.** No production, draft or test files were changed.

Evidence labels:

- **[tested]**: a probe was typechecked or executed outside the checkout.
- **[source-read]**: read in this repository or in `vendor/swamp`, but not executed.
- **[inferred]**: a design conclusion or an unverified reading.

## 1. Verdict

1. **Keep the second-argument Effect handler, but not as a new engine.** `Report.make(spec, handler)` earns its place only as a typed specialization of `Task.make`. Its result should be an ordinary registered task definition with a fixed input (`Report.SourceRef`), a fixed success shape (`{ markdown, data }`), `replay: "idempotent"` and a brand. A separate report definition kind with its own context, executor, retry policy and secret checks would duplicate the leaf task engine for no consumer gain.
2. **Keep the source as an Effect service, provided by the host.** Model `Report.Source` on `Tag.Values` and `ArtifactStorage`, which `Task.make` already removes from requirements. A probe shows that without that exclusion, the host service leaks into the public `Application` requirement type (§3).
3. **Attach reporter contracts, not reporter implementations.** Attachments refer to reporter contracts, in the same way graph task nodes refer to task contracts. Implementations are registered like other tasks or contributed by extensions. Reports therefore follow a contract when an extension implementation replaces it, extension facades work without importing handlers, and requirement inference stays where it is today.
4. **Execute reports as durable leaf invocations in a companion run.** Admit that run atomically with the source run's terminal projection. This reuses `leafExecution` for idempotency, retries, permits, logs, the secret guard and pinned-revision lookup. Reports never change the source run's status or the foreground exit code by default.
5. **Make the built-in summary a read-time view, not a stored report.** It needs no obligation, cannot fail durably, works for historical runs and does not create a report run for each fan-out node.

The first slice can be honest without reducing parity to a formatter. It should cover root task runs, root workflow runs and task nodes inside workflows, including nodes in `forEach`, branches and patches. Child-workflow-node scope, label selection and skip selection, submission-time filters and model-instance scope stay **explicitly listed gaps** (§9).

## 2. Swamp behaviour traced through callers

### 2.1 When reports run and what failure does to the exit code

| Caller | When reports run | Effect of a report failure | Evidence |
| --- | --- | --- | --- |
| `swamp model method run`, method **succeeded** | Inline, after the output is saved. Method scope, then model scope. The foreground awaits both. | `reportFailures > 0` sets the view `status: "failed"`. The renderer sets `_failed`, and the command sets `Deno.exitCode = 1`, locally and over `--server`. **A report failure fails the CLI even though the method succeeded.** A missing required report counts as a failure. | [source-read] `src/libswamp/models/run.ts:1744-1902`; `src/presentation/renderers/model_method_run.ts:179-188,357`; `src/cli/commands/model_method_run.ts:948-966,1236` |
| `swamp model method run`, method **failed** | Inline, method scope only. | The exit code is already 1. Report results become events and handles only. | [source-read] `run.ts:1511-1590` |
| Workflow step (method inside a workflow), succeeded or failed | Inline, right after each step. This includes `forEach` items through `varySuffix`. The step and the workflow wait for it. | The summary is discarded. The failed path is wrapped in try/catch. **Step status and workflow exit are unaffected.** | [source-read] `src/domain/workflows/method_report_runner.ts:75-232`; `execution_service.ts:2848-2875,2982-3010` |
| Workflow scope | After `run.complete()` and before the `completed` event. The foreground waits for it. **Skipped on cancel and suspend.** Runs on resume completion. | Wrapped in try/catch. The renderer prints a `Warning` line. The exit code comes from `run.status` only. | [source-read] `workflow_report_runner.ts:117-160`; `execution_service.ts:3995-4033,4930-4962`; `presentation/renderers/workflow_run.ts:687-760,1303-1311` |

Additional notes:

- On the success path, `executeReports` lets errors from lazily loading report bundles propagate. The comment says "load errors propagate so a broken required bundle fails loudly". In a workflow step, the success-path runner has no try/catch, so such an error would probably fail the step. [source-read `report_execution_service.ts:266-284`; step impact inferred]
- Swamp's exit-code behaviour is **inconsistent**: a report failure fails a standalone method run, but not the same method inside a workflow. Effectory should not copy either half implicitly (§5.3).

### 2.2 Persistence, retrieval and retention in Swamp

- Each report writes a pair of artifacts: `report-<name>[-<vary>]` (Markdown) and `…-json`. Both are owned by the model, or by a `workflow` pseudo-model for workflow scope. They get `lifetime: "30d"` and `garbageCollection: 5`. [source-read `report_execution_service.ts:148-208`]
- When a report throws, Swamp persists an error-report pair on a best-effort basis. [source-read `:431-475`, `builtin/report_error_report.ts`]
- Empty Markdown is not persisted, so the previous version stays "latest". `report get` by model/workflow and name can therefore return a report from an **older run**. [source-read `:381-401`; `libswamp/reports/get.ts`]
- Retrieval is keyed by owner, report name and optional version. It is **not keyed by run**, and only the last five versions survive. A consumer cannot reliably ask for "the report for run X". Effectory should improve on this rather than copy it. [source-read; inferred conclusion]
- Swamp's workflow context loads every step execution into one value, with unbounded `dataHandles`. [source-read `report_context.ts:118-144`]

## 3. Effectory boundaries that shape the design

- **Leaf task execution is already a durable, idempotent workflow.** `leafExecution = Workflow.make("EffectoryTask/v1", { idempotencyKey: ({runId,nodeId}) => canonical([runId,nodeId]) })`. Attempts are `Activity`s and the retry loop runs inside the workflow. The task is resolved from `catalog.get(run.revision)`. [source-read `packages/platform-bun/src/interpreter.ts:148-365`] A logical invocation outcome therefore already exists, after retries, keyed by `(runId,nodeId)`.
- **Terminal projection is a single bun:sqlite transaction** in `HostStore.project`. The same database already holds a durable `host_outbox` with `intentKey UNIQUE` and acknowledgement. [source-read `host-store.ts:216-220,1222-1246`; `runner.ts:17-58,83-120`]
- The workflow engine uses a **separate SqliteClient connection** to the same `state.sqlite`. [source-read `engine.ts`, `host.ts:19-22`, `daemon.ts:108`] A leaf's completion therefore cannot share a transaction with host-store rows. [inferred] Admitting a report per node at node completion would need a reconciler. Admitting at root terminal can use the existing transaction.
- **Run outputs are read from engine results**, paged at 200 items or 2 MiB. Host invocation records hold no results. [source-read `run-outputs.ts`] Values cross a 1 MiB JSON boundary. [source-read `json-budget.ts`]
- **`Task.make` removes host-provided services from `R`** (`Exclude<R, Tag.Values | ArtifactStorage>`), and checks encoded success and error values with `VaultTracker.checkSerialized`. [source-read `task.ts:459-506`]
- **`Application.make` takes requirements only from `tasks` and the extensions' tasks.** It rejects graph task nodes whose contract is missing or noncanonical. [source-read `application.ts:149-235`] **Extension facades expose contracts without handlers** (`Extension.installed`). [source-read `extension.ts:118-156`]
- **Run history has no pruning path today.** No `DELETE FROM host_runs` exists. [source-read; inferred: run records are kept indefinitely and included in backups]
- **CLI exit codes:** 0 when `Succeeded`, 1 for other terminal states, 4 for needs-attention or waiting, 2 for invalid validation. [source-read `packages/cli/src/main.ts:232-278,351`]

### Probe [tested]

The probe is at `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/abf4f09a-32b4-4181-a2b7-12e751ecf398/scratchpad/probe/probe.ts`. It imports the real `task.ts` and `application.ts` and typechecks with the repository's `tsc`, which exits 0. It defines a reporter with plain `Task.make`, a stand-in `ReportSource` service and a user `Pricing` service. Results:

- The task requirement is exactly `ReportSource | Pricing`.
- `Application.make({ tasks: [reporter] })` requires `ReportSource | Pricing`. After `.provide(Layer.succeed(Pricing, …))` the application **still requires `ReportSource`**. This is the leak described in blocker B1.
- `reporter.provide(Layer.mergeAll(Pricing fake, ReportSource fixture))` leaves `never`. Running `Task.test` on it with `bun` printed `{"value":{"markdown":"# acme/deploy: Failed","data":{"nodes":1,"cost":3}}}`.

The task route therefore already gives type inference, Layer substitution and test execution. What it lacks is the host-service exclusion and a brand.

## 4. Critique of the two candidate shapes

| Concern | A: `Report.make` as a new kind with its own executor | B: ordinary task reporters with thin attachments (recommended, with a `Report.make` helper) |
| --- | --- | --- |
| Handler shape | Second-argument Effect handler. Good. | The same handler. `Report.make` just calls `Task.make`. |
| Requirements and Layers | Needs a new `Requirements<>` path in `Application.make` and in `Extension.Requirements`. | Already flows through `tasks` and extension tasks. The only change is excluding `Report.Source`. [tested] |
| Retry, attempts, timeouts, permits, logs, secret guard | Must be rebuilt or bridged. | Reused through `leafExecution`. |
| Extension reports | Needs new extension record kinds, facade generation and selection. | Extension `tasks` already export contracts and implementations. |
| Test substitution | Needs a new test helper. | `Task.test(reporter.provide(fixtureLayer), …)`. [tested] |
| Visible operations | Needs a separate operation surface. | Run, logs, events, cancel and watch already exist. |
| Risk | A second task engine. | A reporter could be misused as a graph node. The brand plus Application validation fixes that (B2). |

The provisional design is right about the handler and about using a DI source rather than a callback context bag. It is wrong if `Report.make` produces anything other than a task definition. An application-level "report source" callback bag would also be wrong: it is untestable through Layers and invites loading unbounded history.

## 5. Recommended consumer contract

All names below are proposals. The SDK stand-ins were typechecked in the probe only for the parts marked [tested]. Everything else is [inferred].

### 5.1 Definition, attachment, Layers, override, test and extension

```ts
import {
  Application,
  Extension,
  Report,
  Task,
  Workflow,
} from "@offtree/effectory-sdk";
import { Context, Effect, Layer, Schema } from "effect";

import { ReleaseTools } from "./effectory.extensions.ts";

// User services
class Pricing extends Context.Service<Pricing, { readonly rate: number }>()(
  "acme/Pricing"
) {}
class Changelog extends Context.Service<
  Changelog,
  {
    readonly since: (revision: string) => Effect.Effect<readonly string[]>;
  }
>()("acme/Changelog") {}

// 1. Reporter: Report.make(spec, handler) returns a branded Task.Definition
//    input   = Report.SourceRef       (fixed)
//    success = Report.Result(data)    = { markdown: string, data: D }
//    replay  = "idempotent"           (fixed; reporters may not declare reports)
const CostData = Schema.Struct({
  tasks: Schema.Int,
  failed: Schema.Int,
  cost: Schema.Number,
});
export const CostReport = Report.make(
  {
    id: "acme/cost-report",
    version: 1,
    data: CostData,
    error: Schema.Never,
    description: "Per-run task cost",
  },
  (source) =>
    Effect.gen(function* () {
      const history = yield* Report.Source; // host-provided, excluded from R
      const pricing = yield* Pricing;
      let tasks = 0,
        failed = 0,
        cursor: string | null = null;
      do {
        // paged, bounded; never "all history"
        const page = yield* history.nodes({ cursor, limit: 200 });
        tasks += page.items.length;
        failed += page.items.filter((n) => n.status === "Failed").length;
        cursor = page.cursor;
      } while (cursor !== null);
      const cost = tasks * pricing.rate;
      return {
        markdown: `# ${source.targetId}: ${source.outcome}\n\n${tasks} tasks, ${failed} failed, $${cost}`,
        data: { tasks, failed, cost },
      };
    })
);
// CostReport : Report.Definition<…, Pricing>   (a Task.Definition with brand "Report")

const DeployNotes = Report.make(
  {
    id: "acme/deploy-notes",
    version: 1,
    data: Schema.Struct({ lines: Schema.Int }),
    error: Schema.Never,
  },
  (source) =>
    Effect.gen(function* () {
      const changelog = yield* Changelog;
      const node = yield* (yield* Report.Source).node; // node scope only; fails with a typed error at run scope
      const lines = yield* changelog.since(source.revision);
      return {
        markdown: `## ${node.nodePath}: ${node.status}\n${lines.join("\n")}`,
        data: { lines: lines.length },
      };
    })
);

// 2. Attachment by contract (contract-level default: root task runs AND every graph node using it)
const Deploy = Task.make(
  {
    id: "acme/deploy",
    version: 1,
    input: Schema.String,
    success: Schema.String,
    error: Schema.Never,
    replay: "manual",
    reports: [DeployNotes],
  }, // stores DeployNotes' contract
  (target) => Effect.succeed(`deployed ${target}`)
);

const Release = Workflow.make(
  {
    id: "acme/release",
    version: 1,
    input: Schema.Array(Schema.String),
    success: Schema.Array(Schema.String),
    error: Schema.Never,
    reports: [CostReport, ReleaseTools.tasks.ReleaseDigest],
  }, // workflow (run) scope
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const targets = yield* graph.input(Schema.Array(Schema.String));
    return yield* graph.forEach(
      "each",
      targets,
      {
        item: Schema.String,
        success: Schema.String,
        key: (t) => t,
        concurrency: 4,
        maxItems: 100,
      },
      (target) =>
        graph.task("deploy", Deploy, target, {
          reports: [ReleaseTools.tasks.NodeAudit],
        })
    ); // consumer addition for this node only
  })
);

// 3. Registration and two dependency Layers; task-local override
export default Application.make({
  tasks: [
    Deploy,
    CostReport,
    DeployNotes.provide(Layer.succeed(Changelog, stagingChangelog)), // task-local override
  ],
  workflows: [Release],
  extensions: [Extension.use(ReleaseTools)], // contributes ReleaseDigest/NodeAudit implementations + their R
}).provide(Layer.mergeAll(PricingLive, ReleaseTools.exports.ReleaseClientLive));
// Application requirement: never. Report.Source is host-provided (blocker B1).

// 4. Test substitution (no daemon)
const fixture = Report.Source.fixture({
  // Layer<Report.Source>
  run: {
    runId: "r1",
    targetId: "acme/release",
    revision: "rev",
    outcome: "Failed",
  },
  nodes: [{ nodePath: "each/[a]/deploy", status: "Failed" }],
});
const outcome = Task.test(
  CostReport.provide(
    Layer.mergeAll(fixture, Layer.succeed(Pricing, { rate: 2 }))
  ),
  { input: Report.sourceRef(fixture) }
);
```

Extension side (no new extension kind):

```ts
export const ReleaseTools = Extension.make({
  id: "release-tools", version: "1.2.0",
  tasks: { ReleaseDigest: Report.make({ … }, handler), NodeAudit: Report.make({ … }, handler) },
});
```

The generated facade exposes `ReleaseTools.tasks.ReleaseDigest` as a reporter **contract** that carries the `Report` brand in its spec. An extension can also attach its own reporters to its own task contracts through `reports`, and those reports apply wherever the contract is used. **An exported reporter does nothing until the consumer attaches it.** Exports are never auto-selected. This matches the research brief's warning.

### 5.2 Validation rules for `Application.make` [inferred]

- Every attached reporter contract must resolve to a registered implementation that is branded `Report` and canonical, with identical spec identity. Otherwise the error is `Missing or noncanonical reporter: <id>`. In Swamp, a "required report not found" is a runtime failure; here it becomes a build-time `DefinitionError`.
- A reporter may not declare `reports`, so there is no recursion. A reporter may not appear as a graph task node. `TaskRun` refuses reporter targets: reporters run only through report admission or `ReportRetry`.
- Duplicate reporter ids on one target collapse by identity, or are rejected (an open decision). The cap is 16 reporters per target, plus a node-scope admission budget per run (§5.5).
- When an extension implementation replaces a graph task's contract, contract-level reports still apply because they belong to the contract. The source identity records the `providerId` that actually ran.

### 5.3 Trigger and scope

| Source | Scope value | Triggers | Not triggered |
| --- | --- | --- | --- |
| Root task run (`TaskRun`) | `run` | Contract `reports` | — |
| Root workflow run | `run` | Workflow `spec.reports` | — |
| Task node inside a workflow, including `forEach` items, branches and patch graphs | `node` (with `nodePath`) | Contract `reports` plus that node's `reports` option | Nodes never invoked (inactive branch, unreached after failure, cancelled before start) |
| Child workflow node | `node` | **Full scope, deferred**: child `spec.reports` | Slice gap |

- **Logical invocation, not per attempt.** A node report runs once on the leaf workflow's final outcome, after retries. Attempt counts appear in the source data. Per-attempt reports are out of scope, and Swamp has none either.
- **Every terminal outcome triggers reports:** `Succeeded`, `Failed`, `Rejected`, `TimedOut` and `Cancelled`. This deliberately goes beyond Swamp, which skips workflow reports on cancel. Operators need a report most after a failure or cancellation. `NeedsAttention` is not terminal, so reports wait until it is resolved.
- **Timing in the slice:** all obligations for a source run, including node-scope ones, are admitted at the **root terminal projection**. This keeps one atomic admission point, keeps reports off the critical path and avoids a cross-connection reconciler. The cost is that a node report inside a long-waiting workflow appears only at the end. Incremental node admission while the run is still going is **future scope** and needs a reconciler over `host_invocations` and leaf polling.
- **Uncertain manual effects:** reporters are forced to be idempotent, so a crash mid-report simply re-executes. A source node that ended in `NeedsAttention` because of an uncertain manual effect is reported with that status once the run becomes terminal.

### 5.4 Execution, durability and lifetime [inferred, grounded in §3]

1. `HostStore.project(runId, terminal)` checks that the pinned revision declares at least one attachment. In the same transaction it inserts `host_outbox(kind = "Report", intentKey = "report/<runId>/1")`. A crash on either side of the transaction leaves either no terminal state or a durable intent.
2. The outbox dispatcher, which is the existing daemon-owned loop and uses no detached fibers, creates a **companion report run** idempotently by intent key. Its `revision` is the source revision, so pinned reporters load from `catalog.get(revision)`. It then executes `EffectoryReports/v1`, a small durable workflow, and acknowledges the intent only after the companion run is accepted.
3. `EffectoryReports/v1` enumerates obligations page by page. Each page is an Activity result kept under the 1 MiB budget. It calls the **existing `leafExecution`** for each obligation with `nodeId = "report/<scope|$run>/<reporterId>"`, inside an all-settled `Effect.forEach` that has a dedicated report permit for fairness. Idempotency, retries, logs, attempts and the secret guard are all reused, so this is an orchestrator, not a second task engine.
4. The interpreter provides `Report.Source` only to leaf invocations of report runs. It is a scoped, read-only service bound to the source `runId` that delegates to the existing paged history reads. Its per-invocation Scope closes before the leaf result is encoded and checked by `VaultTracker`, which Task.make already does on success and error values. Shutdown and drain treat companion runs like any other run.
5. Crash cases:
   - **Before the source terminal:** no obligation exists.
   - **After the terminal, before dispatch:** the outbox redelivers.
   - **Mid-report:** the engine resumes, and leaf idempotency on `(runId, nodeId)` prevents a duplicate durable result.
   - **After the result, before acknowledgement:** redelivery finds the existing companion run by intent key.

### 5.5 Source data and size

`Report.Source` offers only bounded operations:

| Operation | Returns |
| --- | --- |
| `run` | Identity: `runId`, `kind`, `targetId`, `revision`, `outcome`, `acceptedAt`/`settledAt`, tags, `schedule`, and the root result or error, which is already secret-checked. |
| `node` | Node scope only: `nodePath`, `taskId`, `providerId`, `status`, attempts, result or error, and artifact **references**. |
| `nodes({ cursor, limit ≤ 200 })` | Declared graph nodes from the pinned graph joined with invocations, including `NotStarted` and `Skipped` with a reason. |
| `outputs({ cursor, limit })` | The `RunOutputs` page contract, capped at 2 MiB. |

- There is no artifact-content reader. Reporters receive references only. A general reader would need its own reviewed design.
- Raw node inputs are excluded from the slice, pending a user decision (D5).
- The admission budget is 2,000 node-scope obligations per source run. Beyond that, the excess obligations are recorded as `Deferred(LimitExceeded)` receipts instead of being dropped silently. An operator can run them with `report retry --deferred`. That command is paged, so the operator can still proceed.

### 5.6 Storage, retrieval and retention

- **One structured record per report**: the reporter's success value `{ markdown, data }` is stored as its leaf result. There is no paired publication and therefore no partial-pair recovery problem. The 1 MiB JSON budget applies. Large attachments are ordinary task outputs, which a reporter declares and publishes to the lake. This uses the existing lake, not a second content store.
- **Failures are durable receipts**: the leaf failure (category plus decoded error) is the failure record. Effectory does not synthesize a fake "error report" Markdown the way Swamp does.
- **Empty Markdown** means `NotApplicable`. It is recorded, not skipped. Unlike Swamp, it never leaves a stale "latest" in place.
- **Retention**: a report lives exactly as long as its companion run, which lives as long as the source run. Run history is not pruned today. When run retention is designed, the companion run must cascade with its source.
- **Reclaimed content**: reports hold references to source artifacts. Reclaimed content shows up as the existing `ContentUnavailable` error on `lake get`. A reporter that reads source outputs gets per-item `ContentUnavailable` and decides how to describe it.
- **Identity**: `(sourceRunId, scope, nodePath|null, reporterId, generation)`. The reporter version and `providerId` are recorded.
- **Terminal output**: Markdown goes to stdout raw only when stdout is not a TTY. On a TTY, C0/C1 controls other than `\n` and `\t` are escaped. `--output <file>` writes the raw bytes.

### 5.7 Built-in summary

`effectory run summary <runId> [--json]` (RPC `RunSummary`) is computed at read time from the run record, paged outputs and the report index. It shows counts by status, the first 50 failures with their node paths and errors, artifact references and report statuses. It needs no storage, no obligation and no attachment, so every run has one, including historical runs. This covers Swamp's `@swamp/workflow-summary` and `@swamp/method-summary` without one report run per fan-out node.

## 6. Exact CLI and RPC outline

### RPC

All requests use existing `OperationError` codes, `Cursor`/`PageLimit` and the `snapshot` pagination pattern.

```ts
ReportStatus = Literals(["Pending","Running","Succeeded","NotApplicable","Failed","Cancelled","Deferred"])
ReportSummary = Struct({
  sourceRunId: Id, scope: Literals(["run","node"]), nodePath: NullOr(String),
  reporterId: Id, reporterVersion: Int, providerId: NullOr(String), revision: Id,
  generation: Int, reportRunId: NullOr(Id), status: ReportStatus,
  error: NullOr(Json), settledAt: NullOr(String), markdownBytes: NullOr(Int) })

ReportList  { runId, nodePath?, status?, cursor?, limit? }                    -> { items: ReportSummary[≤200], cursor, snapshot }
ReportGet   { runId, reporterId, nodePath?, generation? }                     -> ReportSummary & { markdown: NullOr(String), data: NullOr(Json) }   // ≤2 MiB else LimitExceeded
ReportRetry { runId, requestKey, reporterId?, nodePath?, include?: Literals(["failed","deferred","all"]) }
                                                                              -> { reportRunId, requestKey, generation, admitted: Int, acceptedAt }  // Conflict on key reuse with a different fingerprint
RunSummary  { runId }                                                         -> { markdown: String, data: RunSummaryData }
Run (existing) + reports: optionalKey(Struct({ status: Literals(["None","Pending","Settled"]), failed: Int, latestReportRunId: NullOr(Id) }))
```

Waiting needs no new RPC. It uses `RunWatch` and `RunGet` on `latestReportRunId`.

### CLI

```text
effectory report list  --run <id> [--node <path>] [--status <s>] [--limit n] [--cursor c]
effectory report get   --run <id> --reporter <id> [--node <path>] [--generation n] [--data | --json] [--output file]
effectory report wait  --run <id>                          # exit 0 all Succeeded/NotApplicable; 1 any Failed/Cancelled/Deferred; 4 attention
effectory report retry --run <id> [--reporter id] [--node path] [--failed | --deferred | --all] [--request-key k]
effectory run summary  <id> [--json]
effectory workflow|task run …  [--wait-reports]
```

- **Default foreground behaviour:** the command waits for the source to reach terminal. On stderr it prints `Reports pending: effectory report wait --run <id>`. The exit code comes from the **source only**.
- **With `--wait-reports`:** the command also waits for the companion run. The exit code is still the source's, unless the source succeeded and reports failed. That case needs a new code (D1).
- `task describe` and `workflow describe` list attached reporters. `task list` marks reporter tasks.

## 7. Blockers and smallest fixes

| # | Blocker | Smallest fix |
| --- | --- | --- |
| B1 | A host-provided `Report.Source` leaks into `Application` requirements. [tested] | Add `Report.Source` to the host exclusion set in `Task.make`, `Task.implementation` and `provide`, next to `Tag.Values` and `ArtifactStorage`. Only `Report.make` should be able to _depend_ on it legitimately. |
| B2 | Once B1 is in place, any task could `yield* Report.Source` and fail at runtime as a graph node. | Brand the definitions `Report.make` returns. Reject unbranded tasks that use the source, at runtime with a `TaskRuntimeError`. Reject branded tasks used as graph nodes or `TaskRun` targets, through Application validation. |
| B3 | Adding `"report"` to `Run.kind` breaks old clients that decode `Schema.Literals(["task","workflow"])`. [inferred] | `RunList` omits report runs unless `kind: "report"` is requested or the `SystemHello` capability is advertised. `RunGet` on a report run requires the capability. |
| B4 | Engine and host store use separate connections, so per-node admission cannot be atomic. [source-read] | The slice admits only at the root terminal transaction. Per-node incremental admission is future work with a reconciler. |
| B5 | Contracts currently cannot carry reporter references. | Add `reports?: readonly Task.Contract[]` to `Task.Spec`, `Workflow.Spec` and `TaskOptions`, storing contracts only. Spec canonicalization must include reporter ids and versions so the revision pins them. |
| B6 | No all-settled semantics for report obligations. | Use `Effect.forEach(…, { concurrency: permit })` over `Effect.exit` in `EffectoryReports/v1`. Do not reuse graph fail-fast semantics. |

## 8. User decisions

- **D1. Foreground exit when reports fail.** Recommended: the exit code always comes from the source. Add `--wait-reports` with a distinct code, for example 3, for "source succeeded, reports failed". Swamp's standalone method run exits 1 instead, and its workflow run ignores report failures.
- **D2. Report runs in default `run list`.** Recommended: hide them unless requested, given B3.
- **D3. Node-scope report timing.** Recommended for the slice: run them at root terminal. Incremental admission is future work.
- **D4. Should reporters run on `Cancelled` and `TimedOut` sources?** Recommended: yes, which deliberately departs from Swamp.
- **D5. Should `Report.Source` expose node inputs and the root input?** Recommended: root input only, because inputs are not secret-guarded at submission today.
- **D6. Duplicate reporter attachments on one target.** Recommended: collapse them by identity.
- **D7. Retry revision.** Recommended: always use the source's pinned revision. Retrying against the current revision is future work.

## 9. Full scope versus the justified slice

**Slice:**

- `Report.make` (branded task), `Report.Source`, `Report.SourceRef`/`Result`, `Report.Source.fixture`.
- `reports` on task and workflow specs and on the task-node option.
- Root run and task-node scope, admitted at root terminal.
- The companion run with `EffectoryReports/v1` over `leafExecution`.
- `ReportList`, `ReportGet`, `ReportRetry`, `RunSummary` and the `Run.reports` field.
- The `report` CLI, `run summary` and `--wait-reports`.
- Extension reporters through ordinary `tasks`.

**Explicit gaps against Swamp and the full goal:**

- Child-workflow-node scope.
- Label metadata with CLI `--report`, `--report-label`, `--skip-report` and `--skip-reports`.
- Require/skip selection per definition, including node-level removal of contract reports.
- Model-instance scope, which has no Effectory counterpart.
- Incremental admission per node.
- Searching reports across runs (`report search` by reporter or status).
- Retention and cascade policy once run pruning exists.
- An artifact-content reader for reporters.
- Retrying against the current revision.
- Per-attempt reports, which Swamp also lacks.

## 10. Additional proof gates

- **Typing:** a type test that `Application` and extension requirements never contain `Report.Source`, and still contain the user services, through `.provide` and through a mix of reporters and tasks (extending the probe).
- **Swamp contrast:** a fixture where the source succeeds and a report fails, checking that the exit code stays 0 without `--wait-reports`.
- **Restart:** kill the daemon between `project` and acknowledgement, and during a reporter attempt. Expect exactly one companion run and one result for each obligation.
- **Fan-out:** 100 `forEach` items each carrying a node reporter. Expect bounded `Activity` page sizes and `Deferred` beyond the budget.
- **Recovery:** `report retry --deferred` completes the deferred obligations.
- **Cancellation:** cancelling the source produces run-scope reports with `outcome: "Cancelled"`. Nodes that never started get no node-scope reports.
- **Terminal safety:** escaping on a TTY versus raw output to `--output`.
- **Secrets:** a reporter that reads a vault value and echoes it fails through `VaultTracker`, and no Markdown is persisted.
