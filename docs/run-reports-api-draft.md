# Run reports — consolidated contract, revision 2

Status: **user-approved and implemented on 2026-11-06**. This folds the conditional presentation corrections from the [Effect review](run-reports-review-effect-round2.md) and [consumer review](run-reports-review-consumer-round2.md) into the original consolidation. The [parent evidence](run-reports-persistence-evidence.md) distinguishes executed probes from design claims. The user approved the consolidated API and defaults after clarifying the purpose of reports. Implementation follows this contract; see the [verification record](run-reports-implementation.md).

## Main decisions proposed for approval

Reports are ordinary tasks. A declarative `Report.make` binds a task to an execution target, just as `WorkflowSchedule.make` binds a schedule to a workflow. There is no second report handler or executor. The report's immutable source identity is task input; paged history reads use an Effect service. Each report gets its own ordinary task run on the source's pinned revision.

Task-invocation reports start after that logical task finishes, even if its parent workflow remains waiting. Root reports start after the root finishes. Neither delays nor changes the source outcome. Reports can run for every final outcome, including cancellation and timeout. An explicit report wait command observes reporting separately.

Report runs remain `kind: "task"` and are visible in ordinary run history, with optional report provenance. No new run-kind literal or client-negotiation protocol is introduced. Report results initially use existing durable run-result storage, which has no pruning today; publishing queryable lake artifacts remains an explicit use of `ArtifactStorage` by the report task. This differs from Swamp's automatic paired lake publications and must be visible in the approval note.

## Authoring

The following is proposed syntax, not an implemented or fully typechecked SDK example:

```ts
import { Application, Report, Task } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

const Deploy = Task.make(
  {
    id: "app/deploy",
    version: 1,
    replay: "idempotent",
    input: Schema.String,
    success: Schema.Struct({ url: Schema.String }),
    error: Schema.Never,
  },
  (name) => Effect.succeed({ url: `https://${name}.example.test` })
);

const Summary = Task.make(
  {
    id: "app/deploy-summary",
    version: 1,
    replay: "idempotent",
    input: Report.sourceOf(Deploy),
    success: Report.result(Schema.Struct({ succeeded: Schema.Boolean })),
    error: Schema.Never,
  },
  (source) =>
    Effect.gen(function* () {
      const history = yield* Report.History;
      const outcome = yield* history.outcome(Deploy);
      return {
        markdown:
          outcome._tag === "Succeeded"
            ? `# Deployment succeeded\n\n${outcome.value.url}`
            : `# ${source.targetId}: ${source.status}`,
        data: { succeeded: outcome._tag === "Succeeded" },
      };
    })
);

export default Application.make({
  tasks: [Deploy, Summary],
  reports: [
    Report.make({
      id: "deployment-summary",
      target: Deploy,
      task: Summary,
      scope: "invocation",
    }),
  ],
});
```

`Report.Source` is the generic source-input schema for reusable reporters. `Report.sourceOf(target)` has the same encoded fields but narrows the target identity, and is memoized/registered against the canonical target spec. It does not copy source input, result or error. The typed history read decodes the persisted outcome with that target's codecs. This avoids a truncation flag or an admission failure when a legal source result is already near the 1 MiB task-input limit.

`Report.result(dataSchema)` is a schema for `{ markdown: string, data: D }`, with a private provenance marker used in attachment validation. Its entire encoded value obeys the existing 1 MiB JSON boundary; Markdown additionally has a 256 KiB UTF-8 limit. Empty Markdown is a successful empty report, never a request to reuse an earlier run's content.

The reporter is a real `Task.Definition`: `.provide`, declared errors, replay mode, outputs and `ArtifactStorage` all behave normally. A reporter using a service from a live client or a renderer keeps that service in the Application requirements. A task-local Layer may read `Report.History`. Runtime requirements supplied by the host are removed from `Task.make`, `Task.implementation` and both `.provide` signatures, including Layer input requirements. The history service must be installed around task-local Layer acquisition as well as the handler.

`Report.make` is an attachment constructor, not the provisional `Report.make(spec, handler)` wrapper. There is no `Report.task` helper in this revision. It accepts:

```ts
{
  id: string;                         // unique attachment ID in the application
  target: Task.Contract | Workflow.Definition;
  task: Task.Contract;                // registered implementation required
  scope: "run" | "invocation";        // required for task targets; workflows allow only "run", defaulted
  on?: readonly Report.Status[];      // default all five terminal outcomes
  execution?: {
    timeout?: string;                 // default "5 minutes"
    attemptTimeout?: string;          // default "30 seconds"
    retry?: { attempts: number; delay: string; when: readonly string[] };
  };
}
```

The constructor and its types reject incompatible target-specific source schemas. `retry.when` uses the reporter's declared error tags, as graph task options do. Construction validates synchronous schema metadata, identifiers and existing finite-positive policy rules. Registry build resolves canonical target/reporter contracts and validates source/result schema provenance. Typed source codecs from another target are not accepted just because their JSON Schema looks similar. A generic `Report.Source` accepts every supported target. `on` is nonempty, has no duplicates, and contains only Succeeded, Failed, Rejected, TimedOut or Cancelled.

`Report.Status` means those five source outcomes, not report lifecycle states. At invocation scope, `on: ["Rejected"]` is accepted, but current task leaves do not themselves reject: a sibling stopped by an approval rejection is Cancelled, with `stoppedBy: "Rejected"`. Root scope can be Rejected. Defaulting to all outcomes remains useful across scopes.

At most 128 attachments per application and 16 matching attachments per target/scope are declared. Duplicate attachment IDs fail; different IDs are distinct reporting obligations even if they name the same task. The runtime never creates report obligations for a report-origin run, so reporting cannot recursively trigger reporting. A reporter remains usable as an ordinary task, but its history service refuses reads outside a report invocation; fabricated input never grants access to another run.

## Registration, extensions and tests

Implementations remain in `Application.make({ tasks })` or selected extension tasks. Only attachment specs go in `Application.make({ reports })`. This preserves requirement inference through the existing task registration mechanism instead of promising that runtime discovery can recover erased types. Targets must also be registered or discovered under the existing linked-workflow rules; attachment alone does not silently register an implementation.

An installed extension exports a report task through its existing `tasks` contribution. The consumer selects `Extension.use(Tools)` and attaches `Tools.tasks.Summary`. No new extension contribution kind or manifest entry is needed. An extension implementation replacing a target task preserves attachments to its contract. An extension may also replace a reporting task through the existing contract/implementation mechanism. Report schema helpers must be host-shared modules, and installed facade/declaration generation must preserve their source/result metadata. A generic extension reporter uses `Report.Source` and `history.outcome()` with JSON values; a typed `outcome(target)` requires importing that target's contract. Publishers declare the contract once and implement `Task.make(Contract.spec, handler)`.

`Report.test(reportTask, { source, outcome, invocations?, events?, tags? })` supplies a bounded in-memory History service and delegates to `Task.test`. It returns the same `{ value, publications, progress }` shape. `source` is typed from the reporter input; raw outcome fixtures are decoded through the requested target when `History.outcome(target)` is read. Fixtures validate lazily with named InvalidBoundary errors and no environment lookup. A fixture is not allowed to claim a different target from its source. Actual storage failures and restart remain daemon tests.

Ordinary `Layer.succeed(Report.History, fake)` remains available. The host default wins over an application-level service; a task-local `.provide` can deliberately override it, including in tests. A fake is author code and can bypass native history constraints. TypeScript accepts some incorrect generic `outcome(target)` fakes without a cast; their target-dependent return types are not fully checked. Document `Report.test` as the supported fixture path.

## Source and History schemas

All are core schemas importing Effect only; runtime RPC schemas reuse or alias them. `Id` uses the existing 200-character boundary. Raw invocation paths are not embedded in report inputs: existing paths can exceed transport budgets. The bounded native invocation execution ID identifies a task source. A preview is for display only.

```ts
Source = {
  runId: Id;                          // original root run
  invocationId: Id | null;            // null for root-run scope
  scope: "run" | "invocation";
  targetKind: "task" | "workflow";
  targetId: Id;
  targetVersion: PositiveInt;
  revision: Id;
  status: "Succeeded" | "Failed" | "Rejected" | "TimedOut" | "Cancelled";
};
PathPreview = { text: string /* <= 2048 code points */, truncated: boolean };
Outcome<V, E> =
  | { _tag: "Succeeded"; value: V }
  | { _tag: "DomainFailure"; error: E }
  | { _tag: "Failure"; category: "Host" | "Defect"; detail: Json }
  | { _tag: "Stopped"; status: "Rejected" | "TimedOut" | "Cancelled"; detail: Json };
```

`SourceIdentity` has the same identity fields as Source but permits `status: null` while reporting waits for settlement. It is a record schema, never the input supplied to the reporting task. `Report.History` is an ordinary `Context.Service`, removed from task requirements and always installed by the runtime, with:

- `outcome(): Effect<Outcome<Json, Json>, TaskRuntimeError>` for the exact source. An overload `outcome(target)` returns decoded target success/domain-error types after checking the canonical source target. Wrong targets fail InvalidBoundary. This operation excludes the potentially huge raw path from its reply and observes the existing JSON budget on each value.
- `invocations({ cursor?, limit? }): Effect<InvocationPage, TaskRuntimeError>` for the source root, with at most 200 items and 2 MiB per page. Items contain bounded invocation ID, task ID/version, provider ID if present, path preview, attempt count and Pending/Suspended/terminal status. They do not contain task result bodies or inputs. No invented Skipped or NotStarted status is derived from the absence of a row.
- `events({ cursor?, limit?, afterSequence? }): Effect<EventPage, TaskRuntimeError>` using the existing event paging limit and errors. An oversized stored event remains an explicit LimitExceeded; this feature does not silently change the event export limit.

The service binds the source principal and run from host provenance, not from untrusted task input. Calls after invocation closure fail InvalidBoundary. Outside reporting, the default service fails with an explanatory InvalidBoundary rather than a missing-service defect. Each attempt gets a fresh service and task memo map. Fixture and native implementations use the same schema boundaries. Errors use existing TaskRuntimeError codes: InvalidBoundary for wrong source/closed invocation/invalid fixtures, LimitExceeded for a reply budget, and Unavailable for storage or native-engine access failure.

The host transports History through private per-attempt metadata on RuntimeContext. `definition()` installs it inside `execute`, beside Tag.Values and ArtifactStorage, around task-local Layer acquisition and the handler. Providing it only outside `task.execute` is incorrect: Application's captured context would win. No History member is added to the handler's task context. Plain Task.test installs the refusing default; Report.test supplies its fixture service through the same path. The interpreter closes the service when the invocation ends, including detached readers. History lives in a separate module to avoid a Task/Report import cycle.

Invocation pages freeze row membership but observe completion status when read. They are not immutable snapshots of sibling outcomes while a workflow is still running. Exact source outcome is terminal and immutable. A report task starts paging again on an attempt retry; it does not persist expiring page cursors between attempts. No artifact-content reader or root/node-input reader is introduced. Report tasks can return references they already know, but cannot assume those artifacts remain retained.

### Type and page contract

These declarations specify the proposed relationships; they are not a claim that the SDK exports them yet. `Target` is Task.Contract or Workflow.Definition. Identity parameters describe a contract, not its implementation wrapper:

```ts
sourceOf<T extends Target>(target: T): SourceOf<
  T["spec"]["id"], T["spec"]["version"], KindOf<T>
>;

make<T extends Target, const S extends Task.Spec>(
  options: {
    readonly id: string;
    readonly target: T;
    readonly task: Task.Contract<S> & NoInfer<Compatible<T, S>>;
    readonly on?: readonly Report.Status[];
    readonly execution?: ExecutionPolicy<S["error"]["Type"]>;
  } & (T extends Workflow.Definition
    ? { readonly scope?: "run" }
    : { readonly scope: "run" | "invocation" })
): Report.Attachment<T, S>;

interface HistoryService {
  outcome(): Effect.Effect<Outcome<Schema.Json, Schema.Json>, TaskRuntimeError>;
  outcome<T extends Target>(target: T): Effect.Effect<
    Outcome<T["spec"]["success"]["Type"], T["spec"]["error"]["Type"]>,
    TaskRuntimeError
  >;
  invocations(options?: PageRequest): Effect.Effect<InvocationPage, TaskRuntimeError>;
  events(options?: PageRequest & { readonly afterSequence?: number }):
    Effect.Effect<EventPage, TaskRuntimeError>;
}
```

`SourceOf<Id, Version, Kind>` is a Schema codec for Source with those identity fields narrowed, carrying private schema provenance. `Compatible` accepts exactly the generic Source or matching sourceOf identity, and requires a recognized result schema. A same-shaped foreign schema is not accepted at registry build. Task target association is memoized by its canonical spec, so a contract, its implementation and its provided wrapper remain compatible. Workflow association uses its canonical definition. A heterogeneous `readonly Report.Attachment[]` is accepted by the new optional `Application.make({ reports })` field; that field adds no service requirements because implementations are already registered through tasks/extensions.

`PageRequest` is `{ cursor?: Cursor; limit?: PageLimit }`. Both page replies are `{ items, cursor: Cursor | null, snapshot: nonnegative integer }`, with up to 200 items. InvocationItem is `{ invocationId: Id, taskId: Id, taskVersion: PositiveInt, providerId: Id | null, pathPreview: PathPreview, attemptCount: nonnegative integer, status }`. Its status uses the existing output statuses Pending, Suspended, Succeeded, Failed, Rejected, TimedOut and Cancelled. EventPage items retain the existing Event fields `{ at: string, payload: Json, runId: string, sequence: integer, tag: string }`; existing event paging limits apply. Core's history shapes must not import runtime modules; runtime can alias shared shapes without changing the wire fields.

`Report.test<S, R>(task: Task.Definition<S, R>, fixtures)` returns an Effect with the same requirements/error channel and `{ value: S["success"]["Type"], publications: readonly Task.TestPublication[], progress: readonly Task.Progress[] }` as Task.test. Fixtures are `{ source: NoInfer<S["input"]["Type"]>, outcome: Outcome<Json, Json>, invocations?: readonly InvocationItem[], events?: readonly Event[], tags?: Tag.Input }`. Outcome values are encoded JSON; typed outcome reads decode them with the canonical target. Fixture source status must agree with its outcome. Arrays are bounded to 10,000 items each; page response budgets still apply. Plain Task.test supplies no report provenance, so History refuses reads unless the author deliberately supplies a task-local fake.

## Trigger, ownership and crash recovery

Run scope covers submitted task and workflow roots. Invocation scope covers logical task invocations, including fan-out items, selected branches, patches, linked-child task nodes and root task runs. It fires after all configured attempts settle, not per attempt. Uninvoked work has no invocation report. Nested workflow boundaries themselves are not yet durable sources, so invocation scope on a workflow target is rejected and remains a named parity gap.

A directly submitted task satisfies both scopes. Attaching the same reporter under two distinct attachment IDs, one per scope, produces two reports for that submission. Task scope is required so this choice is visible. Attaching a reporter is not retroactive: only runs admitted with that pinned attachment plan create automatic reports.

The admission transaction captures the relevant attachment plan from the pinned revision, including schedules' submission path. Root terminal projection creates obligations in that same host transaction, but does not admit report runs there. It also records the terminal failure category (Domain, Host, Defect or Control) with the source facts: existing errorJson retains only detail and cannot distinguish those categories. Typed root outcome reads decode the target's error schema only for Domain. This adds no public Run error field. Invocation registration durably arms its matching obligations before dispatch. A reconciler in the existing runner tick observes each native logical invocation once, irrespective of attachment count, and moves its armed obligations to Ready. It uses a durable pending index, bounded batches and a rotating cursor, including sources whose root is terminal. No author-side bookkeeping write precedes task completion, and no additional reconciliation fiber is needed.

Engine and host use separate SQLite connections. The report reconciler must not pretend Activity completion and host bookkeeping share a transaction. Completed native replies, root status and fence provenance remain retained for as long as any report generation can run or be retried, including after materialization. Future engine cleanup or run pruning must coordinate that lifetime. Current completed replies are retained; recovery was probed through SIGKILL. The full report crash matrix remains an implementation gate.

For invocations, normalize the native Exit using this precedence. Eligibility for a report is a separate step below; no NotApplicable status is added to RunOutputs.

| Native state | Additional facts | Normalized source outcome |
| --- | --- | --- |
| Success | Any | Succeeded with its own value |
| Typed Domain or Host failure | Any | Failed with its own category/detail |
| Typed Control failure | Any | Its own control outcome; a genuine timeout is not overwritten by a later fence |
| Other failure containing a defect | Any | Failed/Defect |
| Interrupt-only | Root not yet terminal | Defer final classification |
| Interrupt-only | Terminal root, fence reason Control/TimedOut | TimedOut |
| Interrupt-only | Terminal root, any other fence row, including null reason | Cancelled, with bounded `detail: { stoppedBy: reason.outcome ?? "RunFailed" }`; do not copy a sibling's error |
| Interrupt-only | Terminal root, no fence row | Failed/Defect; do not relabel self-interruption |
| None or Suspended | Root not terminal | Not final; includes retry backoff and NeedsAttention |
| None | Root terminal | No native result; never execute a task to synthesize one after terminal projection |
| Suspended | Root terminal | Inconsistent/incomplete recovery; keep unresolved and expose an Unavailable error, never invent a result |

Once settlement is final, a non-success invocation with zero admitted attempt rows produces a NotApplicable report with reason NotStarted, including when a deadline refused the first attempt. A terminal root with no native execution produces NotApplicable/NoNativeExecution. Neither runs a reporter. A settled source excluded by the attachment's `on` filter produces NotApplicable/OutcomeExcluded rather than leaving WaitingSource work behind. RunOutputs continues to expose its existing status union and, when there is no native result, Pending; reporting eligibility does not change that schema. For actual completed invocations, History and RunOutputs share the normalized outcome above. This corrects interrupted tasks currently shown as Failed/Defect. An approval-rejected root remains Rejected, while its interrupted sibling task becomes Cancelled with stoppedBy Rejected.

A promoter separately admits an ordinary task run under a private report admission namespace, with a deterministic hash key and a unique obligation/generation constraint. It uses the source principal and pinned revision, and copies the source's encoded tag snapshot. A failed admission leaves an inspectable queued obligation and cannot roll back source completion. Report task input is the bounded Source above; its optional `Run.report` provenance carries report ID, source run/invocation IDs, attachment ID and generation. RunSummary and watch snapshots carry the same optional provenance. The report run is not itself a scheduled occurrence; schedule context is not implicitly copied.

Report runs have a separate active admission budget of four and a daemon-wide limit of four executing report attempts, acquired before a global task permit. Do not use the per-run semaphore map for this daemon-wide limit. Pending obligations consume neither budget. NeedsAttention report runs are excluded from active admission; other unfinished report runs, including Waiting retry backoff and Cancelling, count. Both the normal 1000-run admission query and its active-run health count exclude report-origin rows. SystemStatus exposes separate bounded report counts with an explicit lower-bound flag when capped. Promotion is round-robin across source runs, oldest Ready first within a source. Stalled admitted reports still hold slots until timeout or cancellation.

The five-minute total deadline starts when the report is dispatched and includes subsequent permit waits and retry delays; time spent as an unadmitted obligation does not count. The 30-second attempt timeout follows existing attempt admission semantics. Both policies are stored with report admission and exposed by report get and the Run.report provenance in run get. This is new policy plumbing for root task runs, while execution reuses the ordinary task path. Cancellation, finalizers, durable retries, manual replay/NeedsAttention, logging and vault protection remain ordinary task behavior. Promotion/reconciliation run inside the existing runner tick and stop before their stores and engine close.

There is no silent per-source drop threshold. With 10,000 invoked tasks and 16 matching attachments, a source can produce 160,000 invocation-report obligations, plus any root reports; explicit retries add more generations. Admission stays bounded while persistent history grows. This cost is opt-in through attachments. Represent pending work compactly, derive stable report IDs, and support source-scoped bulk cancellation. Bulk retry is deferred; retries are individual. Full-disk failures remain storage failures, and source execution does not fail merely because report capacity is busy.

All five terminal outcomes can trigger reports by default. NeedsAttention is not final; its obligations stay waiting until the source settles. Cancelling the source does not cancel reports already admitted for earlier completed tasks. Cancel a report independently. A report that is itself in NeedsAttention must be cancelled before retry.

## Results, lifecycle and operators

Each logical report group is `(sourceRunId, invocationId|null, attachmentId)`. Generation starts at 1. Every generation has its own report ID; retries keep the same source and revision and admit a new ordinary task run. Report runs are all-settled by independence: one failed report does not stop its siblings.

`Report.RecordStatus` is WaitingSource | Queued | Running | NeedsAttention | Succeeded | Failed | Cancelled | NotApplicable. WaitingSource has `SourceIdentity.status: null`; Source passed to the task always has a terminal status. Records include `reportRunStatus: RunStatus | null` and `notApplicableReason: "NotStarted" | "NoNativeExecution" | "OutcomeExcluded" | null`. Run-level Rejected/TimedOut map to a Failed report record with their exact run status retained. Waiting, retrying and cancelling execution map to Running at the report-record level; reportRunStatus gives the actual run status. Empty successful Markdown remains Succeeded.

Report success content lives in the report run's existing bounded JSON result. Failure details live in its normal error record. No fake successful Markdown is synthesized for an error. These records follow current unpruned run history. Optional artifacts published by the reporter use normal lake retention; reclaiming them does not remove the report's separate run result. There is no promise that this slice automatically makes report bodies queryable through lake queries or implements Swamp's automatic report retention.

Default task/workflow foreground commands retain their existing completion and exit behavior and do not wait for reports. Human mode prints one best-effort stderr line, `Reports: effectory report list <run-id>`, when the pinned plan has matching attachments, including at an approval stop. A hint failure never masks the source outcome. No `--wait-reports` or new exit code is added. Reporting status is explicit through the following surface:

```text
effectory report list <source-run-id> [--history] [--limit N] [--cursor C]
effectory report get <report-id> [--json | --data] [--output PATH]
effectory report wait <source-run-id>
effectory report wait --report <report-id>
effectory report retry <report-id> [--request-key KEY]
effectory report cancel <report-id> [--reason TEXT] [--request-key KEY]
effectory report cancel --run <source-run-id> [--reason TEXT] [--request-key KEY]
effectory run summary <run-id> [--json]
```

`report list` defaults to the latest generation per group; `--history` includes previous generations. Counts are current, whereas paged membership uses the existing bounded cursor pattern. `report get` defaults to Markdown on success, `--data` emits only structured data, and `--json` emits the entire record and content. Pending/failed reports print metadata and exit 4/1 respectively; output files are created only for successful content. `--output` is exclusive-create, byte-exact UTF-8 and refuses overwrite. Terminal output escapes the same unsafe Unicode classes as live console while keeping newline/tab. Redirected Markdown is raw. `--json`, `--data` and `--output` combinations that would ambiguously select content are rejected; `--data --output` writes data JSON, `--output` alone writes Markdown, `--json --output` is rejected.

`report get` exits 0 for Succeeded or NotApplicable (the latter has no content and creates no file), 1 for Failed or Cancelled, and 4 for WaitingSource, Queued, Running or NeedsAttention. JSON formatting does not change these codes.

`report wait <source-run-id>` first follows the source through execution, timers and retries. It exits 4 only for NeedsAttention or Waiting with an open external approval/input/signal, using the existing foreground predicate and final state recheck. A bare Waiting status is insufficient. Once the source is terminal, it waits until every latest report generation is terminal or NeedsAttention, then exits 4 if any needs attention, otherwise 1 if any Failed/Cancelled, otherwise 0. Explicitly cancelling an unwanted report therefore makes aggregate waiting exit 1 until a later successful generation. It prints a JSON aggregate, not concatenated Markdown. Concurrent explicit retries can extend the wait; it is not a fixed barrier. Zero attached reports succeeds once the source is terminal.

`report wait --report <report-id>` follows that exact generation independently of the source's status, permitting an invocation report to finish while its parent waits for approval. It uses the report get exit table once terminal/NeedsAttention. A WaitingSource report still waits for its own source. Disconnection exits 3 without cancellation; Ctrl-C exits 130. The positional source and --report forms are mutually exclusive.

Retry uses the original source, revision and stored attachment policy. Request keys are scoped to `(principal, groupId)` with fingerprint reportId. Receipt lookup occurs first: an identical replay returns the generation it created at its current status with replayed true; another reportId under that key conflicts. For a new key, only the named latest generation in Succeeded, Failed or Cancelled is retryable. An older ID conflicts and names the latest one; WaitingSource, Queued, Running, NeedsAttention and NotApplicable conflict. Admission and receipt creation are atomic; promotion is separate.

Single-report cancellation serializes with promotion in the host store. WaitingSource cancellation is durable and later source settlement cannot revive it. Queued work is cancelled without execution; admitted work receives ordinary RunCancel with a deterministic key derived from reportId and requestKey. Direct run cancel also projects back to the report record. An already-terminal report returns an idempotent no-op receipt. The receipt is `{ reportId, reportRunId: Id | null, acceptedAt, actor, reason: string | null, requestKey, replayed, status: Report.RecordStatus }`; its status describes acceptance, not current status on replay. Cancellation keys are scoped to principal and reportId; changed reasons under one key conflict.

Bulk `report cancel --run` accepts a durable cancellation of the source's current nonterminal latest generations. The acceptance transaction fixes membership: registered task invocations and the known root obligation, at their current generations. It fences promotion of selected work immediately; cancellation of already-admitted runs proceeds in bounded runner batches and survives restart. The receipt `{ sourceRunId, acceptedAt, actor, reason, requestKey, replayed }` acknowledges acceptance, not completion. Inspect report list/wait for completion. Replaying a key returns the same selection, never a larger one; keys are scoped to principal and sourceRunId, with reason in the fingerprint. Later registered invocations and explicit retries after acceptance are not selected. To stop future source work too, cancel the source first, then cancel its reports. This operation never cancels the source itself.

Mutation receipts, cancellation selections and generations are retained with report history, currently unpruned. Report/group IDs are lowercase SHA-256 hex over versioned canonical tuples: group uses sourceRunId, invocationId|null and attachmentId; report adds generation. They are deterministic across restart, never inferred from a display path.

## Protocol and compatibility

Advertise `reports.v1` in the shared capability list returned by existing SystemHello and SystemStatus. New report commands and explicit `run list --origin` preflight through SystemStatus; no client capability-negotiation extension is proposed. Existing clients decode ordinary task runs and ignore unknown provenance, as verified by the old-schema transport probe. `RunListRequest.origin?: "manual" | "schedule" | "report" | "all"` defaults to all. The CLI mirrors it as `run list --origin` and displays origin. Report runs inherit source tags and therefore appear in tag-filtered listings too. Old clients show them as ordinary tasks without report provenance. The volume cost is an explicit approval choice.

Use existing Id, Cursor, PageLimit and OperationError codes. All new records are Effect schemas with excess-property rejection on requests. Proposed methods:

| RPC | Request | Reply |
| --- | --- | --- |
| RunReports | runId, history? (false), cursor?, limit? | items, cursor, snapshot; sourceTerminal and current aggregate counts |
| ReportGet | reportId | record plus content `{markdown, data}` or null |
| ReportRetry | reportId, requestKey | record of the generation created by the key, replayed |
| ReportCancel | either reportId or sourceRunId; requestKey, reason? | single-report or source-cancellation receipt defined above |
| RunSummarize | runId | markdown and structured summary |

Report record fields: reportId, groupId, generation, attachmentId, source: SourceIdentity, pathPreview|null, reportTaskId/version, reportProviderId|null, reportRunId|null, reportRunStatus|null, execution (resolved policy), status: RecordStatus, notApplicableReason|null, createdAt, settledAt|null, error|null. Identifiers, bounded previews and timestamps avoid unbounded path envelopes. ReportGet is capped at 2 MiB; failures are bounded/sanitized using existing run error rules. RunReports counts each lifecycle status over latest generations, including WaitingSource, regardless of history-page selection. Its aggregate has all eight named nonnegative integer fields plus total, sourceTerminal and observedAt. Counters must be maintained/indexed rather than loading all report bodies. Aggregate wait polls RunReports with limit 1; single wait polls ReportGet.

Task/workflow describe includes applicable attachment IDs, scopes, reporter contracts and execution policies. Task describe identifies recognized report source/result schemas. Standalone report-definition search and submission-time selection remain later work.

## Built-in summary

`run summary` is a read-time view for historical or current runs, requiring no attachment, new run or stored Markdown. It shows the root status, observed invoked-task counts, up to 20 failed task summaries, report aggregate status, and inspection commands. It does not infer unexecuted branch skip reasons. It omits source input and result bodies. RunSummarize returns `{ markdown, data: { runId, observedAt, status, invocations, reports, failures, sampleTruncated } }`. Invocation counts have a field per existing output status plus total. Reports uses the latest-generation aggregate above. Each failure sample contains invocationId, taskId, pathPreview and normalized status, with no result/error body. `sampleTruncated` means more than 20 failures were observed. This reply is not named RunSummary, which already denotes a history-list row. Reading a live run observes changes across pages; it is not advertised as an atomic snapshot. Bound traversal by the existing 10,000-invocation limit and a five-second cooperative budget, failing QueryBudgetExceeded if incomplete rather than printing authoritative partial counts. Large-run latency is a proof gate, not a tested claim.

## Explicit gaps and proof gates

Remaining Swamp gaps: child-workflow boundary reports, configured-model scope/defaults, require/skip/label selection, submission-time overrides, automatic paired lake output and report retention, global report search, artifact-content reads and complete skipped-step reasoning. Reports on invoked tasks inside child workflows are included. The choice of ordinary tasks is not a claim of complete report parity.

Before implementation completion prove type inference, mixed attachments, host requirement exclusion, fake/test behavior and installed extension facade canonicalization; source completion and report admission crash points; invocation reports appearing while a parent waits; domain retry producing one final source report; cancellation mapping and unstarted dispatch recovery; manual report uncertainty; per-generation retry/cancel receipts; capacity/drain isolation and normal-task progress under fan-out; Layer/finalizer/tracker ownership; secret rejection in report Markdown/data/error; old-client decoding; real CLI rendering and output files; large-source and large-history bounds; pinned revision and retained-source recovery. The parent scratch probes establish only current task mechanics and native result survival, not the new contract.

Specific review gates: run-scope Domain versus Host classification; all native/fence table rows including null-reason fences and restart before projection; rejecting a first attempt at its deadline; History provision inside definition with task-local Layer reads and overrides; generation 2 reading the same native result after restart; 16 attachments causing one poll per invocation; bounded runner latency with 1,000 invocations and 16 attachments; fair admission of a second source; 32 NeedsAttention reports not exhausting report capacity; bulk cancellation racing promotion, later invocation registration and retry; receipt replay before active-generation conflicts; source waiting through timers/retries and stopping at external waits; aggregate exit precedence; on-filter exclusion settling; source-specific and generic installed extension reporters; and no extra run after terminal source recovery.

## Consolidation decisions for approval

The two reviews permit these corrections without another full review round. Revision 2 chooses the Effect review's stopped-sibling mapping (Cancelled with stoppedBy, including approval rejection), while keeping report eligibility separate from existing RunOutputs statuses. It accepts the consumer's explicit task scope, single-report wait, get/aggregate exit codes and retry ordering. Four admitted/four executing reports replaces the 32/4 ratio. Source-scoped bulk cancellation uses a fixed accepted membership, not an indefinite suppression of future reports; bulk retry remains a gap. SystemHello already exists and shares capabilities with SystemStatus, contrary to one sentence in the Effect review.

Public approval must cover: the authoring/helpers and History service; required task scope; reporting on all final outcomes by default; incremental invocation timing; source-preserving exits and explicit waits; visible report runs and inherited tags; 30-second/five-minute defaults and dispatch-time timeout accounting; four report slots; never-started report eligibility and corrected RunOutputs mapping; single and bulk cancellation semantics; manual replay/NeedsAttention; and unpruned results with explicit optional lake publication. The full Swamp parity goal remains open beyond this slice.
