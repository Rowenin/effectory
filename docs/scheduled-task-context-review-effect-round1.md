# Scheduled task context — Effect review, round 1

Reviewer: Claude (Effect perspective). Target: `docs/scheduled-task-context-api-draft.md`. This review approves nothing. Approving it for presentation is still not user approval, and nothing here authorizes implementation.

**Verdict: REQUEST CHANGES.** The design direction is sound: an optional plain field on the existing context, no new service, no graph operator. The inheritance and retry claims match the current interpreter. Four small, text-only fixes are needed before the draft goes to the user (B1–B4).

Labels used below: **[fact]** means I inspected it in source or checked it with a scratch probe. **[inference]** means I reasoned it out but did not test it. **[untested]** means an API example that nobody has compiled.

## Claims that hold up

- **[fact] Inheritance is structural.** Every task leaf runs in the host run's `runId`:
  - `invokeTask` builds the payload with `runId: run.runId` (`packages/platform-bun/src/interpreter.ts:327`).
  - Child workflows (`executeChild(run, …)`, `:885`), before-step patches (`executeGraph(run, patch.graph, …)`, `:833`), branches and fan-out all pass the same `run` along.
  - `leafLayer` reloads the run with `store.getRun(runId)` (`:155`) and builds `taskContext(run, …)` on every attempt (`:203`).

  So linked children, fan-out, patches and extension replacements all see the root occurrence once `taskContext` copies `run.schedule`. The native `EffectoryTask/v1` leaf workflow does not erase it.

- **[fact] Metadata does not change after admission.** `scheduleJson` is written once, on `INSERT` (`host-store.ts:534–547`). No `UPDATE host_runs` statement touches it. Schedule edits, pauses and removals therefore cannot rewrite it.
- **[fact] Direct TaskRun is never scheduled.** `WorkflowSchedule.make` accepts only a workflow, and the scheduler always submits `kind: "workflow"` (`schedule-store.ts:443–450`).
- **[fact] Valid scheduler output already meets the proposed constraints:**
  - `generation` starts at 1, because the counter is seeded at 0 and incremented before use (`schedule-store.ts:110, 344–350`).
  - `scheduleId` comes from `identifier()`, which allows at most 200 characters (`boundary.ts:9`).
  - `scheduledFor = new Date(ms).toISOString()` (`schedule-store.ts:66, 449`).
- **[fact, probe]** The current `ScheduleProvenance` accepts `generation: 0`. `Schema.Int` already rejects 2^60, so the bound is already a safe integer. Decoding returns a fresh object that is not frozen.
- **[fact] Keeping the field out of `Task.Identity` is correct.** `lake.publish` takes only `Task.Identity` (`lake.ts:182`; `interpreter.ts:97`).
- **[fact] Services are preserved.** `Definition.provide` (`task.ts:163`) and the Application registry wrapper (`application.ts:118`) pass `context` through unchanged. The new field does not touch `R`, so requirements inference is unaffected.
- **[fact] Lazy validation is feasible.** `Task.test` already runs its whole body inside `Effect.suspend` (`task.ts:254`), and the `boundary()` helper already maps thrown errors to `TaskRuntimeError("InvalidBoundary")`. Validating the fixture inside that suspend keeps it lazy and leaves the error type unchanged.
- **[inference] A context field beats a service.** A `Context.Service` for the occurrence would add a requirement to every task that uses it. Application `Requirements` are inferred from task `R` (`application.ts:13`), so the host would have to provide the service. Manual runs would then need either an `Option`-valued service or `Effect.serviceOption`, which hides the dependency from the types. A plain field matches how `key`, `publish` and `progress` already work. I agree with the draft.
- **[fact] The Swamp citations check out.**
  - `SCHEDULED_FOR_TAG` and `CATCH_UP_TAG` are at `schedule_catch_up.ts:33,35`.
  - `runtimeTags` is at `model.ts:254`.
  - The design passage is at `vendor/swamp/design/primitives/workflows.md:2840–2865`. The draft gives no path for it; it should cite one.
  - Swamp sets the catch-up tag only on catch-up runs. Effectory always has a boolean. That difference is fine but should be stated as deliberate.

## Blockers

### B1. Pick one schema owner and avoid a new protocol→core runtime edge

**[fact]** No file in `packages/runtime/src` imports `@effectory/core` today. Every protocol module imports only `effect`. The draft's claim that runtime "already permit[s] importing core" is true only of `package.json`.

If `ScheduleProvenance` reuses `Task.ScheduleContext`, then `protocol.ts` loads `@effectory/core/Task` into every RPC, CLI and history consumer. That module brings in `boundary`, `errors`, `json-budget` and `Layer`. This would be the first runtime-level edge from protocol to core.

The draft also leaves the namespace open ("Evaluate whether…"), and it would introduce two public names, `ScheduleContext` and `ScheduleProvenance`, for one schema.

**Counterexample:** a client that only decodes `RunSummary` would start evaluating task-authoring code.

**Smallest fix:** decide in the draft. My recommendation:

- Put the schema in a leaf module that imports only `effect`, for example `packages/core/src/schedule-occurrence.ts`.
- Export it publicly as `WorkflowSchedule.Occurrence`. Scheduling owns the concept, and `workflow-schedule.ts` already imports `Schema` at runtime.
- Have `Task.TaskContext` and `Task.RuntimeContext` reference it through a type-only import.
- Have `protocol.ts` import the leaf module through a package export, as `./internal/boundary` already works, and keep `ScheduleProvenance` as an alias.

If the user prefers `Task.ScheduleContext`, use that, but still ship it from the leaf module. Either way, state which name is canonical.

### B2. The runtime read-only claim is false as worded, and there is a retry-mutation hazard

**[fact]** `contextFor` returns a plain object literal that is not frozen (`task.ts:125`), and so does the `Task.test` runtime (`task.ts:261`). Identity fields are readonly in TypeScript only.

**[fact]** `leafLayer` fetches `run` once, before the attempt loop (`interpreter.ts:155–167`), and reuses it for every attempt.

**Counterexample [inference]:** suppose an implementation passes `run.schedule` by reference without freezing it. Attempt 1 does `(context.schedule as any).catchUp = false`, then fails with a retryable error. Attempt 2 now sees the mutated value, which breaks "retried handlers receive the same occurrence."

**Smallest fix:** reword the claim: "the `schedule` object is a frozen copy made per invocation context; each invocation gets its own context object." Do not claim that `TaskContext` itself is frozen unless you also propose freezing it, which would change behavior for the existing fields. Add an acceptance test where attempt 1 mutates via a cast and attempt 2 observes the original value. That test also covers the `Task.test` copy-and-freeze requirement.

### B3. Define the `scheduledFor` grammar exactly

"Exactly `Date.toISOString()` form" includes the extended-year output `+275760-09-13T00:00:00.000Z` ([fact, probe]) and negative years. The phrase also does not say whether `2026-11-05T10:00:00Z`, with no milliseconds, is rejected.

**Smallest fix:** specify the pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`. In addition, require `new Date(s).toISOString() === s`, which rejects values like `2026-02-30`. Express this as a Schema check on `Schema.String` so the encoded and decoded types stay `string`.

### B4. The consumer example is not valid TypeScript **[untested]**

- `const result = yield * Task.test(…)` appears at top level, outside `Effect.gen`. It looks like a formatter mangled `yield*`.
- `Report` is never defined.
- The `Hourly` schedule never shows how it connects to `Collect`.

The user requires examples to be clearly marked or valid.

**Smallest fix:**

- Wrap the test call in `Effect.gen(function* () { const result = yield* Task.test(…) })`.
- Define `Report` as a one-node workflow that uses `Collect`, or drop `Hourly`.
- Label the block "untested API example."

## Required clarifications (not blockers, but fix in the same pass)

1. **Say what happens when stored metadata fails the tightened schema.** **[fact]** `ScheduleProvenance` is decoded inside `getRun` (`host-store.ts:241`), which serves Get, Watch, `graphLayer` and `leafLayer`. It is also decoded per row in run history (`run-history.ts:81`), so one bad row throws for the whole page. This can only happen with a corrupt or hand-edited database, but the draft should state the outcome: the run becomes uninspectable and fails "Run lookup failed", and history listing errors. The alternative is to validate only at the task-context boundary.
2. **Keep schedule history consistent.** **[fact]** `ScheduleHistoryEntry.Admitted` (`schedule-protocol.ts:81–88`) repeats the four fields with the loose types. Either build it from `Occurrence.fields` plus `runId` and `status`, or say explicitly that schedule history stays loose. Otherwise "schemas still agree" is only partly true.
3. **Choose one absence representation.** The repository sets `exactOptionalPropertyTypes: true`, so "omitted property/undefined" is ambiguous. Specify `readonly schedule?: Occurrence` with the key omitted and never present as `undefined`. For `Task.test`, decide whether to accept `schedule?: Occurrence | undefined` for consumers who forward a possibly-undefined value. If not, say that passing `schedule: undefined` will not compile under exact optional types.
4. **Scope acceptance criterion 6 to one host build.** **[fact]** `sourceAbi()` hashes every `.ts` file in core, runtime protocol and platform-bun (`host-runtime.ts:27–44`). `revisions.ts:166` rejects a revision whose ABI differs. Across a host upgrade, an accepted run cannot resume at all, which is existing behavior. "Kill/restart preserves the occurrence" therefore holds within the same build, and the criterion should say so.
5. **Name the decoder for `Task.test` fixtures.** Use `Schema.decodeUnknownSync(Occurrence)(fixture, { onExcessProperty: "error" })`. [fact, probe] Effect's default silently strips excess keys. Excess-key rejection should apply only to the fixture, not to the stored row decode.

## Preferences (non-blocking)

- I would keep `scheduledFor` as an ISO string rather than an Effect `DateTime.Utc` decoded type. It matches the `Run` protocol, it stays JSON-plain and comparable with `===`, and freezing it is trivial. The draft should say this is a final choice, because changing `Type` to `DateTime` later would be a breaking change.
- Document what `catchUp: true` means in Effectory: the occurrence was admitted after the on-time grace period but within `latestWithin` (`schedule-decision.ts:67–80`). Without that, consumers may read it as "a backlog replay."
- Citing the Swamp design path once removes a reader's guesswork.

## Summary for the parent

REQUEST CHANGES. The blockers are:

- **B1:** decide the schema owner and name, and put the schema in an `effect`-only leaf module so protocol does not load `Task`.
- **B2:** reword the runtime immutability claim to "frozen `schedule` copy, one context per invocation," and add an attempt-mutation test.
- **B3:** give the exact ISO grammar plus a round-trip check.
- **B4:** fix the example so it type-checks (`yield*` inside `Effect.gen`, define `Report`) and mark it untested.

The inheritance, retry and immutability claims are otherwise backed by the current interpreter and store code.
