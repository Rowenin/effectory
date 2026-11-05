# Scheduled task context — consumer review, round 2

Reviewer: Claude (consumer perspective). Subject: revision 2 of `docs/scheduled-task-context-api-draft.md`. I read both round-1 reviews. Scope is limited to round-1 blockers and anything new that revision 2 introduces.

**Verdict: REQUEST CHANGES (text only). I conditionally APPROVE FOR PRESENTATION once C1–C3 below are applied as written.** No re-review is needed for those three edits. All five of my round-1 blockers are resolved in substance. One of them (B2) is only partly resolved: the draft fixed `context.key`, but the publication-key half of the request is still missing. Revision 2 also introduces two small imprecisions.

Reviewer approval is not user approval. The proposal is still **NOT APPROVED** for implementation.

Labels: **[fact]** means I inspected it in source. **[inference]** means I reasoned it out. The draft's examples are still unimplemented and have not been typechecked.

## Round-1 blockers

| Round 1 | Status | Where in revision 2 |
| --- | --- | --- |
| B1: windowing overclaim, missed slots | Resolved | §Capability (line 9): latest eligible slot only, gaps from overlap/pause/edit/downtime, own durable watermark, cadence and previous slot are not inferable. Criterion 7 tests it. |
| B2: key-safe idiom | **Partly resolved** | `context.key(\`slot-${ms}\`)` is valid, and line 79 honestly says the key is run-scoped and proves nothing about coverage. The publication key, which is where a slot label actually matters, is still not shown or tested. See C1. |
| B3: `generation` misreadable | Resolved, wording slip | Opaque equality token per schedule ID, non-contiguous, fixture uses `7`. "Repository-wide" and "can create" are imprecise. See C2. |
| B4: naming | Resolved | `context.occurrence` / `WorkflowSchedule.Occurrence` / `Task.test({ input, occurrence? })`, with one canonical schema and `ScheduleProvenance` as an alias. It reads well: `occurrence.scheduleId` no longer stutters, and nothing suggests cron or zone are present. |
| B5: `catchUp` vs staleness | Resolved | Line 88: 60-second grace, fixed at admission, `false` is not timeliness, use `Clock` with `scheduledFor`. The example shows a handler-clock staleness check. Line 102 covers decline-by-`graph.branch` and states that `Task.test` cannot test it. **[fact]** This matches `eligibility` (`schedule-decision.ts:76`, `age <= scheduleGrace` is on-time). |

Round-1 non-blockers are all addressed:

- **Absence** (line 22): omitted key, no `undefined`, no `null`.
- **Field-named fixture errors** (line 106).
- **Test scope** (line 102).
- **Example** wrapped in `Effect.gen`, with no undefined names and an "unimplemented" label.
- **Corrupt stored row** (line 92): fails the existing `Unavailable` boundary, including for a whole history page. That is honest about the blast radius.

## Remaining corrections

### C1. Show the occurrence-derived publication key. This is the half of B2 that is still open.

**[fact]** The lake builds two keys from a publication:

- The idempotency key, `publicationKey = canonical([runId, invocationPath, output, options.key])` (`packages/platform-bun/src/lake.ts:202`), is run-scoped.
- The artifact identity, `artifactId = sha256([principal, taskId, output, options.key])` (`lake.ts:291`), is **not** run-scoped. Each new run publishing under the same `options.key` adds version N+1 of that artifact.
- `options.key` goes through `identifier()` (`packages/core/src/task.ts:139`), so a raw `scheduledFor` fails with the opaque "Task boundary validation failed".

**[inference]** So the slot label matters for `publish`, not for `context.key`. With `{ key: \`slot-${ms}\` }`, every slot gets its own queryable artifact lineage. A later manual or rescheduled run for that slot becomes a new version of the same artifact rather than a stray one. That is the consumer payoff of a key-safe label, and it is the idiom people will reach for first.

Today the draft shows the label only on `context.key`, where line 79 itself admits that a fixed name works just as well. A reader is left wondering why the slot is there at all.

**Minimal fix (text only):**

1. After line 79, add a sentence along these lines: "For `publish`, `options.key` uses the same identifier grammar. Unlike `context.key`, it also determines artifact identity across runs (principal, task, output, key). So `publish(output, value, { key: \`slot-${Date.parse(occurrence.scheduledFor)}\` })` gives one versioned artifact per slot. It still does not deduplicate runs, and it does not prove coverage."
2. Extend criterion 6 to "...and the same label is accepted as a `publish` key."

Adding an output to the example is optional.

### C2. Make the definition of `generation` precise (line 86).

**[fact]** The counter is the `host_scheduler` singleton in the host store (`schedule-store.ts:109, 344`), not anything repository-level. It is bumped whenever a schedule is first registered, re-added after removal, or registered with a changed identity digest. The digest covers cron, zone, input, catch-up, workflow id and workflow version, and excludes `description` (`schedule-store.ts:330–352`).

**[inference]** "Repository-wide" will be read as git repository or application. "Definition changes _can_ create a new token" invites a consumer to treat an unchanged token as possible after an effective edit.

**Minimal fix:** change "repository-wide counter" to "host-wide counter (one per host store)". Change "can create" to "Every effective definition change, and re-adding a removed schedule, assigns a new token. Description-only edits do not." Optionally, name one consumer use, such as "the occurrence was produced under a different definition than the last one I recorded". Without a named use, consumers will keep guessing what it is for.

### C3. Fixture diagnostic must state the expected form (line 106).

I accept the deliberate deviation of rejecting noncanonical fixtures instead of normalizing them, for the reason the draft gives: one boundary, not two. The cost is that `"2026-11-05T10:00:00Z"` (no milliseconds), the most likely hand-written fixture, now fails.

**Minimal fix:** require the diagnostic to name the field **and** the expected form. For example: "occurrence.scheduledFor must be canonical UTC as produced by `Date#toISOString`, e.g. `2026-11-05T10:00:00.000Z`." Add the same tip next to the fixture example: write `new Date(...).toISOString()`.

## Deliberate deviations

- **Extended-year timestamps: accept.** **[inference]** For consumers, the 4-digit-or-±6-digit pattern plus the round-trip check is never looser than the real wire. The round-trip check already rejects `-000000`, `+002026-…` and impossible dates. `Date.parse` in the example handles every accepted form, and `slot-${ms}` stays a valid identifier even for negative epochs (`slot--…`). Narrowing the format now would make some valid generated instants unrepresentable for no consumer gain.
- **Rejecting noncanonical fixtures: accept, conditional on C3.**

## Non-blocking notes (do not hold presentation)

- `export const example` uses the live `Clock`, so `stale` depends on when it runs. Line 77 already points to `TestClock`. A short comment in the example would stop readers copying a nondeterministic test.
- Line 9 could add that skipped slots are observable in schedule history. Today the draft says only that the context cannot reveal them.
- The Swamp design citation (line 7) gives lines 2840–2865. I measured 2838–2860, and the Effect reviewer measured 2840–2865. This is immaterial.

## Scope honesty

The draft is explicit that it does not provide:

- arbitrary tags
- tag propagation
- cron or cadence in the context
- graph-construction access
- workflow-level testing
- cross-build migration

It also makes clear that scheduling itself is implemented and that this context is not. I found no scope creep relative to round 1, and nothing that conflates this proposal with the concurrent compilation/SDK work.

## Summary for the parent

Conditionally APPROVE FOR PRESENTATION after these text-only corrections:

- **C1:** document the publication-key idiom and its cross-run artifact identity, and extend criterion 6 to cover `publish`.
- **C2:** describe `generation` as a host-wide counter, assigned on every effective change and on re-add.
- **C3:** the fixture diagnostic and the example must state the canonical form.

Both deliberate deviations are acceptable from the consumer side. This is not user approval.
