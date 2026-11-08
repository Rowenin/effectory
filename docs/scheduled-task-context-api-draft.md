# Scheduled task context — revision 3, APPROVED

Approved by the user after both Claude reviews and the corrections below. Implemented as optional task context metadata and a Task.test fixture; durable scheduling retains its separate approved contract. The runnable scheduled example and tests exercise the implemented API. Illustrative snippets in this document are not independently typechecked.

## Capability and source evidence

Expose **which scheduled occurrence a task belongs to** through its existing handler context. Swamp exposes `swamp.trigger.scheduledFor` and `swamp.trigger.catchUp` through run tags: see `vendor/swamp/src/domain/workflows/schedule_catch_up.ts:33`, `vendor/swamp/design/primitives/workflows.md:2840–2865`, and `MethodContext.runtimeTags` in `vendor/swamp/src/domain/models/model.ts`. Effectory already persists equivalent structured provenance on Run/RunSummary, but handlers cannot read it directly.

An occurrence is not a contiguous processing window. The scheduler admits only the latest eligible slot; overlap, pauses, edits and downtime can leave gaps. Tasks needing complete historical coverage must maintain their own durable business watermark. Neither cron cadence nor a previous successfully processed slot can be inferred from this context. Skipped slots are visible in schedule history.

This slice does not add arbitrary run tags, automatic artifact tag propagation, cron configuration to handler context, or graph construction access to runtime metadata. Those are separate parity gaps.

## Public decision

- Handler field: `context.occurrence`.
- Canonical schema: `WorkflowSchedule.Occurrence`.
- Test fixture: `Task.test(task, { input, occurrence? })`.
- Existing wire field `Run.schedule` and the existing runtime `ScheduleProvenance` export retain their names. `ScheduleProvenance` becomes a compatibility alias of the canonical schema, not another competing authoring name.

`Task.RuntimeContext` and `Task.TaskContext` gain an optional readonly occurrence field, publicly typed as `typeof WorkflowSchedule.Occurrence.Type`. Internally, the declaration uses `typeof Occurrence.Type` with a type-only import from the schema leaf module, not an import from workflow-schedule.ts. Keep it out of `Task.Identity`, which also feeds lake publication identity. No service requirement, new Layer, declaration option or handler argument is added.

The property is **omitted** for manual WorkflowRun, direct TaskRun and ordinary Task.test. Reading it yields undefined. With exact optional property types, explicitly passing `{ occurrence: undefined }` to Task.test is not accepted; conditionally spread the property or omit it. Explicit undefined is also rejected by fixture validation at runtime, decided by key presence (`"occurrence" in options`), not by value: a present key is always decoded, and decoding undefined fails. There is no null alternative.

## Proposed example — unimplemented, not typechecked

```ts
import { Task } from "@offtree/effectory-sdk";
import { Clock, Effect, Schema } from "effect";

const Collect = Task.make(
  {
    id: "reports/collect",
    version: 1,
    input: Schema.Struct({ project: Schema.String }),
    success: Schema.Struct({
      label: Schema.String,
      stale: Schema.Boolean,
      key: Schema.String,
    }),
    error: Schema.Never,
    replay: "idempotent",
  },
  (input, context) =>
    Effect.gen(function* () {
      const occurrence = context.occurrence;
      const now = yield* Clock.currentTimeMillis;
      if (occurrence === undefined) {
        return {
          label: `Manual collection for ${input.project}`,
          stale: false,
          key: context.key("collection"),
        };
      }
      const slot = Date.parse(occurrence.scheduledFor);
      return {
        label: `Collect ${input.project} for ${occurrence.scheduledFor}`,
        stale: now - slot > 3_600_000,
        key: context.key(`slot-${slot}`),
      };
    })
);

// Existing WorkflowSchedule.make/Application registration is unchanged.
// Provide TestClock when asserting the clock-dependent stale result.
// For fixture timestamps, new Date(...).toISOString() supplies the canonical form.
export const example = Effect.gen(function* () {
  return yield* Task.test(Collect, {
    input: { project: "example" },
    occurrence: {
      scheduleId: "reports-hourly",
      generation: 7,
      scheduledFor: "2026-11-05T10:00:00.000Z",
      catchUp: true,
    },
  });
});
```

The example's one-hour staleness threshold is a task-specific decision, not a scheduler guarantee; production tasks decide whether to process or reject stale work. Tests of clock-dependent decisions can provide Effect TestClock.

`context.key` remains scoped to the run and invocation path. Its name must obey the existing identifier grammar: a raw ISO timestamp contains forbidden colons, so do not pass it directly. The `slot-${Date.parse(...)}` label above is valid; simply using a fixed name such as `collection` is also sufficient for retries of one invocation. Neither recipe deduplicates independent manually submitted runs or proves complete business-period coverage.

For `publish`, `options.key` uses the same identifier grammar. It also determines artifact identity across runs within the same principal, task and output. This proposed snippet assumes a declared output and a defined occurrence:

```ts
// Illustrative publication fragment; assumes a declared output and defined occurrence.
const publication = context.publish(output, value, {
  key: `slot-${Date.parse(occurrence.scheduledFor)}`,
});
```

This gives one versioned artifact per slot within that scope: a later run publishing the same key adds a new version. It does not deduplicate runs or prove coverage.

## Schema and meaning

`WorkflowSchedule.Occurrence` is an Effect Schema struct with readonly fields:

- `scheduleId`: existing identifier grammar `[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}`.
- `generation`: a positive safe integer drawn from a host-wide counter (one per host store). Treat it as an opaque equality token within one schedule ID; it is not a per-schedule edit count. Tokens can jump because other schedules changed. Every effective definition change, and re-adding a removed schedule, assigns a new token. Description-only edits do not. Comparing tokens within one schedule ID tells a consumer whether occurrences came from different effective definitions; it does not identify a time window.
- `scheduledFor`: the canonical UTC occurrence timestamp, not handler start time. Encoded and decoded values are both strings. Exact grammar: `^(?:[0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$`, compiled with the `u` flag in `Schema.isPattern`, followed by a finite-date check and `new Date(value).toISOString() === value`. This deliberately includes Date's extended-year form so previously valid generated instants remain representable. Missing milliseconds, offsets and impossible dates are rejected, not normalized. The usual form is `2026-11-05T10:00:00.000Z`.
- `catchUp`: admission was more than the scheduler's 60-second grace after its slot and permitted by latestWithin. It is fixed at admission. False does not mean the handler is timely: queueing, waits and retries can delay execution for hours. Use Effect Clock and scheduledFor to calculate actual staleness. Swamp's tag is present only for catch-up; Effectory deliberately uses a boolean on every occurrence.

The schema lives in a small internal core leaf module importing only `effect`. WorkflowSchedule re-exports it as Occurrence; task context declarations use a type-only import. Runtime protocol imports the leaf through an internal package export and retains `ScheduleProvenance` as an alias. This introduces a deliberate protocol-to-core schema dependency; it must not load Task, Workflow builders, Application or their execution helpers. Runtime already declares core as a package dependency but currently does not import it in protocol source; the earlier draft overstated this.

Reuse Occurrence.fields for ScheduleHistoryEntry.Admitted too. Run, RunSummary/watch and admitted schedule history must validate the same occurrence. Existing wire property names remain unchanged. A malformed or manually edited stored occurrence now fails the existing Unavailable error boundary when that run is read, including Get/Watch and any history page that contains it; no fabricated default or silent row omission is allowed. No migration across host builds is claimed.

## Durability and inheritance

A fresh context for each handler attempt receives its own frozen occurrence copy, derived from the run's stored provenance. The surrounding context object retains its existing behavior; only the occurrence object is frozen. A cast or JavaScript replacement of one handler's local context property must not mutate the stored run or another handler's snapshot. A mutation attempt in a failing first attempt must not affect the retry.

All tasks belonging to the same host run inherit the occurrence: normal nodes, linked children, branches, keyed fan-out, extension replacements and before-step patches. Children are not separately scheduled runs. Native leaf workflows must retain this host context. Production obtains it from the accepted run, not from today's schedule definition or current clock.

Recorded successes remain recorded. Retried/resumed handlers see identical occurrence fields. Later schedule edits, generation changes, pause or removal cannot rewrite accepted run metadata. A new manually submitted run has no occurrence even if its input or printed request key copies a scheduled run.

This is execution-time context. Workflow.make construction and graph.map pure callbacks cannot read it. A task can return a schema-checked occurrence-derived value for graph.branch to consume as a recorded result. Task.test covers one handler attempt and does not test graph-level branching, inheritance or durable retries.

## Task.test validation

Fixture validation stays inside the existing Effect.suspend, before the handler runs. Strictly decode with `onExcessProperty: "error"`, make an independent frozen copy, and preserve existing task input inference, error types and service requirements. An invalid fixture fails TaskRuntimeError with code InvalidBoundary and a bounded diagnostic naming the occurrence field that failed and its expected form; it does not synchronously throw when Task.test is called. Input errors and occurrence-fixture errors must be distinguishable in that message. For example: "occurrence.scheduledFor must be canonical UTC as produced by Date#toISOString, e.g. 2026-11-05T10:00:00.000Z".

A fixture need not name a real schedule or application. Defaults, publication shape and test result shape stay unchanged. Canonical timestamps intentionally match the real protocol; convenience normalization is deferred rather than making the harness accept a different boundary.

## Acceptance criteria after user approval

1. Compile-positive handlers and fixtures; negative field types, mutation, explicit undefined, excess literals, and missing task services.
2. Manual workflow/direct task runs and default Task.test omit occurrence. Invalid fixtures fail lazily before handler execution and identify their field.
3. Fixture copy is captured at evaluation and is isolated from caller mutation after evaluation; each production invocation receives a separate frozen copy. Attempt 1 mutation cannot leak into attempt 2.
4. Real scheduled execution returns the stored occurrence; linked children, fan-out, replacement implementations and before-step patches receive the same values.
5. Retry and kill/restart within the same host build preserve all four fields. Existing host ABI upgrade restrictions remain applicable.
6. The key-safe label in the example succeeds and is stable within one invocation; its run-scoped nature is tested/documented. The same label is accepted as a `publish` key, and later runs using it within the same principal/task/output add versions of the same artifact.
7. Tests show catchUp=false with a delayed handler and show skipped slots do not manufacture contiguous business windows. Generation equality is tested without assuming consecutive numbers per ID.
8. Canonical normal/extended-year timestamps round-trip; missing milliseconds, non-UTC offsets, invalid dates and invalid generations are rejected.
9. The occurrence schema can be used as a task success schema and converted to a JSON Schema document; `scheduleId` and `scheduledFor` use `Schema.isPattern` with the `u` flag so `toJsonSchemaDocument` emits `pattern`; `generation` emits `minimum: 1`. The finite-date/round-trip check is decoder-only and intentionally absent from JSON Schema, which is therefore looser than decoding. A test asserts the emitted document. Run/Get/List/Watch and admitted history share the schema, including malformed stored-row behavior. Artifact publication/query behavior and manual shapes remain unchanged.
10. Regenerate `host-modules.generated.ts` with `scripts/generate-host-modules.ts` for the new internal core export, and check the generated table. Repository typecheck, lint/format and behavior checks pass.

## Round-1 review resolution

Both reviews requested changes. This revision chooses occurrence terminology and one canonical WorkflowSchedule.Occurrence schema in a leaf module; distinguishes occurrence identity from continuous processing coverage; defines generation and catchUp precisely; states omitted-key absence and copy/freeze boundaries; fixes and labels the example; shows safe keys and a handler-clock staleness check; and documents strict fixture/stored-row failure behavior.

Two non-blocking recommendations differ: timestamps retain canonical extended years instead of imposing a new four-digit restriction, and test fixtures reject noncanonical ISO forms instead of normalizing them. The rationale is preserving the real wire boundary. Both round-2 reviewers explicitly accepted these choices. Reviewer approval is never user approval.

## Round-2 consumer resolution

The consumer reviewer conditionally approved presentation once C1–C3 were applied, without another review. All three are applied: publication keys and their cross-run artifact scope are explained and specified in the acceptance criteria; generation is a host-wide token assigned on every effective change/re-add; and fixture diagnostics/example guidance state the canonical timestamp form. The reviewer accepted both deliberate timestamp choices. The Effect round-2 conditions are also applied below. This is not user approval and does not authorize implementation.

## Round-2 Effect resolution and presentation gate

The Effect reviewer conditionally approved presentation after C1 and C2, with no further review required. Both are applied: the document requires Unicode-flagged schema patterns and assertions on the emitted JSON Schema while describing the decoder-only date refinement; and explicit undefined is rejected based on key presence. The optional notes are incorporated too: task types import the leaf schema only as a type, the generated host module table must be regenerated, and fixture diagnostics require constructing a field-specific TaskRuntimeError directly rather than using the generic boundary wrapper.

Both review gates are satisfied for presentation. The public API is now awaiting the user's approval. Nothing in this proposal has been implemented, and its examples remain untypechecked.
