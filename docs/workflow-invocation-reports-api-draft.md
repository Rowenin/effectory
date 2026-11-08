# Reports for workflow invocations — proposal 1

Status: **approved for implementation** on 2026-11-06, including child-subtree history, bounded continuation pages and source-workflow search. [Research and probe evidence](workflow-invocation-reports-research.md).

## Authoring and behavior

Allow `scope: "invocation"` on a workflow attachment:

```ts
const regionalSummary = Report.make({
  id: "regional-summary",
  target: DeployRegion,
  scope: "invocation",
  task: SummarizeRegion,
});
```

This proposed fragment assumes existing workflow and reporter definitions. The SDK accepts this combination. Register it through the existing `Application.make({ reports: [regionalSummary] })` field.

It runs once for each actual invocation of DeployRegion, including nested children, keyed fan-out, selected branches and patches. It runs after that invocation settles, even while the parent is still working or waiting. Native workflow replay and task retries do not create another report obligation. Report retry remains a separate, explicit generation using the source's pinned revision.

**Recommended consistency rule:** a directly submitted DeployRegion also matches its invocation-scope attachments, just as directly submitted tasks do today. A workflow's omitted scope still defaults to `"run"`; those existing attachments continue to apply only to submitted roots. Two distinct attachments, one in each scope, intentionally produce two reports for a direct root submission.

The reporter is an ordinary task. It keeps `Report.sourceOf(DeployRegion)` as input, `Report.result(DataSchema)` as success, and `yield* Report.History` for reads. `history.outcome(DeployRegion)` returns the child's decoded success or domain error. There is no new service, handler context field, task engine or public execution journal.

```ts
const SummarizeRegion = Task.make(
  {
    id: "summarize-region",
    version: 1,
    input: Report.sourceOf(DeployRegion),
    success: Report.result(Schema.Struct({ succeeded: Schema.Boolean })),
    error: Schema.Never,
    replay: "idempotent",
  },
  () =>
    Effect.gen(function* () {
      const history = yield* Report.History;
      const outcome = yield* history.outcome(DeployRegion);
      const succeeded = outcome._tag === "Succeeded";
      return {
        markdown: succeeded
          ? "Region deployed."
          : "Region did not complete successfully.",
        data: { succeeded },
      };
    })
);
```

This is proposed usage with `DeployRegion` supplied by the application and imports from the SDK and Effect. The API is implemented and verified; see the [implementation record](workflow-invocation-reports-implementation.md). Existing source/result schemas and the reporter handler API already support the types shown.

## Child-subtree History — user-chosen direction

For a workflow invocation source:

- `outcome` describes that exact invocation, never an aggregate guessed from its tasks.
- `invocations` lists only task invocations inside that workflow subtree, including nested descendants and patches. It keeps today's task-shaped rows; it does not mix workflow rows into `taskId` fields.
- `events` lists events attributed to the workflow boundary or its descendants. It excludes sibling activity and parent run lifecycle events. Original run IDs and event sequence numbers remain, so gaps in the scoped stream are normal.
- The existing run-wide `TelemetryTruncated` diagnostic remains visible because it means child logs may be missing too. It contains no sibling log content. Other unattributed root events are omitted.
- A directly submitted workflow's invocation subtree is the whole root. Existing run-scope and task-invocation reports keep their current root-wide history behavior.

This is a scoped reporting view, not a new principal/access boundary. ArtifactReader retains its existing independent capabilities and retention rules.

History stays paged, with the existing item and response byte limits. Scoped scans may return an empty page with a non-null cursor when intervening sibling history exhausts the work budget. Follow cursors until null, even after an empty page. Membership is fixed at the first page; invocation statuses remain live. Cursors bind the principal, source invocation, method and request, retain the original expiry, and cannot cross child reports. Retries start paging again rather than persist expiring cursors.

The implementation must charge examined rows, not just matches, with cooperative batches and no SQLite cursor held across an Effect yield. The proposed per-page ceilings are 10,000 examined attribution rows, 16 MiB of examined attribution data and 250 ms of cooperative work, stopping at the first reached budget. These bound traversal, not wall-clock latency of one SQLite statement. A matching event too large for the existing event-page limit still fails `LimitExceeded`; an oversized sibling event must not poison the child's page.

`Report.test` keeps its current signature. For a workflow-invocation fixture, supplied task/event arrays represent the already-scoped History view. The harness cannot prove real host attribution; real host tests must prove that siblings are excluded, including quotes, Unicode, slashes and prefix-like node names.

## Source identity and stopping

Existing Source fields suffice: `targetKind: "workflow"`, `scope: "invocation"`, the root's `runId` and `revision`, and an opaque stable non-null `invocationId`. Path previews on report records identify which child/fan-out instance it was. Full paths are not copied into reporter input.

An inactive branch has no activated invocation and no report record. An activated child can wait on dependencies before entering. Entry means dependencies are ready and the host has admitted the child boundary before its input decode/body. A root fence that wins admission prevents entry. Empty workflows still enter and can report success without any task attempts.

| Source facts | Report source behavior |
| --- | --- |
| Activated but never entered | `NotApplicable` / `NotStarted`; no reporter execution |
| Entered; native child result is success | `Succeeded`, with that encoded result |
| Entered; native child result is a typed/domain or host failure | Preserve that child-local category and result; apply `on` normally |
| Entered; child result absent; root unfinished | Keep `WaitingSource`, including manual holds and durable waits |
| Entered; result absent; root terminal with a stop fence | `TimedOut` for a timeout stop, otherwise `Cancelled`, with existing stopped-by detail; never borrow a sibling's domain error |
| Entered; result absent; root terminal without a usable stop explanation | Expose an observation error and retry reconciliation; do not invent success or a NotApplicable result |

A cached child result wins over a later parent cancellation or sibling failure. An accepted cancellation of a pending child report remains durable, as it does for task reports. Root run cancellation is still the only workflow execution cancellation operation; this feature does not add “cancel just this child.” Source exit codes and foreground waiting behavior do not change.

## Selection, schedules, discovery and operations

Admission selection includes invocation attachments for reachable workflow identities, alongside the existing task candidates. All selected copies of an attachment use the same captured choice. Required immunity, classification tags, `on` outcomes, unknown-name validation and exclusion before obligation creation keep their approved meanings. Required does not cause an inactive branch to run.

Scheduled plans capture these candidates through the same resolver. Attachment/selection-only edits preserve pending occurrences and schedule generations. Already admitted sources retain their plans. There is no retroactive reporting for old runs whose plans lack child attachments.

Existing report list/get/wait/cancel/retry and bulk cancellation operate on the new source combinations. Report search remains metadata-only and uses the current statuses, generation rules and budgets. Add:

```sh
effectory report search --source-workflow deploy-region
effectory report search --workflow rollout --source-workflow deploy-region
```

`--workflow` continues to filter the submitted root. `--source-workflow` filters the report's workflow target, whether it was a root or child; combine `--scope invocation` to narrow the scope. It is an exact ID, not a path or wildcard. The RPC field is optional `sourceWorkflowId`. Combining it with `taskId` is `InvalidInput`, because one source cannot be both kinds. Unknown IDs return an empty page, matching existing search behavior.

Advertise `reports.workflow-invocations.v1`. The new CLI filter checks capability before searching; existing commands/filters retain their compatibility. Existing Source and report-record readers already accept workflow+invocation, but that schema fact does not substitute for an old-client integration test. Pinned revision/host ABI rules remain in force.

## Ownership, durability and limits

Keep controller registration/entry facts separately from leaf payload rows, whose consumers assume task execution IDs. Register selected obligations before body execution or descendant publication. Native Effect results stay authoritative. Read child deferreds using the original root workflow instance and an owned scope, without resuming anything or editing engine tables.

Observe each child once per bounded reconciliation pass, not once per attachment. The existing durable rotating source cursor handles incomplete roots and crashes between native completion and report materialization. Task and workflow source polling may differ internally; reporter runs still use the same queue, task execution, Layers, Vault guards and reader/publication ownership.

The implementation must preserve a child-local failure before root-wide fencing substitutes the winning root reason. Root outcome precedence must remain unchanged. The current `stopWithFailure` path needs a targeted correction and concurrency proofs; successful deferred-read probes alone do not establish this.

Child obligation registration participates in the existing root-publication retention hold. It conservatively protects the source root's artifacts until the report settles, including time spent waiting for a report slot. No new pin cap or reclamation receipt meaning is introduced.

Retain four executing report runs, per-source fairness, sixteen attachments per target/scope, 128 attachments per application, and the existing 10,000 expanded graph-node limit. Child nodes already consume graph expansion budget. Root invocation registration is bounded separately to one. Every selected actual child adds reporting work; a wide graph may queue many reports. Existing per-source bulk cancellation remains the operator escape, with no silent drop. Reporter runs still do not recursively trigger reports.

Event attribution must be persisted atomically with the event. In particular, publication events written by the lake connection, wait settlement and deadline events need explicit attribution; infer neither membership from timestamps nor from an arbitrary text prefix. Match complete path segments. A private attribution projection avoids decoding unrelated event bodies during scoped paging and does not change event wire payloads.

## Required implementation gates

1. Constructor/type tests and actual application/extension definitions: both workflow scopes, inferred outcome type, wrong targets and canonical identity, root invocation behavior, unchanged default scope.
2. Real nested workflow, branch, fan-out and patch execution; empty child; reports completing while the root waits; exactly one obligation across task retry, manual recovery and native workflow replay.
3. Kill/restart at registration, entry, child completion, report materialization and report admission; read the saved result without rerunning source work, retaining revision and selection.
4. Child-local domain/host failures, concurrent siblings with different error schemas, child and root deadlines, approval rejection, root cancellation, and cached success followed by a parent stop. Prove root outcome precedence is unchanged.
5. Exact subtree task/event attribution, publication/wait/deadline events, telemetry truncation, sparse pages, cursor binding/expiry, and oversized sibling versus matching events. Verify bounded work with at least 250,000 sibling events and interruption without a held SQLite snapshot.
6. Source retention before reporter admission and through restart, excluded attachments producing no holds, report retry/cancel/bulk cancel, fairness and normal-run capacity.
7. Search's root/source distinction, metadata path previews, backward schema/client behavior and preflight against an old server.
8. `Report.test` examples and native host agreement; all existing task reports, run reports, scheduling, recovery and source exit codes unchanged. Full typecheck, formatting/lint and repository suite on a stable tree.

## Approval

The user approved the workflow invocation attachment, direct-root consistency rule, child-subtree History, bounded partial scoped pages, and `--source-workflow` on 2026-11-06. The central behavior is one independently executed report for each actual child boundary, without waiting for the parent to finish. Implementation is authorized by that explicit approval.
