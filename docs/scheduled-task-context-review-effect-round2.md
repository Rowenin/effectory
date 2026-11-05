# Scheduled task context — Effect review, round 2

Reviewer: Claude (Effect perspective). Target: revision 2 of `docs/scheduled-task-context-api-draft.md`. Inputs: both round-1 reviews, the current source, and scratch probes against `effect@4.0.5` run with `bun -e` from the repository root. No files were written by the probes.

This review does not approve implementation. Reviewer approval is not user approval. Scheduling is implemented; occurrence context is not implemented and not approved.

**Verdict: CONDITIONAL APPROVE FOR PRESENTATION.** Revision 2 resolves all four of my round-1 blockers and all five required clarifications. I found no new design blocker. Two precise text corrections, C1 and C2, are still needed. Once they are applied, the draft is ready to present to the user without another review round. C3 to C5 are optional.

Labels: **[fact]** means I checked it in source or with a probe. **[inference]** means reasoning I did not test.

## Round-1 blockers

| Round 1 | Status | Evidence |
| --- | --- | --- |
| B1. Schema owner, no protocol→Task edge | **Resolved** | There is one canonical `WorkflowSchedule.Occurrence`, defined in a leaf module that imports only `effect`. `ScheduleProvenance` becomes an alias. The task context uses a type-only import. The draft now states the new protocol→core edge plainly and corrects the earlier overstatement. **[fact]** `packages/runtime/package.json` declares `@effectory/core`. The `./internal/boundary` export pattern already exists. `workflow-schedule.ts` imports `Schema` at runtime, so re-exporting from it costs nothing. |
| B2. Freeze claim, retry mutation | **Resolved** | The draft now says that only the occurrence object is frozen, per attempt, and that the context object keeps its current behavior. Acceptance criterion 3 adds the attempt-1-mutates, attempt-2-observes test. **[fact]** All four fields are primitives, so a shallow `Object.freeze` covers the whole object. A decoded value is fresh but not frozen (`Object.isFrozen` → false), so the freeze has to be explicit, as the draft requires. |
| B3. Exact `scheduledFor` grammar | **Resolved** (deviation accepted; see below) | It is specified as a pattern, a finite-date check and a round-trip check, on `Schema.String`, so the encoded and decoded types both stay `string`. |
| B4. Broken example | **Resolved** | **[fact]** The example now matches the current API: the `Task.make(spec, handler)` shape, `error: Schema.Never` as in `examples/greeting`, `Task.test(task, { input })` extended with one key, `yield*` inside `Effect.gen`, and `Clock.currentTimeMillis` as an Effect in 4.0.5. The `Hourly`/`Report` dangling references are gone. The example is labeled unimplemented and not typechecked. |

The round-1 clarifications are also resolved:

- **Stored-row failure.** A malformed stored occurrence fails with `Unavailable`. **[fact]** `getRun` throws inside the store's try, and `storageError` maps that throw to `Unavailable`. **[inference]** The run-history page throws the same way.
- **History schemas.** `Admitted` reuses `Occurrence.fields`.
- **Absence.** An absent occurrence is represented by omitting the key.
- **Build scope.** Durability is scoped to a single host build.
- **Strict fixture decoding.** **[fact]** `onExcessProperty: "error"` exists in 4.0.5 and rejects `{…, x: 1}` with "Expected no excess property at ["x"]". It applies only to the fixture, because stored rows keep the default decode.

## The two deliberate deviations

### Extended-year timestamps: agree

**[fact, probe]** The pattern plus round-trip check accepts exactly the strings that `Date#toISOString` can produce:

| Input | Result |
| --- | --- |
| `2026-11-05T10:00:00.000Z` | accepted |
| `+275760-09-13T00:00:00.000Z` | accepted (maximum Date) |
| `-000001-01-01T00:00:00.000Z` | accepted |
| `-000000-01-01T00:00:00.000Z` | rejected (NaN, which `toISOString` never produces) |
| `+002026-11-05T10:00:00.000Z` | rejected (round-trip mismatch) |
| `2026-02-30T00:00:00.000Z` | rejected |
| `2026-11-05T10:00:00Z` | rejected |
| `+275760-09-13T00:00:00.001Z` | rejected (out of range) |

This preserves every instant that `schedule-store.ts` can emit through `new Date(ms).toISOString()`, without adding a second restriction. My round-1 four-digit pattern would have made some valid generated values undecodable. The draft's choice is better.

The example's `slot-${Date.parse(…)}` label stays a valid identifier for negative and extended years. For example, `slot--62198755200000` is valid, because `-` is allowed after the first character.

### Reject noncanonical fixtures instead of normalizing them: agree

Normalizing would need either a transformation, which makes `Encoded` differ from `Type` and breaks the "both are strings" property, or a second fixture-only schema. Either one splits the boundary the draft is trying to unify. Rejecting keeps one schema for the wire, history and fixtures. The cost is ergonomic, and it is covered by the requirement that the diagnostic names the field.

## Corrections required before presentation

### C1. JSON Schema emission is under-specified, and the obvious implementation silently drops the pattern

**[fact, probe, effect 4.0.5]** `Schema.isPattern` exports `pattern` to JSON Schema only when the RegExp flags match `/^[dg]*uy?$/`, which means the regex needs the `u` flag (see `Schema.js` `isPattern`, `canExport`). Without `u`, the conversion silently emits plain `{"type":"string"}`. An unannotated `Schema.makeFilter`, such as the round-trip check, is also silently omitted; it does not throw. I observed:

- `Schema.String.check(Schema.isPattern(/^…Z$/))` → `{"type":"string"}`
- `Schema.String.check(Schema.isPattern(/^…Z$/u), Schema.makeFilter(roundTrip))` → `{"type":"string","pattern":"^(?:[0-9]{4}|[+-][0-9]{6})-…Z$"}`
- `Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))` → `{"type":"integer","minimum":1,"maximum":9007199254740991}`

This matters because `control-plane.ts:115–119` publishes task success schemas through `Schema.toJsonSchemaDocument`, and criterion 9 makes Occurrence usable as a success schema.

**Counterexample:** the implementation writes the draft's regex literally, which has no flag. Criterion 9 as worded ("can be … converted to a JSON Schema document; custom validation checks must carry the necessary annotations") still passes, because conversion succeeds. Describe output then advertises any string as a valid `scheduledFor` or `scheduleId`.

**Minimal fix:** replace the second clause of criterion 9 with:

> `scheduleId` and `scheduledFor` use `Schema.isPattern` with the `u` flag so `toJsonSchemaDocument` emits `pattern`; `generation` emits `minimum: 1`. The finite-date/round-trip check is decoder-only and intentionally absent from JSON Schema, which is therefore looser than decoding. A test asserts the emitted document.

Also add `u` to the grammar in "Schema and meaning", or say that the pattern is compiled with `u`.

### C2. "Explicit undefined is rejected at runtime" needs a key-presence rule

**Counterexample [inference]:** a natural implementation is `options.occurrence === undefined ? omit : decode(options.occurrence)`. A JavaScript caller, or a cast past exact optional property types, that passes `{ input, occurrence: undefined }` would then be treated as omitted without any error. The draft's claim would be false, and so would the negative test in criterion 1.

**Minimal fix:** in the "Public decision" paragraph, after "Explicit undefined is also rejected by fixture validation at runtime", add:

> (decided by key presence — `"occurrence" in options` — not by value; a present key is always decoded, and decoding `undefined` fails).

**[fact]** Decoding `undefined` with the struct does fail. The mechanism works once the rule is stated.

## Optional, non-blocking

- **C3. Type spelling.** The draft writes `readonly occurrence?: typeof WorkflowSchedule.Occurrence.Type` while also requiring a type-only import from the leaf. Writing `typeof Occurrence.Type`, with `Occurrence` imported type-only from the leaf module, avoids implying a `task.ts`→`workflow-schedule.ts` import. Consider also exporting a named type, such as `WorkflowSchedule.Occurrence` as both value and type, so consumers do not have to write `typeof …Type`.
- **C4. Generated host modules.** **[fact]** A new `@effectory/core/internal/…` export must be added to `packages/platform-bun/src/host-modules.generated.ts` by running `scripts/generate-host-modules.ts`. `build-binary.ts` runs that script with `--check`. The new core file also changes `sourceAbi`, which is an existing restriction the draft already notes. One line in criterion 10 would cover this. This is independent of the concurrent compilation and SDK work, and this review does not touch that work.
- **C5. Fixture diagnostic.** **[fact]** `boundary()` (`task.ts:108–119`) replaces every non-`TaskRuntimeError` message with "Task boundary validation failed". For the fixture error to name its field, the code must construct `TaskRuntimeError("InvalidBoundary", …)` directly, using the first issue path, rather than wrap the decode in `boundary()`. The draft already states the required outcome, so this is an implementation note only.

## Confirmed, no change needed

- **Lazy validation.** Validating inside the existing `Effect.suspend` of `Task.test` (`task.ts:254`) keeps the call free of side effects until it runs. Re-running the same Effect re-decodes and re-freezes, which matches "captured at evaluation".
- **Requirements.** No `R` or Layer changes. `contextFor` spreads `...runtime` (`task.ts:126`), so a conditionally present `occurrence` key passes through to `TaskContext` unchanged and keeps its absence under exact optional property types.
- **Inheritance.** Inheritance through children, fan-out, patches and replacements, and the per-attempt fresh context, both still match the interpreter facts from round 1.
- **Plain ISO string.** Keeping `scheduledFor` as an ISO string rather than `DateTime.Utc` is consistent with the wire and the JSON Schema story.

## Summary for the parent

**Conditional APPROVE FOR PRESENTATION.** All round-1 Effect blockers and clarifications are resolved. Both deviations are accepted: extended years are the exact `toISOString` image, and rejecting noncanonical fixtures keeps one boundary.

Apply these before presenting:

- **C1:** criterion 9 must require `isPattern(/…/u)` and state that the round-trip check is decoder-only in JSON Schema. Verified on 4.0.5: without `u`, the pattern is silently dropped.
- **C2:** the runtime rejection of explicit `undefined` is decided by key presence.

No further review round is needed for these two edits. This is not user approval, and implementation still waits for the user.
