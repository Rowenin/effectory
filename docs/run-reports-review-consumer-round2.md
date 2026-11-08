# Run reports: consumer and operations review, round 2

Status: independent consumer/operations critique of [run-reports-api-draft.md](run-reports-api-draft.md) (revision 1, as on disk at review time, including the corrected `SystemHello`/`SystemStatus` sentence). **Reviewer approval is not user approval. Nothing is implemented, and no implementation is authorized.** Only this file was written. The draft, sources, tests and commits were not touched, and no subagents were used.

Inputs read: the draft, [consumer round 1](run-reports-design-review-consumer-round1.md), [Effect round 1](run-reports-design-review-effect-round1.md) and [persistence evidence](run-reports-persistence-evidence.md).

Evidence labels:

- **[tested]**: executed outside the checkout during this review.
- **[source-read]**: read in this checkout, not executed.
- **[inferred]**: a design conclusion or an unverified reading.

## 1. Verdict

**Conditional approve-for-presentation.** The shape is simpler and more honest than the round-1 consumer proposal:

- reporters are plain tasks;
- attachments are data;
- there is no companion-run orchestrator and no new run kind;
- incremental invocation reports actually serve the "read the deploy summary before approving" use case.

Several deliberate deviations from round 1 are improvements, and this review does not re-argue them (§2).

Before presentation, apply the exact fixes in §3 (F1–F9). They are small, mostly wording or a field. They do not change the chosen architecture. Present the open questions in §4 as **user decisions**, not settled API. The most important ones:

- `report wait` cannot observe the headline feature, an invocation report while the parent waits for approval.
- There is no way to act on more than one report at a time at the advertised 160k scale.
- The default `scope: "run"` on a task target silently skips every in-workflow use of that task.

## 2. The deliberate deviations, critiqued on their merits

| Deviation from round 1 | Assessment |
| --- | --- |
| Reporters are plain `Task.make`, with no branded wrapper | **Better.** Round 1's brand existed to stop graph-node misuse. The draft instead makes `History` fail outside report invocations [inferred: same safety, less API]. The cost is that a misused reporter fails at runtime with InvalidBoundary, not at build. That is acceptable because `task describe` identifies report schemas. |
| `Report.make` is an attachment in `Application.reports`; tasks register normally | **Better for requirement inference**, and it matches `WorkflowSchedule`. The consequence for consumers: an extension cannot ship a pre-attached report for its own task contract, because there is no contribution kind. Every consumer writes the `Report.make` line. This is acceptable, but the approval note should say it, because round 1 promised contract-level reports. |
| Source is metadata input; `History` reads the typed outcome and pages | **Better.** It avoids the 1 MiB copy and truncation flags. Consequence for consumers: a reusable or extension reporter that uses the generic `Report.Source` only gets `outcome(): Outcome<Json, Json>`. Typed decoding needs `sourceOf(target)`, which an extension cannot name for a consumer's task. Say this in the extension paragraph (F9). |
| One ordinary `kind: "task"` run per report, visible by default | **Correct for compatibility.** [tested] An old `Run`/`RunSummary` schema decodes a run with an extra `report` key and silently strips it (§5). Old clients therefore show report runs as plain task runs. The consumer cost at scale is in §4 D4. |
| Incremental invocation reports, native polling | **Correct and the main usability win.** [source-read] Stopping a run calls `stopInvocations`, which re-executes every registered, incomplete leaf under the fence and interrupts it. Terminal projection waits for quiescence (`interpreter.ts:490-523`). Every registered invocation therefore has a native Exit by the time the root is terminal, so obligations cannot be orphaned in WaitingSource at that point. One stop path, `stopInvocations` failing at `runner.ts:107`, has not been traced [inferred]. |
| 32 admitted / 4 executing; no drop cap; 160k worst case | **Honest**, but the operator controls and fairness are missing (F6, D2). |
| Source outcome and foreground unchanged; explicit `report wait` | **Right default.** Swamp is inconsistent here (round 1 §2.1). Discoverability needs one stderr line (F7). |
| list/get/retry/cancel plus `run summary` | **Right set**, but the receipt and record fields are inconsistent (F3–F5). |
| Results in unpruned run history; explicit lake publishing; gap stated | **Acceptable.** The gap is stated in §5 and in the gap list. |
| Public cancellation mapping fix included | **Necessary but under-specified.** Fence reasons are not limited to cancel/timeout (F1). |

## 3. Exact fixes required before presentation

### F1. Map every fence reason, not just cancel and timeout (correctness)

[source-read] Several sources write `host_fences.reasonJson`, and the first non-null value wins through `COALESCE`:

- `cancelRun` writes `Control/Cancelled` (`host-store.ts:463-485`).
- A wait reject or timeout writes `Control/Rejected` or `Control/TimedOut` (`host-store.ts:440-454`).
- An attempt deadline writes `Control/TimedOut` (`host-store.ts:678-694`).
- **Workflow fail-fast writes the failing sibling's own `ExecutionFailure`**, which may have category Domain, Host or Defect (`interpreter.ts:525-556`, `stopWithFailure`).
- `stopInvocations` calls `fence(runId)` with a null reason (`interpreter.ts:495`). It does not overwrite an earlier reason.

There is a second problem. A registered invocation that never admitted an attempt is re-executed under the fence, and `admitAttempt` returns `"Cancelled"` for **any** fence (`host-store.ts:650-658`). The leaf therefore produces a _typed_ `ExecutionFailure{Control, outcome:"Cancelled"}` even when the root was Rejected or failed fast.

The draft's rule covers "interrupt-only Exit + cancel/timeout fence". It leaves undefined:

- (a) a sibling that is interrupted because another task failed;
- (b) an interrupt under a Rejected fence;
- (c) whether the typed Control Exit or the fence reason wins;
- (d) how NotApplicable ("never admitted an attempt") is detected, given that the native Exit claims Cancelled.

**Smallest fix.** Add one precedence table to the draft. A recommendation, with no new statuses:

1. A non-control Exit, meaning a success or domain/host/defect failure raised by the task's own attempt, is used as is.
2. Otherwise, if the invocation has no `host_attempts` row, the record is NotApplicable with reason `NotStarted`.
3. Otherwise, an interrupt-only or Control Exit under a fence maps to `Stopped` with:
   - `status` = the fence's control outcome when it is Cancelled, Rejected or TimedOut, and `Cancelled` when the fence holds a sibling failure;
   - `detail.stopReason` = the bounded fence reason.
4. Otherwise (no fence) it is `Failure/Defect`, as the draft says.

Apply the same table to the `RunOutputs` correction, so that inspection and reports agree. The proof gates should add "sibling fail-fast interrupt" and "rejection while a sibling task runs".

### F2. `report wait` against a non-terminal source

Today `report wait` exits 4 at once unless the source is terminal. The natural script is `workflow run --background …` followed by `report wait <run>` [source-read: `--background` exists, `main.ts:361`]. That script therefore always fails with 4. Exit 4 also already means "report NeedsAttention", so a script cannot tell the two cases apart.

**Smallest fix**, which changes no exit code and adds no flag: `report wait` first observes the source the way `run watch` does. It keeps waiting while the source is Queued, Running, Retrying or Cancelling. It exits 4 with the source hint only when the source is Waiting or NeedsAttention, which is an actionable outside state and matches the foreground meaning of 4 (`main.ts:232-240`). Waiting on a single report while the source is still running is a separate user decision (D1).

### F3. Report record fields that the text promises but the schema omits

- Line 161 says "Run-level Rejected/TimedOut map to a failed report record with **the exact run status retained**". The record field list (line 196) has no field for it. Add `reportRunStatus: RunStatus | null`.
- NotApplicable is "marked … with a reason". Add `reason: NotStarted | null`, or define it as a tagged `error`.
- Line 161 lists the statuses without NotApplicable, then adds it in prose. Write the full union once: `WaitingSource | Queued | Running | NeedsAttention | Succeeded | Failed | Cancelled | NotApplicable`.

### F4. Align retry and cancel receipts with existing conventions

[source-read] The existing `CancellationReceipt` is `{acceptedAt, actor, reason|null, requestKey, runId, status}` (`protocol.ts:137-144`), and it has no `replayed` field. `replayed` exists only on vault receipts (`vault-protocol.ts:91`). The draft's `ReportCancel` receipt drops `actor`, `reason` and `status` and adds `replayed`. Choose one shape. Recommendation: `{reportId, reportRunId|null, acceptedAt, actor, reason|null, requestKey, replayed, status: ReportStatus}`.

Also state:

- **Cancelling an already-terminal report** returns a receipt with the terminal status and no error, mirroring `cancelRun` (`host-store.ts:468-470`).
- **Run-cancel key derivation.** When `ReportCancel` delegates to `RunCancel`, it derives the run-cancel request key deterministically from `(reportId, requestKey)`, so a replay cannot record a second cancellation.
- **Direct `run cancel`.** A `run cancel <reportRunId>` projects the report record to Cancelled, so the two cancellation paths cannot diverge.

### F5. Make retry rules total and ordered

The retry paragraph (line 180) is ambiguous in three ways:

- "Reusing a key with a different source report is scoped separately" does not say what the scope is. Is it the reportId or the group?
- "A running latest generation conflicts" does not say whether that check runs before or after replay detection. If it runs first, a delivery-uncertain retry whose generation is now Running returns Conflict instead of replaying.
- It does not say whether NotApplicable, which is terminal, is retryable.

**Exact wording:**

- The request-key scope is `(principal, groupId)`.
- Key lookup runs first. A matching key returns the generation it created, at its _current_ status, with `replayed: true`. The reply column should read "record of the generation created by this key", not "new queued record".
- Otherwise:
  - retry is accepted only when the group's latest generation is Succeeded, Failed or Cancelled;
  - a NotApplicable, WaitingSource, Queued, Running or NeedsAttention latest generation returns Conflict;
  - a retry of a non-latest reportId is allowed and creates generation max+1 (or Conflict, but say which).

### F6. Ordering and visibility of report promotion

At the stated worst case of 160,000 obligations and 4 concurrent attempts, one fan-out holds the report lane for hours [inferred: at 1 s per report, about 11 h]. Promotion order is unspecified, so a single large source can starve every other run's reports. Add one sentence giving the promotion order. Recommendation: round-robin across source runs, oldest Ready first within a source.

Also expose Ready/admitted counts somewhere an operator already looks: a `SystemStatus` limit or count, or `system doctor`. The existing health counts are lower bounds capped at 1001 (`host-store.ts:971-985`). A report backlog count should follow that precedent and not imply an exact count.

The existing active-run count query counts **all** non-terminal `host_runs` (`host-store.ts:554-565`), and so does health `activeRuns`. "Report runs do not consume the 1000 slots" therefore requires those queries to filter by admission namespace. Name both queries in the draft so that the claim is an explicit implementation obligation rather than an implied one.

### F7. One discoverability line on foreground commands

The foreground keeps its exit codes, but nothing tells the user that reports exist. `Run` has no report aggregate, so a user who never reads `run summary` will not find them. Without changing exit behaviour, add this rule: in non-JSON foreground mode, when the pinned revision has at least one matching attachment, print one stderr line, `Reports: effectory report list <run-id>`, at exit, including the exit-4 approval stop. This is presentation only, in the same channel as the existing exit-4 hint.

### F8. Preflight `run list --origin`

[tested] With default decoding, `RunListRequest` silently accepts and strips an unknown `origin` key. With `onExcessProperty: "error"` it rejects the key. The daemon's `runHistory` re-decodes strictly (`run-history.ts:129-134`). Whether the RPC layer strips the key first was not traced [inferred]. Depending on that, an old daemon either returns **unfiltered** history for `--origin manual`, which is silently wrong, or fails.

The draft says that only "new report commands preflight". Add `run list --origin` to the preflight. This is exactly the `--tag`/`run-tags.v1` precedent (`tags.ts:54-60`).

### F9. State the root-task double-scope rule and the extension typing limit

- [source-read] Root task runs go through `invokeTask(run, "task", …)` and register an invocation (`interpreter.ts:1038-1045`, `:394`). As written, a root task run therefore satisfies _both_ `scope: "run"` and `scope: "invocation"`. Two attachments on one task, one per scope, then produce two reports per directly submitted run, which differ only in `invocationId`. State this explicitly, or define root task runs as run-scope only. This interacts with D3.
- Extension reporters: add one sentence and, ideally, a five-line example. An extension reporter uses `Report.Source` and `outcome()` untyped. Typed `outcome(target)` is available only to an author who can import the target contract. Today the authoring example shows only the same-file case.

Two smaller wording fixes:

- Line 155 says a NeedsAttention report can be retried after it is "cancelled/resolved". [source-read] The RPC list (`rpc.ts`) has no resolve operation for a NeedsAttention run, and its outbox `Settle` is held (`host-store.ts:1216`). Say "cancelled".
- Line 129 calls `Report.History` "a required `Context.Service`", and line 135 gives it a failing default "outside reporting". Phrase it as: a service excluded from `R`, which the host always installs, failing outside a report invocation. Otherwise readers will take it to be a `Context.Reference`.

## 4. User decisions to present (not chosen by this review)

These need a named answer. Each one changes the public surface or a default, so this review does not pick a new API.

- **D1. Waiting on one report while the source runs.** This is the flagship scenario: deploy finishes, the parent waits for approval, and the operator wants that report. Under F2, `report wait <run>` stops at the approval with exit 4. Today the only path is polling `report list`. Options:
  - (a) Accept polling for this slice and record it as a gap.
  - (b) Add `report wait --report <report-id>`, which waits for that record to become terminal regardless of source state.
  - (c) Add a selection by `(run, attachment, invocation)`.

  Recommendation: (b). It is one flag and uses the identifier that `report list` already prints.

- **D2. Acting on many reports at once.** The draft requires "counts, pending cancellation and retry [to] remain usable at that scale", but every mutation takes a single `reportId`. An operator who mis-attached a report to a 10,000-item fan-out needs 10,000 `report cancel` calls. Cancelling the source does not help: it _creates_ more reports (Cancelled outcomes for in-flight invocations) and leaves already-admitted ones running. Options:
  - (a) Accept this and state it as a gap.
  - (b) Add a source-scoped bulk form: `ReportCancel { runId, attachmentId?, statuses? }` and `ReportRetry { runId, attachmentId?, statuses: Failed|Cancelled }`, with paged receipts.

  Recommendation: (b), at least for cancel, or remove the "usable at that scale" claim.

- **D3. Default scope for a task target.** The default `"run"` means `Report.make({ target: Deploy, task: Summary })` reports only when `Deploy` is submitted directly, and never when a workflow invokes it, which is how most tasks run. Swamp's method reports do fire inside workflow steps (round 1 §2.1). Options:
  - (a) Keep `"run"` and document it.
  - (b) Default by target kind: `"invocation"` for a task target and `"run"` for a workflow.
  - (c) Make `scope` required for task targets.

  Recommendation: (c), the least surprising and a one-line type change. It only matters together with the F9 double-scope rule.

- **D4. Visible-by-default report runs.** At one attachment on a 10,000-item fan-out, the default `run list` gains 10,000 interleaved task rows, and old clients cannot distinguish them [tested: provenance stripped]. Options:
  - (a) Keep the draft and rely on the `--origin` filter (with F8 preflight) plus an origin column in the default CLI rendering.
  - (b) Default the CLI, not the RPC, to `--origin manual,schedule`.

  Recommendation: (a), plus the origin column. Present the volume consequence in the approval note either way.

- **D5. Cancelled reports and `report wait`.** An operator who cancels an unwanted report makes `report wait` exit 1 until some later generation succeeds. Options:
  - (a) Keep this.
  - (b) Count an explicit operator cancel as satisfied.

  Recommendation: keep (a), but state it.

- **D6. `report wait` exit precedence** when both Failed and NeedsAttention are present. Recommendation: 4 over 1, consistent with "outside action needed". The draft does not say. It also does not say whether `report wait` returns once every latest generation is either terminal or NeedsAttention. It must, because NeedsAttention never settles without an operator.
- **D7. Reporter execution policy is new plumbing.** [source-read] Directly submitted root task runs have no retry, attempt timeout or task-level timeout today. `Task.Spec` has none, and `invokeTask` is called with default `NodeOptions` for root tasks (`interpreter.ts:1038-1044`, `:376`). The attachment `execution` block (a 5-minute timeout, a 30-second attempt timeout, and retry) therefore means a report run carries a policy that no ordinary task run can carry. This is fine, but the draft should say that the resolved policy is stored with the report admission and is shown by `run get` and `report get`. Otherwise "ordinary task run" overstates the reuse. The default 30-second attempt timeout may also surprise reporters that call slow renderers. The user should confirm both defaults.

## 5. Missing signatures before implementation

These are not presentation blockers, but the draft names them only in prose:

- the `Report.make` return type (for example `Report.Attachment`), and the `Application.make` parameter type for `reports`;
- the compile-time relationship that rejects `sourceOf(A)` attached to target `B`;
- `Report.Status`;
- `InvocationPage`, `InvocationItem` and `EventPage`, the History reply types;
- the `Report.test` fixture types (`outcome`, `invocations`, `events`), including how a raw outcome is typed before lazy decoding;
- the `RunReports` aggregate-count schema;
- the `RunSummarize` structured reply. Avoid the name `RunSummary`, which already exists as the run-list row schema (`history-protocol.ts:27`). The draft uses that name correctly for provenance, but CLI `run summary`, RPC `RunSummarize` and schema `RunSummary` side by side will confuse readers. Note the distinction once;
- the `report get` exit table for every status. Only "pending 4 / failed 1" is given. Recommendation:

  | Status                         | Exit                   |
  | ------------------------------ | ---------------------- |
  | Succeeded                      | 0                      |
  | NotApplicable                  | 0, no content, no file |
  | Failed                         | 1                      |
  | Cancelled                      | 1                      |
  | WaitingSource, Queued, Running | 4                      |
  | NeedsAttention                 | 4                      |

  Also confirm that `--json` follows the same table.

## 6. Checks performed

- **[tested] Old-schema decoding.** A probe was run with `bun` from the scratchpad (`…/scratchpad/r2/decode.ts`). It imported `protocol.ts` and `history-protocol.ts` from this checkout with the root `effect` package. Results:
  - `Run` and `RunSummary` decode a value with an extra `report` object, and the key is stripped.
  - `RunListRequest` accepts and strips `origin` under default options and rejects it under `onExcessProperty: "error"`.

  The probe did not exercise the RPC transport, a real old binary, or the `effect` copy in `packages/runtime/node_modules`. The draft's "real old-schema decoding proof" gate still stands.

- **[source-read] RPC surface.** `SystemHello` and `SystemStatus` both carry `capabilities`, and the CLI preflights with `SystemStatus` (`rpc.ts:82-104`, `client.ts:53`, `tags.ts:54`, `reclamation.ts:104`). The draft's current wording is correct.
- **[source-read] CLI exit codes.**

  | Code | Meaning                         |
  | ---- | ------------------------------- |
  | 0    | Succeeded                       |
  | 1    | Other terminal status           |
  | 2    | Invalid input                   |
  | 3    | Unavailable or RPC client error |
  | 4    | Waiting or attention            |
  | 5    | Other OperationError            |
  | 130  | Interrupt                       |

  Sources: `main.ts:232-240,278,1640-1660`. The draft's `report wait` codes fit, apart from F2 and D6.

- **[source-read] Fence writers and stop behaviour** are cited in F1. Admission dedup and the 1000-active count are cited in F6. Root-task invocation registration is cited in F9 and D7.
- **[source-read] `Task.make`'s exclusion set is still `Tag.Values | ArtifactStorage`** (`task.ts:117,382,451,469,540,564`). Adding `Report.History` touches all six signatures. The draft's list ("`Task.make`, `Task.implementation` and both `.provide`") should be checked against these six during implementation.
- **[source-read] `Task.test` returns `{ value, publications, progress }`** (`task.ts:570-730`), which matches the draft.
- **Not checked:** extension facade or declaration generation for report schema provenance; the engine retention or reset path for native replies; the RPC server's payload decode options; Swamp sources beyond rounds 1 and 2. All remain the draft's proof gates.

## 7. Conditions for presenting

Present to the user when the following hold:

- F1–F9 are applied, or each is explicitly declined with a reason.
- D1–D7 appear in the approval note as open user decisions.
- The note states the extension and pre-attachment consequence (§2) and the volume consequence (D4).

None of this requires reverting a parent decision. This review's approval is for presentation only. It is not user approval, and it is not authorization to implement.
