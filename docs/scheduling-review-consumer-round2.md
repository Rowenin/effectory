# Scheduling API review — consumer perspective, round 2

Reviewer: Claude (consumer viewpoint). Subject: `docs/scheduling-api-draft.md`, revision 2 (NOT APPROVED). This review is not user approval. No draft, runtime or other review file was changed. Snippets are proposals and were not typechecked.

## Verdict: REQUEST CHANGES (three small text fixes, then APPROVE FOR PRESENTATION)

Revision 2 resolves all six round-1 consumer blockers and the Effect reviewer's blockers. The authoring shape, the defaults and the CLI surface are ready to show the user. Three items remain. Two are advertised limits whose failure mode leaves an operator with no way forward. The third claims an extension-selection check that the code does not have. Each fix is a sentence or two, and none adds a subsystem.

## Round-1 items: resolved

| Round-1 item | Revision 2 | Assessment |
| --- | --- | --- |
| B1 principal / key collision | Owner principal plus an internal admission namespace. No reserved user prefix. | **Accept the deviation.** It is strictly better for consumers, because no existing key becomes invalid. See N1 for the one consequence that needs documenting. |
| B1 provenance | `schedule` is an `optionalKey` on both `Run` and `RunSummary`. | Correct. Verified that these are separate schemas (`protocol.ts:27`, `history-protocol.ts:19`) and that `RunWatchFrame.Snapshot` carries `RunSummary`, so watch, list and get agree. `RunSummary` has no `requestKey`, so nothing else needs to change. |
| B2 Blocked state | Closed `state`, precedence rule, `blockedBy`, next-step pointers, NeedsAttention blocks indefinitely | Resolved. |
| B3 pause guard | No generation guard. Pause acts on a stable ID, is idempotent, returns `changed=false`, CLI key optional, removed IDs allowed | Resolved. See B1 below for receipt retention. |
| B4 identity and generation | Permanent ID, integer generation, removed→present opens a fresh generation and keeps the pause. Effect is measured from what the scheduler observes. | Resolved. The rule that the observed revision decides is honest about F16, which says the pointer is not in SQLite. |
| B5 bounded history, five fields | Coalesced ranges, 10000 count cap with `saturated`, 1000 entries, `CursorExpired`; five fields only | Resolved. Both `CursorExpired` and `LimitExceeded` are existing `OperationError` codes (`protocol.ts:108-122`), so no new codes are needed. |
| B6 liveness | `schedule.v1`, `SystemStatus.scheduler` with revision and lastError, daemon-only stated | Resolved. |
| P2 auto-discovery | Adopted | Good for consumers. The extension wording is wrong (B3 below). |
| DST | Spring gap shifts forward. An autumn fold fires once, at its first instant. 75-minute example given. UTC recommended. | A clear contract that consumers can act on. |

## Public-contract blockers

### B1. A repository-wide cap of 10000 receipts turns pause into a resource that runs out

The draft keeps receipts immutable, with at most 10000 per repository, and then rejects new keys with `LimitExceeded`. The CLI generates a new key on every invocation, so every pause or resume uses up one receipt, permanently.

_Counterexample._ A deploy script pauses three schedules before a migration and resumes them afterwards. That is six receipts per deploy. After about 1,700 deploys, `schedule pause` fails with `LimitExceeded` for every schedule in the repository, including during an incident. Pause is the operator's emergency stop, and no command can reclaim the space. The existing precedents bound receipts per object (`host_cancellation_receipts` allows 64 per run, `host-store.ts:630-637`), and runs end. Schedules do not end.

_Smallest fix._ Bound receipts **per schedule**, keyed `(scheduleId, requestKey, actor)` like cancellation receipts, and keep the most recent N, for example 256. When a new receipt is written, the oldest one is evicted. Document that duplicate detection covers the last N mutations of that schedule, and that a key older than that is treated as new. A retry of an evicted key is harmless in practice, because uncertain-delivery retries happen within seconds. Pause must never fail because of the receipt count. The reason size stays capped at 8192 bytes, so storage is bounded at N receipts times the number of retained IDs (see B2).

### B2. The 128-ID cap counts tombstones and offers no way to forget them

"Schedule IDs/known tombstones are bounded to 128." Removed IDs are kept permanently, and the draft does not say what happens at the limit.

_Counterexample._ A team renames or retires schedules over a year. Once 128 distinct IDs have ever existed, the next deploy that adds a schedule fails, or else behaves in a way the draft does not say. The operator cannot remove a tombstone, because there is deliberately no source-mutation RPC.

_Smallest fix._ State two separate limits.

- At most 128 **declared** schedules per application. More than that fails at Registry build with a `DefinitionError` that names the limit.
- Removed tombstones are kept up to a separate bound, for example 1024. Beyond it, the oldest tombstone that is **unpaused and has no nonterminal scheduled run** is evicted together with its history. Its old runs keep their `schedule` provenance.

To keep occurrence identity unique after an eviction, assign generations from a counter per repository. A generation then still increases for each schedule, and `(scheduleId, generation)` is never reused. Paused tombstones are never evicted. If every tombstone is paused and the bound is reached, activation fails with a message that says to resume one of them.

### B3. "Same extension-selection checks as linked workflows" describes a check that does not exist

Discovery of linked children (`application.ts:105-125`) checks only reference identity (`Noncanonical workflow`) and the 1000-workflow limit. Extension workflows enter the registry only through `ExtensionRegistry.resolve` for **selected** extensions (`extension-registry.ts:116-117`). No step checks whether a discovered workflow belongs to an unselected extension. Today that rule holds only indirectly, because extension _tasks_ are registered only through selection, so the `Missing or noncanonical task contract` check usually catches it.

_Counterexample._ An extension exports a workflow that uses no extension-owned tasks. For example, it contains only a wait node and a task that the application also lists in `tasks`. Importing that workflow directly and scheduling it compiles it as a local workflow without `Extension.use`. The extension's selected patches are not applied, and the extension is missing from the provenance.

_Smallest fix._ Choose one wording.

- (a) Accurate and minimal: "Schedule-discovered workflows follow exactly the linked-child rule, which is canonical identity plus task-contract presence. Extension selection is enforced through task registration, the same as for linked children." This states the existing guarantee, gap included.
- (b) Strict: "A scheduled workflow must be local or contributed by a selected extension. Workflows that belong to an unselected extension fail with a DefinitionError." That needs a provenance marker on extension workflows. It would then apply to linked children too, so it is wider than this feature.

I recommend (a) for this slice, plus an acceptance test. Either way, the draft must not claim a check that does not exist.

## Non-blocking, recommended for the presentation text

- **N1. `Run.requestKey` is no longer unique per owner.** With separate namespaces, a manual run can carry the same `requestKey` string as a scheduled run. No RPC looks runs up by key (`RunListRequest` has no key filter), so nothing breaks. Still, say "use `run.schedule` to tell scheduled runs apart, and `requestKey` is unique only within its namespace."
- **N2. A new schedule is not visible immediately after deploy.** `get` and `pause` read reconciled state, so `deploy && schedule pause new-id` can return `NotFound` until the scheduler reconciles. Make the `NotFound` message include the scheduler's revision and the active revision, and document that you should wait for `SystemStatus.scheduler.revision`. No new API is needed.
- **N3. List default.** State that `schedule list` without `--state` excludes `Removed`, and that an application with no schedules returns an empty page with the revision.
- **N4. A `latestWithin` shorter than 60 seconds has the same effect as `"skip"`**, because eligibility is max(grace, window). Either reject anything under `"1 minute"` or say so.
- **N5. Resume boundary.** Say whether a slot that falls exactly on the resume instant is eligible. I suggest excluded, to match the rule that first observation starts at the next future slot.
- **N6. Key scope.** State that pause and resume keys are scoped per schedule and actor. This follows from the B1 fix.

## Acceptance tests (after user approval, not needed to present)

These add to the draft's own list.

- Receipt eviction at N per schedule. A pause still succeeds after N+1 mutations. Replaying the newest key returns the original receipt.
- Tombstone eviction skips paused IDs and blocked IDs. Generations are never reused after an eviction. The 129th declared schedule gives a `DefinitionError`.
- A scheduled workflow that links children, a scheduled workflow that is also listed in `workflows`, and the extension workflow case from B3 under whichever rule is chosen.
- `optionalKey` provenance: manual `Run` and `RunSummary` JSON is byte-identical to today. `RunWatch` snapshot, `RunList` and `RunGet` agree for a scheduled run.
- `deploy` followed immediately by `schedule get` reports `NotFound` with both revisions, then succeeds after reconciliation.

## Summary for the parent

REQUEST CHANGES, limited to three text fixes.

- **B1:** bound pause/resume receipts per schedule with oldest-first eviction, so pause can never hit `LimitExceeded`.
- **B2:** separate the declared-schedule limit from tombstone retention. Evict only unpaused, unblocked tombstones, and use a repository-wide generation counter.
- **B3:** reword the extension-selection claim to match the actual linked-child rule, or make it strict and accept the wider scope.

Everything else is ready to present: the namespace deviation, auto-discovery, stable-ID pause, reconciliation by observed revision, the five-field cron with its DST contract, bounded history, and provenance on both `Run` and `RunSummary`. If those three fixes are made as written, I would approve for presentation without another full round. Final approval belongs to the user.
