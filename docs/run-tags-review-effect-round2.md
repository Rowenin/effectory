# Run tags — Effect review, round 2

Reviewer: Claude, from the Effect perspective. Target: revision 2 of `docs/run-tags-api-draft.md`. This is a focused follow-up, not a broad re-review. I read the round-1 Effect and consumer reviews and `docs/run-tags-schema-probes.md`. I re-checked the relevant source in `packages/runtime`, `packages/platform-bun` and `packages/core`, and ran one scratch probe against `effect@4.0.5` with `bun -e`. The probe wrote no files. The only file I created is this review.

Reviewer approval is not user approval. The proposal remains **NOT APPROVED** for implementation. No production code or proposal text was changed.

**Verdict: CONDITIONAL APPROVE FOR PRESENTATION.** All round-1 blockers are resolved. I accept both deliberate deviations. They fit Effect RPC and the current storage and idempotency code, and for schedules the result is better than what I proposed. Three exact text fixes, F1 to F3, are required before presentation. None of them changes direction, so I do not need another round once they are applied.

Labels: **[fact]** means checked in source or with a probe. **[inference]** means reasoning I did not test. **[untypechecked]** marks code that refers to proposed APIs.

## Prior blockers

| Round-1 item | Revision 2 | Status |
| --- | --- | --- |
| Effect B1: required output `tags` against an old daemon | Item 7, item 12, line 146: missing-key decoding default with passthrough encoding | **Resolved by the alternative.** I accept it; see Choice 1 and F1/F2. |
| Effect B2: schedule digest and legacy configuration decoding | Lines 124–126: tags excluded from the digest; missing stored tags decode to `{}`; invalid present tags fail `Unavailable` | **Resolved**, more strongly than my fix; see Choice 2. |
| Effect B3: `RunTags` construction | Lines 102–106: `Record(String, Value).check(isPropertyNames, isMaxProperties(32), byteBudget)`; JSON Schema assertions; UTF-16 note | **Resolved.** |
| C1: captured `Definition.tags` | Item 2 | **Resolved.** |
| C2: per-stage errors | Line 128 | **Resolved.** |
| C3: one merge and validation path in `contextFor`; low-level context decoded and frozen | Item 3, line 136 | **Resolved.** |
| C4: exact named export forms; no internal subpath | Item 1, proof 9 | **Resolved.** |
| Consumer B1–B4, D1, D3 | Line 142; lines 124–126; item 11; item 7; lines 15 and 132; line 118 and item 10 | **Resolved** (B1 is assessed below). |

## Choice 1: missing encoded key decodes to `{}`

**Accept.** The rule is placed at the right Effect layer.

**[fact, probe, `effect@4.0.5`]** I reused the revision-2 `RunTags` construction (with a 4096-byte filter) as `tags: RunTags.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => ({}))))`, inside a struct nested in a `TaggedStruct` union shaped like `RunWatchFrame`:

| Check | Result |
| --- | --- |
| Absent key, including through the union | Decodes to `tags: {}` |
| Two decodes | Return distinct objects (not frozen; that is fine for output records) |
| Present `undefined` | Rejected |
| `-bad` key | Rejected by `isPropertyNames` under default options |
| Map over 4096 bytes | Rejected |
| Encoding `{}` | Key always emitted |

This extends the earlier probe to the selected construction and the watch-frame shape.

**[fact]** Effect RPC decodes success values only on the client. Every affected reply is typed:

- `TaskRun` and `WorkflowRun` return `Run` (`rpc.ts`).
- `RunWatchFrame.Snapshot` carries `RunSummary` (`history-protocol.ts:64`).
- `ScheduleGet` returns `ScheduleDescription` (`rpc.ts`).

`WorkflowDescribe` and `WorkflowPlan` return `Schema.Json`, so item 10's `tags` on those replies has no decode-compatibility problem.

**[fact]** `RunListRequest` is decoded with `onExcessProperty: "error"` (`run-history.ts:115`), and `Submit` uses the default decode. Item 12 omits empty maps and refuses nonempty tag intent without the capability. Together these cover both server behaviors: the loud rejection and the silent drop.

### F1 (required). Keep the default on the client only

**[fact]** The host decodes its own stored rows with the same public schemas:

- `getRun` calls `Schema.decodeUnknownSync(Run)({...})` (`host-store.ts:241`).
- `readRows` spreads `RunSummary.fields` and decodes `RunSummary` (`run-history.ts:76–86`).
- `config(row)` decodes `Configuration` (`schedule-store.ts:76`).

**[inference]** If the public `Run`/`RunSummary` schemas carry the decoding default, a host projection that forgets to select or pass the tags column still decodes successfully, and silently reports `{}` for a tagged run. That contradicts line 144 ("fails … rather than being dropped") and line 120 (the stored map is the single source of truth). For schedule configuration, decoding a missing key as `{}` is deliberate and correct. For the backfilled run column, it is not.

**Exact fix.** Append to item 7:

> The missing-key default exists only for decoding RPC replies. Host projections (get, list, watch snapshot, foreground result) read the backfilled non-null tag column and decode it with `RunTags` directly, or decode with a strict internal variant where `tags` is required, so a projection that omits the column fails instead of reporting `{}`.

Proof 6 should add: "a host projection missing the tag column fails its test."

### F2 (required). Disclose what an old daemon cannot see

**[fact]** `@effectory/core` resolves to the host's own copy (`host-modules.generated.ts`). Today `Workflow.make` keeps but ignores an unknown `tags` key (consumer round 1, probe). An old `WorkflowSchedule.make` throws on `tags`, which is a loud failure.

**[inference]** Consider an untagged `workflow run` from a new CLI to a daemon that lacks `run-tags.v1`. It succeeds, decodes `tags: {}`, and publishes artifacts without the workflow's authored default labels. No user-supplied tag intent is lost, so this is the accepted trade-off of Choice 1. It is still a silent difference that operators should be told about.

**Exact fix.** Append to item 12:

> A daemon without `run-tags.v1` also does not apply authored `Workflow.make` default tags; its runs report `{}` and publish without inherited labels until the daemon is restarted on this build.

Proof 8 should add: "an untagged submission to a capability-less fake server decodes a reply without tags as `{}`, with no refusal."

## Choice 2: schedule tags excluded from the digest

**Accept.** This is better than my round-1 rule of including tags only when the map is nonempty. Under my rule, adding a first label would still have reset catch-up. Under this rule, pre-upgrade digests are byte-identical because `identity` simply loses one more field.

The following match current semantics:

- **[fact]** Reconcile builds `value`, removes `description`, and hashes the rest (`schedule-store.ts:321–337`). The non-digest branch updates only `revision` and `definitionJson` (`:361–366`). Tags have to be removed in the same destructuring, `const { description, tags, ...identity } = value`, which is what line 124 requires.
- **[fact]** A pending retry reads `config(row)` and `row.revision` inside the admission transaction (`:408`, `:451–466`). The scheduled request key is `hash({generation, scheduleId, scheduledFor})`, and none of those three changes on a tag-only edit.
- **[fact]** `host.submit` runs on the same `database` as a nested transaction (`host-store.ts:480`, created from `createScheduleStore(database, …)` at `:555`). The admitted run and the `pendingSlot = NULL` update therefore commit together. There is no committed-run-with-pending-slot window in which a retry could see the old tags under the same key.
- **[fact]** The scheduled fingerprint already includes `revision`, and today's non-digest reconcile already advances `row.revision`. Pending retries after description or graph edits therefore already re-fingerprint with no prior run, so they never conflict. Tag-only edits add no new idempotency case. Line 126 must keep tags out of the schedule-namespace fingerprint, and it does.
- **[inference]** Generation is unchanged, so `context.occurrence.generation` is also unchanged by label edits. That resolves the consumer's occurrence concern.

No change required.

## Mandatory indexed SQL tag filters

**Accept the requirement.** Today, `readRows` counts every row SQL yields toward `scanned` and `bytes` before applying the JS `matches` (`run-history.ts:48–100`) **[fact]**. Moving the tag predicates into the SQL `WHERE` therefore means only tag-matching rows reach the budget. That fixes consumer B1.

### F3 (required). Two precision sentences for line 142

1. **Conjunction.** Replace "only matching tag candidates count against the existing scan budget" with:

   > Every tag predicate (conjunction) is evaluated in SQL, so only rows satisfying all tag predicates, plus the existing SQL time and cursor predicates, are yielded to and counted by the existing scan and byte budget.

   As written, "candidates" could be read as the rows matching only one indexed key.

2. **Byte budget.** **[fact]** The byte budget counts `JSON.stringify(row)` for each scanned row. **[inference]** If `RunSummary` gains up to 4096 bytes of tags, an unfiltered or kind/status-filtered list over maximally tagged runs reaches 16 MiB at roughly 3,800 rows instead of 10,000. Add:

   > Tag bytes count toward the existing 16 MiB history budget, so heavily tagged repositories reach it at fewer rows.

   The existing "may still reject overly broad queries" sentence nearly covers this, but the cause should be stated.

**Not required.** Bounding SQLite's internal index work when a common key is combined with a rare one. The query-plan proof in line 142 is enough for this slice **[inference]**.

## 4096-byte run-map budget

**Accept.**

**[fact]** `canonical` (`boundary.ts:36`) sorts keys and uses `JSON.stringify` for keys and strings. For a flat string map, its byte length equals the leaf's `TextEncoder`/`JSON.stringify` length. The two limits therefore measure the same quantity.

**[inference]** For nonempty maps, `|canonical(merge)| ≤ |run| + |explicit| − 1`. A 4096-byte run map therefore always leaves at least 4097 canonical bytes for explicit publication labels, so proof 7's maximal-map case holds.

Untagged runs keep the full 8192 bytes, so existing publications are unaffected. Validating merged maps against 4096 is consistent with the dedup ordering:

- at `WorkflowSchedule.make`
- on manual submission, after lookup

A lost-reply retry whose merged map would now overflow still returns the original run.

## Facts versus inference, summarized

- **Facts:**
  - Construction and default-key behavior, from the probe.
  - Reply schemas and decode modes.
  - Schedule digest, reconcile and admission code paths, and their transactional nesting.
  - The run-history budget accounting.
  - Canonical byte equivalence.
  - Host projections reuse the public schemas.
- **Inference:**
  - The silent `{}` risk in F1.
  - The old-daemon defaults gap in F2.
  - The approximate 3,800-row byte-budget threshold.
  - Merge headroom arithmetic.
  - That SQLite internal work is acceptable.

## Approval status

- **Reviewer:** conditional approval for presentation, once F1–F3 are applied verbatim or equivalently.
- **User:** not given. The public contract change in items 7 and 10, the storage migration and both deliberate deviations still need explicit user approval before any implementation starts.
