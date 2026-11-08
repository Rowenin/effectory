# Run reports: Effect/typing/durability review, round 2

Status: focused review of the frozen, unapproved [run-reports-api-draft.md](run-reports-api-draft.md) (revision 1). It follows [round 1](run-reports-design-review-effect-round1.md), the [consumer review](run-reports-design-review-consumer-round1.md) and the parent [persistence evidence](run-reports-persistence-evidence.md). **This is reviewer approval only. It is not user approval and does not authorize implementation.** No draft or production files were edited.

Labels:

- **[tested]**: typechecked or executed in a stand-in probe outside the checkout, against pinned `effect@4.0.5` and the repository's `tsc` (7.0.2 with effect-tsgo 0.56.0).
- **[source-read]**: read in this checkout. File and line references are given.
- **[inferred]**: a design conclusion that has not been executed.

## Verdict

**Conditionally approved for presentation to the user.** Seven small, exact corrections (B1–B7 below) must go into the draft first. None of them reverses a parent decision. The overall shape holds up under probes:

- the reporter is an ordinary `Task.make`;
- `Report.make` is a declarative attachment;
- the input is a bounded source identity;
- history is a host service excluded from requirements;
- each report is its own `kind: "task"` run;
- invocation reports are driven by native-result polling, with no write-ahead callback.

The blocking problems are all places where the draft is vague or slightly wrong about durable facts. The most serious are:

- the mapping from native Exit and fence to source status (B1);
- run-scope failure category, which is lost at projection today (B2);
- where `Report.History` is installed (B3).

## Probe evidence

Probe directory: `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/959bf5e5-599d-4a7e-a914-694ec5afe197/scratchpad/r2probe/`. No network, no credentials, no repository test suite.

| Probe | What it showed |
| --- | --- |
| `report.ts` and `consumer.ts` with the real `task.ts`, `workflow.ts` and `application.ts` [tested] | **Stand-ins:** `sourceOf`, `result`, `History` with an overloaded `outcome`, a `taskMake` with the widened exclusion `Tag.Values \| ArtifactStorage \| History`, and the generic attachment constructor `Report.make`.<br>**Requirements:** the reporter's requirement is exactly `Formatter` (`History` removed). The real `Application.make({ tasks })` requires exactly `Formatter`.<br>**Narrowing:** `source.targetId` narrows to `"app/deploy"`. `history.outcome(Deploy)` narrows `value.url` and `error.reason`.<br>**Attachments:** a contract target, a Definition target, a workflow target with generic `Report.Source`, and a reporter retry tag all pass. A heterogeneous `readonly Report.Attachment[]` accepts all of them. |
| `consumer.ts` `prLeaks` [tested] | With today's real `Definition.provide`, a task-local Layer whose `RIn` contains `History` puts `History` back into the task's requirements. This confirms that the draft's "both `.provide` signatures, including Layer input requirements" is necessary, not cosmetic. |
| `negative.ts` [tested] | Six `@ts-expect-error` lines are all consumed. Removing the directives shows each one fails for the intended reason:<br>• `sourceOf(Deploy)` attached to `Other`;<br>• invocation scope on a workflow target;<br>• an unknown retry tag;<br>• a success schema that is not `Report.result`;<br>• a String input;<br>• a wrong narrowed `targetId`. |
| Sanity flip [tested] | Asserting the opposite of the requirement checks fails with TS2322. The probe files are really checked. |
| `fake.ts` [tested] | A hand-written `Layer.succeed(History, { outcome: (_t?) => Effect.succeed({ _tag: "Succeeded", value: Json }) })` typechecks **without a cast**. TypeScript erases the generic overload to its constraint, so a hand-written fake is accepted _and unchecked_. The draft says such fakes "may need a cast". The accurate statement is that they are unchecked. |
| `ctx.ts` (bun) [tested] | Effect 4.0.5 `provideContext` merges with the provided context winning (`node_modules/effect/src/internal/effect.ts:2306-2314`). Results:<br>• `outside: "app"`: if the interpreter provides `History` outside `task.execute`, the context that `Application` captured wins.<br>• `inside: "host-in-definition"`: provided inside `definition()`, the host value wins.<br>• `local`: a task-local Layer built inside sees the host value.<br>• `override: "task-local"`: a task-local `.provide` wins. |
| `interrupt.ts` and `repoll.ts` with the real `engineLayer` on a temporary SQLite file [tested] | **During execution:** a running leaf polls `None` while executing.<br>**After `interruptUnsafe`:** it polls `Failure interruptsOnly=true typed=false`.<br>**Never executed:** an execution ID that was never executed polls `None`.<br>**Execute then interrupt at once:** a `discard` execute followed immediately by `interruptUnsafe` (the order `stopInvocations` uses) also gives an interrupt-only Exit.<br>**Fresh process:** both Exits read back identically.<br>The Cause carries no fence information, so the reason must come from `host_fences`. |
| `compat.ts` [tested] | The current `Run` schema, decoded with default options, strips an unknown `report` key. With `onExcessProperty: "error"` it rejects it. Strict decoding exists only on server-side request paths (`daemon.ts:91`, `run-history.ts:132`, `watch-plane.ts:75`) [source-read]. So old clients tolerate new reply fields; new requests need the capability preflight, which the draft already requires. |

## Critique of the parent decisions

Where a cell says "Agree", no change is needed beyond the blocker it names.

| Decision | Assessment |
| --- | --- |
| Ordinary `Task.make` reporter | **Agree.** Fully inferable [tested]. Requires the three-site exclusion plus the exclusion on Layer `RIn` [tested]. Put `History` in its own module (for example `report-history.ts`) so `task.ts` can provide its default without a `task.ts` ↔ `report.ts` cycle (`Report.test` imports `Task.test`) [inferred]. |
| `Report.make` as a declarative attachment with explicit task registration | **Agree.** The exact generic signature is given under "Shapes left too vague" below and is tested. Registration cannot be enforced in types, so a load-time `DefinitionError` is right. |
| Source input is bounded metadata; `sourceOf` narrows identity | **Agree, with one exactness fix.** `SourceOf` must be parameterized by the identity literals (`id`, `version`, kind), **not** by the target value's type. Otherwise `sourceOf(DeployImplementation)` would not match an attachment whose target is `DeployContract`, nor a facade contract. Tested: identity parameters accept a contract and a definition of the same spec. |
| Typed `History.outcome(target)`; paged slim invocations and events | **Agree for invocation scope. Not feasible as written for run scope** (B2). Hand fakes are unchecked [tested], so `Report.test` must be the documented fake. |
| One `kind: "task"` run per report, visible in the ordinary list with optional provenance | **Feasible and compatible** [tested decode]. Showing report runs by default is a user decision: both round-1 reviewers recommended hiding them, and a 10,000-invocation fan-out floods `run list` and tag-filtered listings, because tags are copied. The 1000-run count (`host-store.ts:557-565`) and the drain probe (`:974`) must exclude namespace `report` [source-read]. |
| Incremental invocation reports: armed obligation plus native polling, no write-ahead | **Agree.** This is the right correction to my round-1 write-ahead idea, which could have failed the source. Completion facts are now [tested]. Needs B1, B4 and B7. |
| 32 active report runs and four report permits; compact pending work; no silent drop | **The ratio is a problem** (B5). The per-run permit mechanism cannot implement a daemon-wide report semaphore: `resources.permits(runId, …)` is keyed by run (`interpreter.ts:308-313`) [source-read]. Compact pending work needs deterministic report IDs and a per-source bulk cancel. |
| Explicit report list/get/wait/retry/cancel; read-time summary | **Agree.** Retry and cancel need exact rules (B6). |
| Leaf result persistence; optional lake publication; retention gap stated | **Agree.** Note that `History.outcome` keeps reading native replies for as long as a report can run or be retried (B4). |
| Ordinary replay semantics, including manual | **Agree,** with one liveness rule (B5): report runs in `NeedsAttention` must not consume the active-admission budget. |
| Corrected inspection mapping (interrupt-only plus explicit fence) | **Right direction, incomplete** (B1). It changes existing `run outputs` results, which must be shown to the user. |
| `SystemStatus.capabilities` advertises `reports.v1`; no SystemHello | **Agree.** This is the existing pattern (`control-plane.ts:197`; CLI checks at `main.ts:1390`, `tags.ts:54`) [source-read]. |

## Blockers and smallest corrections

### B1. The source-status mapping is not total

**Facts:**

- [source-read] There are four kinds of run fence, and the first non-null reason wins (`COALESCE`, `host-store.ts:898-905`):
  1. operator cancel writes Control/Cancelled (`:463-488`);
  2. a deadline writes Control/TimedOut (`:680-694`);
  3. `stopWithFailure` writes the _sibling's_ Domain or Host failure, or a wait's Control/Rejected (`interpreter.ts:528-558`);
  4. a root that fails without a fence makes `stopInvocations` write a **null** reason (`runner.ts:105-108`, `interpreter.ts:495`).
- [source-read] `admitAttempt` returns `Cancelled` for _any_ fence (`host-store.ts:651-659`).
- [tested] Interrupted leaves persist an interrupt-only Exit with no typed error.
- The draft defines only "interrupt-only plus a cancellation or timeout fence". Two cases are undefined:
  - fail-fast siblings, whose fence reason is another node's failure;
  - a null-reason fence.
- Applying a sibling's Domain error to a stopped invocation would be wrong.

**Correction.** Add this table. Use it in Source materialization, `History.outcome`, `History.invocations` and the corrected `RunOutputs`:

| Native `poll` (EffectoryTask/v1) | Host facts | Source status / Outcome |
| --- | --- | --- |
| `None` or `Suspended` | root not terminal | not final (stays WaitingSource) |
| `Suspended` | any | not final. This includes durable retry sleep and manual NeedsAttention (`interpreter.ts:338-358`, `:213-215`). |
| `Success` | — | `Succeeded` |
| typed `ExecutionFailure` Domain | — | `Failed` / `DomainFailure` |
| typed Host | — | `Failed` / `Failure{Host}` |
| typed Control, outcome X | — | X / `Stopped{X}` |
| interrupt-only | a fence row exists; materialize **only once the root is terminal**, so the reason is final | `TimedOut` if the reason is Control/TimedOut. Otherwise `Cancelled` / `Stopped{Cancelled, detail: { stoppedBy: reason.outcome \| "RunFailed" }}`. This mirrors `admitAttempt`. A sibling's error is never copied. |
| interrupt-only | no fence row | `Failed` / `Failure{Defect}` (unchanged; self-interruption is not relabeled) |
| other failure Cause | — | `Failed` / `Failure{Defect}` |
| any non-success | the invocation has zero `host_attempts` rows | `NotApplicable` (no report run) |
| `None` | root terminal | `NotApplicable{reason: "NoNativeExecution"}`. **Never** call `execute(discard)` on an unfenced terminal root, because that would run the task after the root finished. |

The zero-attempt row must be stated as a user-visible choice. A first attempt refused at the run deadline is a real TimedOut with zero attempts, because `admitAttempt` returns before inserting (`host-store.ts:679-694`). Under this rule it becomes NotApplicable.

### B2. Run-scope failure category is lost at projection

**Facts.** [source-read] `project(runId, status, payload)` stores only `detail` in `errorJson` (`host-store.ts:1222-1240`), and its callers pass `reason.detail` / `failure.value.detail` (`runner.ts:115-128`). A Domain error and a Host failure such as `{message, code}` are therefore indistinguishable afterwards. So `outcome(Workflow)` and `outcome(TaskTarget)` at run scope cannot produce `DomainFailure` versus `Failure{Host|Defect}` reliably.

**Correction.**

- Terminal `project` receives the `ExecutionFailure` category, or `"Defect"`, and stores it with the run-scope obligations it creates in the same transaction.
- `History.outcome` at run scope decodes `errorJson` with the target's error codec only when that category is Domain.

No public run schema change is needed.

### B3. Where `Report.History` is installed

**Facts.** [tested] If the interpreter provides it around `task.execute`, any `History` in the context captured by `Application` overrides the host (`application.ts:166-186` wraps every task in `provideContext(services)`). The draft's claim "host default wins over application-level service; task-local `.provide` overrides" holds only when the service is installed inside `definition()`.

**Correction.** State that:

- the per-attempt service travels as an internal `RuntimeContext` field;
- it is added inside `definition()` next to `ArtifactStorage` and `Tag.Values` (`task.ts:405-416`), which also covers task-local Layer acquisition [tested];
- when the field is absent (ordinary tasks, `Task.test`), `definition()` installs the refusing default;
- the interpreter closes it (`active = false`) when the attempt ends, as it does for `taskContext` (`interpreter.ts:233-246`).

Calls made after closure, including from a fiber the reporter forked, fail with InvalidBoundary.

### B4. Retaining native replies is a lifetime invariant, not a materialization step

**Facts.** [source-read] Effect 4.0.5 clears a workflow `run` reply only through `resume` of a **Suspended** reply, or through `clearAddress` for clock entities (`ClusterWorkflowEngine.ts:285-308`, `:282`). Effectory calls neither for completed leaves. A grep of `packages/platform-bun/src` found no engine resets or `DELETE`s, and backup copies the whole `state.sqlite` (`backup.ts`). Today this is safe.

**The problem.** The draft says replies are needed "until obligation materialization". But `History.outcome` reads them on every report attempt and retry, possibly long after materialization.

**Correction.**

- Restate the invariant as: "a non-Suspended `EffectoryTask/v1` reply and the root's fence and status are retained for as long as any report generation for that source can be admitted or retried".
- Make any future engine cleanup or run pruning a coordinated change.
- Add a proof gate: generation 2 is retried after daemon restart and reads the same outcome.

### B5. Fan-out fairness, liveness and operator controls

Four corrections:

1. **Permit-wait vs timeout.** [source-read] Node deadlines start before permits are acquired (`deadline.ts:36-79` is entered by node `timeout`; permits wrap the Activity body in `interpreter.ts:306-313`). With 32 admitted runs and 4 permits, queueing alone can consume the 5-minute default report timeout at 30-second attempts [inferred]. **Smallest fix:** make the active report budget equal to the report-permit count (4 and 4), _or_ state that queue time counts against `timeout`. Implement the report semaphore as a new daemon-wide resource acquired outside the global permit. The per-run `resources.permits` cannot be reused.
2. **Promotion order.** Use round-robin by source run, oldest ready first within each source. Plain FIFO lets one source with 160,000 obligations starve every other source's reports.
3. **Budget accounting.** The active budget counts only Queued, Running, Retrying and Cancelling report runs. NeedsAttention (manual replay) is excluded. Otherwise 32 stuck manual reports halt all reporting daemon-wide.
4. **Compact identity and bulk control.**
   - Report IDs must be deterministic, for example a hash of `(sourceRunId, invocationId|null, attachmentId, generation)`. Then pending work needs no per-obligation row before materialization, while `get`/`cancel` still address it.
   - Add `ReportCancel { sourceRunId, requestKey, reason? }`, which cancels all non-terminal latest generations of one source. Without it, the "no silent drop" choice has no operator escape at 160,000 obligations. This is the minimum control that decision needs, not a new primitive.

### B6. Exact retry and cancel semantics

**Retry.**

- Applies only to the **latest** generation of a group. Retrying an older generation returns `Conflict` and names the latest report ID.
- Is rejected for WaitingSource, Queued, Running, NeedsAttention and NotApplicable.
- The idempotency scope is `(principal, groupId, requestKey)` with fingerprint `reportId`. The same key and same `reportId` replays the original receipt. The same key with a different `reportId` in the group is `Conflict`. Replace "scoped separately" with this.

**Cancel.**

- Runs in one host-store transaction against the promoter's `Ready → Admitted` transition. bun:sqlite serializes them, which is sufficient.
- Cancelling WaitingSource is durable: later source settlement does not revive it.
- Cancelling an admitted report delegates to run cancellation and records the receipt.

### B7. Polling cost and ownership

**Facts.** [source-read] The runner already polls every 100 ms in one daemon fiber (`runner.ts:133-150`).

**Correction.**

- Poll per **invocation** with any Armed obligation, not per obligation. 16 attachments must not mean 16 polls.
- Use a durable `Armed` index and a bounded batch per tick (for example 200) with a rotating cursor.
- Run the reconciler and promoter inside `tick`, not as separate fibers. Shutdown order then needs no new proof.
- Add a latency proof gate.

## Public shapes left too vague

Add each of these to the draft. The tested forms are in `report.ts`.

1. **Typed source.**

   ```ts
   sourceOf<T extends Task.Contract | Workflow.Definition>(
     target: T
   ): SourceOf<T["spec"]["id"], T["spec"]["version"], KindOf<T>>;
   ```

   `SourceOf<Id, V, K>` is a `Schema.Codec` of `Source & { targetId: Id; targetVersion: V; targetKind: K }`, carrying a phantom identity.

2. **Attachment constructor.**

   ```ts
   Report.make<T extends Target, const S extends Task.Spec>(options: {
     readonly id: string;
     readonly target: T;
     readonly task: Task.Contract<S> & NoInfer<Compatible<T, S>>;
     readonly scope?: T extends Workflow.Definition ? "run" : "run" | "invocation";
     readonly on?: readonly Report.Status[];
     readonly execution?: {
       readonly timeout?: string;
       readonly attemptTimeout?: string;
       readonly retry?: {
         readonly attempts: number;
         readonly delay: string;
         readonly when: readonly ErrorTags<S["error"]["Type"]>[];
       };
     };
   }): Report.Attachment<T, S>;
   ```

   `Compatible` requires a `{ markdown: string; data }` success, and an input that is either exactly `Report.Source` or a `SourceOf` with equal identity literals.

3. **`History` shape.** Give the `outcome` overloads exactly, and the `InvocationPage` and `EventPage` item schemas, including the B1 statuses. Name the error codes used: `InvalidBoundary`, `LimitExceeded`, `Unavailable`.
4. **Records versus inputs.** Separate `Source`, which is task input with a non-null status, from `SourceIdentity`, which is the record field with `status: NullOr`. Today the draft says "Source identity fields with nullable status" without naming a schema.
5. **Report record.** Define the status union: `WaitingSource | Queued | Running | Succeeded | Failed | Cancelled | NeedsAttention | NotApplicable`. Add explicit fields `reportRunStatus: NullOr(RunStatus)` (for "Rejected/TimedOut retained") and `notApplicableReason`. Define the formats of `reportId` and `groupId` (B5).
6. **`RunReports` aggregate.** Give the exact counts struct: per status over latest generations, including WaitingSource. `report wait` completes when WaitingSource, Queued, Running and NeedsAttention are all zero.
7. **`Report.test`.** Give the return type (same as `Task.test`), the fixture schemas for `outcome`, `invocations` and `events`, and the refusing default under plain `Task.test`.
8. **CLI exit codes.** State the exit codes for `report get` on NotApplicable and Cancelled records.
9. **`on` at invocation scope.** Say whether `Rejected` is accepted. Under B1, task invocations never have the status Rejected.

## Decisions that must be shown to the user

1. Report runs are visible in default `run list` and in tag-filtered listings, because tags are copied. Both round-1 reviewers recommended hiding them.
2. Reports run on all five terminal statuses by default, including Cancelled and TimedOut. This differs from Swamp.
3. The B1 mapping, including NotApplicable for zero-attempt invocations (also when the run deadline refused the first attempt), and Cancelled with `stoppedBy` for fail-fast siblings.
4. Changing existing `run outputs`: fenced interrupts move from Failed/Defect to Cancelled or TimedOut. This changes public history output.
5. No silent drop. Up to 160,000 obligations per source, unpruned, with per-source bulk cancel as the escape hatch.
6. The report budget numbers and whether permit-queue time counts against report `timeout` (B5.1).
7. Foreground commands never wait for reports and have no report exit code. Waiting is only through `report wait`.
8. Retention gaps: results live in unpruned run history, there is no automatic lake pairing, and Swamp's automatic report retention is not matched.
9. Manual-replay reporters can enter NeedsAttention and need operator resolution.

## Additional proof gates

These add to the draft's list:

- **B1 matrix in a real daemon:**
  - fail-fast sibling;
  - operator cancel during an attempt;
  - run deadline;
  - wait rejection;
  - a root that fails without a fence;
  - zero-attempt dispatch;
  - kill and restart between the interrupt and root projection.
- **Category:** root Domain versus Host failure, both decoded through `outcome(target)` (B2).
- **Install location:** the precedence test from `ctx.ts`, repeated against the real `Application` and interpreter (B3).
- **Retention:** retry a report after restart and get an identical outcome (B4).
- **Fan-out:**
  - a 1000-item fan-out with 16 attachments;
  - a second small source still gets reports within a bounded time;
  - no spurious TimedOut from queueing;
  - 32 NeedsAttention reports do not stall admission;
  - bulk cancel (B5).

## Summary

Apply the corrections in B1–B7 and add the nine shapes to the draft. With those in place, the Effect/durability reviewer considers the draft ready to present to the user. That presentation is where approval is decided. This review is not that approval.
