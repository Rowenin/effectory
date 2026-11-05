# Scheduled task context — consumer review, round 1

Reviewer: Claude (consumer perspective). Subject: `docs/scheduled-task-context-api-draft.md`.

**Verdict: REQUEST CHANGES.** Do not present this to the user yet. The shape is mostly right: optional, read-only metadata on the existing `TaskContext`, no new Layer or handler parameter, and inheritance from the host run. But the draft says the field helps tasks decide "which time window to process", and it has not checked that use case against how the scheduler actually emits slots. Several obvious consumer idioms fail or mislead today. All the fixes below are documentation or naming changes. None of them needs new runtime mechanism.

Reviewer approval is not user approval. This proposal is still **NOT APPROVED** for implementation.

Labels used below:

- **[fact]**: inspected in source, or observed in a scratch probe.
- **[inference]**: reasoning from the inspected facts.
- **[untested]**: an API example that does not compile against the current code, because the API does not exist yet.

---

## What I verified

- **[fact] One context constructor covers every handler.** `packages/platform-bun/src/interpreter.ts:65` (`taskContext`) is the only place a production `Task.RuntimeContext` is built. It is called from `leafExecution` (`:205`), which reloads the run with `store.getRun(runId)` (`:156`). These all reach `leafExecution` with the host `runId`:
  - linked child workflows (`case "Workflow"` → `executeChild`, `:885`)
  - branches and fan-out (`:879`, `:882`)
  - before-step patch graphs (`node.patches`, `:802`)
  - replacement implementations, which come from the same pinned `registry.tasks`

  So the inheritance claim (children, fan-out and extensions see the root occurrence) is consistent with the code. I did not run a test to confirm it.

- **[fact] Persisted metadata is decoded on every handler attempt.** `host-store.ts:233-249` decodes `Run` from SQLite, including `scheduleJson`, using the runtime `Run` schema. That supports "retries and restarts see the same frozen values". The decoded object is not frozen today, so the draft is right that copy-and-freeze must be new work.
- **[fact] The Swamp citation is right in substance but points at the wrong file.** The prose the draft quotes for "lines 2840–2865" is in `vendor/swamp/design/primitives/workflows.md:2838-2860`, not in `schedule_catch_up.ts`. Swamp's catch-up runs carry both tags, and on-time cron runs carry only `scheduledFor` (`src/libswamp/workflows/scheduled_execution.ts:1823-1824`).

## Blockers

### B1. "Which time window to process" overclaims. Coalesced and missed slots are invisible.

**[fact]** `schedule-store.ts:399-449` (`tick`) admits only `due.latest`. Older due slots are recorded as _missed_ and never run. The same happens to slots skipped for `Paused` or `Overlap`. A definition edit also resets the watermark to `now` (`:351-360`), so slots between the edit and `now` are skipped as well.

**[inference] Counterexample.** Take an hourly report with `catchUp: { latestWithin: "3h" }`. The host is down 09:30–12:10. Only one run is admitted: `{scheduledFor: "…T12:00:00.000Z", catchUp: true}`. A task written the way the draft invites, processing `[scheduledFor − 1h, scheduledFor)`, silently loses the 09:00–11:00 data. The context cannot tell the task that anything was skipped. It also cannot derive the window start without hard-coding the cron, because cron and zone are deliberately excluded from the context. Non-uniform crons such as `0 9 * * 1-5` make a hard-coded period wrong anyway.

**Smallest fix (documentation only).** Reframe the motivation as _occurrence identity_: which slot is this, and was it admitted late. Do not promise windowing. State explicitly:

- Consecutive scheduled runs do **not** imply contiguous windows.
- Missed slots are visible only through schedule history.
- A task that needs gap-free coverage must keep its own watermark, for example in its own artifact or store, and treat `scheduledFor` as the upper bound.

Adding `previousSlot` or the cron to the context would be a separate proposal. Do not slip it into this one.

### B2. The natural idempotency idiom fails with an opaque error.

**[fact]** `identifier()` (`packages/core/src/boundary.ts:9`) allows only `[a-zA-Z0-9._/-]`. The canonical slot string `2026-11-05T10:00:00.000Z` contains `:`. In a scratch probe (outside the repo), `context.key(slot)` inside `Task.test` failed with `TaskRuntimeError{code:"InvalidBoundary", message:"Task boundary validation failed"}`. The message does not mention the key. Publication keys (`options.key`) go through the same `identifier()` (`task.ts:137`).

**[inference]** The first thing an occurrence-aware, `replay: "idempotent"` task will do is key its publication by slot: `publish("report", value, { key: context.schedule.scheduledFor })`. That fails at runtime, and the type system gives no warning.

**Smallest fix.** Pick one of these and say which in the draft:

- (a) Document a key-safe transform in the example, for example `scheduledFor.replaceAll(":", "")` or epoch milliseconds, and add an acceptance criterion that the documented idiom works with `publish` and `key`.
- (b) Expose a derived key-safe form.

(a) costs nothing and is enough for presentation. Either way, the example must show a real per-occurrence publication, not only string interpolation.

### B3. `generation` is described in a way consumers will misread.

**[fact]** `generation` comes from a _host-wide_ counter (`UPDATE host_scheduler SET generation = generation + 1`, `schedule-store.ts:344`). It is bumped whenever _any_ field of a schedule's identity digest changes: cron, zone, input, catch-up, workflow id or workflow **version**. A description-only change does not bump it. Per-schedule values are therefore opaque, monotonic and non-contiguous. The draft's fixture uses `generation: 1`, and its only description is "positive safe integer".

**[inference]** Consumers will read `generation` as "edit count of this schedule" and write code like `generation === 1` for the "first config" case, or compare generations across schedules. Bumping a workflow version silently changes the value.

**Smallest fix.** Define it in the draft as an opaque, host-assigned, monotonic token that changes when the schedule's effective definition changes. Say it is only meaningful for equality within one `scheduleId`. Use a non-1 value in the fixture example so the opacity is visible. If no consumer use case for `generation` can be named, consider leaving it out of the handler-facing type and keeping it on run inspection only. Dropping it later would be a breaking change; adding it later would not.

### B4. Naming is unresolved, and `schedule` names the wrong thing.

**[inference]** `context.schedule` reads like the _definition_ (cron, zone), and the draft deliberately excludes exactly that. It also stutters: `context.schedule.scheduleId`. The draft introduces a second public name for the same four fields: `Task.ScheduleContext` next to the existing runtime `ScheduleProvenance`. It also defers its own namespace question ("Evaluate whether … before approval"). Presenting an API with an open naming question invites approval of something that will change.

**Smallest fix.** Choose before presentation and give a one-line rationale. My preference is `context.occurrence?: Task.Occurrence`, with fields `{scheduleId, generation, scheduledFor, catchUp}`. That reads correctly, as "the occurrence that triggered this run". Keep `ScheduleProvenance` as a runtime alias of the same schema, as the draft already proposes. Other names are fine if the draft argues for them. Leaving it open is not.

### B5. Define what `catchUp` does and does not mean relative to handler time.

**[fact]**

- `catchUp` is true only when admission happened more than `scheduleGrace` (60 s, `schedule-decision.ts:3`) after the slot and within `latestWithin`.
- An on-time admission can still wait in `Queued` behind global or workflow permits (`resources.global.withPermits`, `interpreter.ts:249`), or retry for hours.
- `attemptStartedAt` exists in the store but is not exposed.

**[inference]** `catchUp: false` does **not** mean "running promptly". A consumer that uses `catchUp` as a staleness gate ("skip if stale") will process hour-old data as fresh. The draft only says that `scheduledFor` is "not handler start time".

**Smallest fix.**

- Add a sentence: `catchUp` describes admission lateness only. It does not describe queue delay or retry delay. For staleness, compare `scheduledFor` against `Clock.currentTimeMillis` in the handler.
- Mention the 60-second grace.
- Show this in one example. That example is also the natural Swamp parity case, "workflow can read the tag and decline": a task returns a skip decision, and `graph.branch` uses it.

## Non-blocking, but fix in the same pass

- **Wording about absence.** **[fact]** The root tsconfig has `exactOptionalPropertyTypes: true`. "Omitted property/undefined" should just say _omitted_: the key is absent, `"schedule" in context` is false, and a fixture `schedule: undefined` is a compile error. `contextFor`'s spread (`task.ts:127`) preserves absence. **[inference]** If the value ever arrives as an explicit `undefined`, `Object.keys` snapshots would change, so specify absent-key behavior in acceptance criterion 2.
- **Fixture errors must name the field.** **[fact]** `boundary()` (`task.ts:108-119`) replaces every message with "Task boundary validation failed". Under this draft, an invalid `scheduledFor` fixture such as `"2026-11-05T10:00:00Z"`, which lacks milliseconds, fails with the same code and message as a bad `input`. Require a distinct message, for example `Invalid schedule fixture: scheduledFor must be Date#toISOString form`, and add a test for it. The exact `toISOString` requirement will surprise people. Mention it next to the fixture example, or accept any ISO instant in the fixture and canonicalize it. Canonicalizing is my preference, because production output is already canonical.
- **Test scope.** **[inference]** `Task.test` covers one handler. Consumers who branch on the occurrence at the workflow level, for example "decline catch-up", have no harness short of a real host. Say so plainly so the parity section does not imply workflow-level testability.
- **The example is broken.** `const result = yield * Task.test(...)` sits outside `Effect.gen` and is formatter-mangled (`yield *`). `Report` is undefined. Wrap the example in `Effect.gen(function* () { … })` and mark every snippet **[untested]** until it is implemented.
- **Decode tightening affects inspection, not just handlers.** **[inference]** Swapping `ScheduleProvenance` for the stricter schema means `getRun`'s `decodeUnknownSync` (`host-store.ts:240`) would throw on any malformed stored row. That breaks Get, List and Watch for that run, not only exposure to the handler. Valid emissions are unaffected (`iso()` and `identifier`-checked IDs). Still, acceptance criterion 7 should state what happens to a corrupt row: whether it surfaces as a storage error, and which one.
- **Manual run of a scheduled workflow.** Agreed: absent. Also say that rerunning or resubmitting a failed scheduled run, if that is ever added, will need its own decision. I found no rerun operation today.

## Preferences (not required)

- Allow the fixture to omit `scheduleId` and `generation`, with documented test defaults. Most handler tests care only about `scheduledFor` and `catchUp`. Explicit required fields are acceptable if B3 keeps `generation`.
- One sentence pointing consumers at Effect `DateTime.make(scheduledFor)` so that "parse it yourself" is a concrete instruction.

## Source compatibility

**[inference]** Adding an optional readonly field to `TaskContext` and `RuntimeContext` is source-compatible for consumers who read contexts or construct their own `RuntimeContext` (it is optional). `Task.test`'s options gain an optional key, and existing calls are unchanged. Two caveats:

- The runtime `ScheduleProvenance` export becomes stricter, as described above.
- A rename under B4 should happen _now_, while nothing has shipped.

## Summary of required changes before presentation

1. Reframe the motivation from windowing to occurrence identity, and document missed and coalesced slots plus the watermark advice.
2. Make the per-occurrence key and publication idiom work, and show it in the example.
3. Define `generation` as an opaque, host-wide token, or drop it from the handler type.
4. Resolve the name: `occurrence`/`Occurrence` recommended, with one canonical schema.
5. Define `catchUp` precisely against grace, queueing and retries, with a staleness example that uses `Clock`.
