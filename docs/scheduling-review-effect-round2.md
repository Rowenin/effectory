# Scheduling API review: Effect perspective, round 2

Reviewer: Claude (Effect-native review sub-agent). Subject: `docs/scheduling-api-draft.md`, revision 2 (NOT APPROVED). This review is not user approval. No draft, runtime or other review file was modified. Throwaway probes ran in the session scratchpad, outside the repo.

## Verdict: REQUEST CHANGES (narrow: two text-only contract fixes)

Revision 2 resolves every round-1 Effect blocker (B1–B6) and every round-1 consumer blocker. I accept both deliberate deviations: the internal admission namespace and automatic workflow discovery. Two public-contract statements are still wrong or incomplete, and each has a concrete counterexample (§2). Both fixes are wording-sized and add no subsystem. Once they are made, I would approve this for presentation without another full round.

## 1. Revised decisions: verified and accepted

Labels: **[code]** means read in source, **[probe]** means run with `bun` against `effect@4.0.5` in this checkout.

| Decision | Assessment |
| --- | --- |
| Internal admission namespace instead of reserving `sched:` | **Accept.** This is better than the round-1 fix. Today's dedup is `UNIQUE(principal, requestKey)`, and both `lookupSubmission` and `submit` query it (`host-store.ts:130-132, 890-896, 1236-1241`). A manual key equal to a scheduled run's displayed key would otherwise hit `Conflict`, because the fingerprint includes the revision. The namespace therefore has to be part of the unique index and of both manual lookups. That is an implementation obligation, not a contract change. The one consumer-visible consequence: two runs under `owner` can show the same `requestKey`, one manual and one scheduled. The draft already says the scheduled key is not a retry recipe, which is enough. |
| Automatic workflow discovery | **Accept the mechanism.** It mirrors the linked-child path (`application.ts:111-127`), and `Registry` keeps `R` from tasks and extensions only (`application.ts:11-14,56-66`), so discovery cannot erase service requirements. **But the accompanying extension claim is false. See C1.** |
| Pause/resume on stable ID, no generation guard | **Accept.** Pause/resume are idempotent state setters, `changed=false` covers repeats, and they are allowed on Removed. This matches round-1 P5 and consumer B3. |
| Observed-revision reconciliation | **Accept.** One `{registry, revision}` snapshot per tick, no claim of file/SQLite atomicity (`revisions.ts:256-296`), and scheduler revision exposed in `SystemStatus`. Removal and re-add count only when observed. The stale tick that may finish after activation is stated honestly. The drain fence is sound because `lifecycle.accepting` is checked **inside** the submit transaction (`host-store.ts:1252`). A scheduled-admission variant must keep that check inside its transaction, and must classify `Unavailable` (draining) and the 1000-active-runs `LimitExceeded` (`host-store.ts:1263-1279`) as the non-advancing temporary failure. |
| Five-field cron and explicit DST contract | **Accept.** Probes reconfirm the contract, including the next/prev agreement the draft lists as a gate (below). |
| Bounded history and receipts | **Accept history.** Receipts and tombstones have a flaw. See C2. |
| Provenance on both `Run` and `RunSummary` | **Accept, and it is necessary.** `RunWatchFrame.Snapshot` carries `RunSummary` (`history-protocol.ts:57-58`), and `RunPage.items` are `RunSummary`. Adding it to `Run` alone would make list and watch disagree with get. `Schema.optionalKey` keeps manual JSON byte-identical. Use `Id` for `scheduleId`, as `RunSummary` does. |
| Strict codec pipeline | **Accept** with one ordering note (N2). |
| Honesty about evidence | **Accept.** Signatures are marked as not typechecked, and shipping gates are listed as future acceptance criteria. |

DST probe, America/Chicago, 2026 [probe]:

- `30 1 * * *`: `next` from 05:00Z gives 06:30Z. `next` from 06:30:01Z, 07:00Z or 07:30Z gives 2026-11-02T07:30Z, so the second 01:30 (07:30Z) is never produced. `prev` from 08:00Z, 07:31Z, 07:30Z or 06:31Z gives 06:30Z, so `prev` agrees with `next`.
- `*/15`: `next` produces 06:45, then 08:00. `prev` from 08:15 produces 08:00, then 06:45. Both directions show the same 75-minute fold interval.
- `30 2 * * *` spring: `next` and `prev` both give 08:30Z (03:30 local).
- `next` and `prev` are both **exclusive** at an exact slot instant (`0 * * * *` at 10:00Z gives next 11:00Z and prev 09:00Z, while `match` is true). "Due slots at or before now" therefore needs `match(now)` or `prev(now + 1ms)`. Add this to the decision tests (T3).

## 2. Remaining public-contract blockers

### C1. "Referencing an extension workflow cannot bypass explicit Extension.use selection" is not true of the mechanism described

The draft says discovery uses "the same canonical-identity and extension-selection checks as linked workflows". Linked workflows have **no** extension-selection check. `application.ts:111-127` only compares definition identity and pushes unseen children. `Extension.make` freezes plain `Workflow.Definition` objects with no ownership brand (`extension.ts:78-88`). `ExtensionRegistry.resolve` learns about extension workflows only from _selected_ extensions (`extension-registry.ts:108-118`).

**Counterexample:** a module-source extension `E` exports workflow `W` and task `T`. An application declares `tasks: [E.tasks.T]` and `schedules: [WorkflowSchedule.make({ workflow: E.workflows.W, ... })]` with no `Extension.use(E)`. Discovery registers `W`. Its task check passes because `T` is canonical. The run then executes without `E`'s provenance in `Registry.extensions` and without `E`'s selected patches or implementations. The same thing is already possible today through `workflows: [E.workflows.W]`, so schedules **do not widen** the hole. The draft still promises a guarantee that does not exist.

**Smallest fix (text):** replace the sentence with: "Schedule targets are discovered exactly like linked child workflows: canonical identity plus canonical task contracts. This is no weaker than listing the workflow in `workflows:`. Neither path detects a directly imported module-extension workflow used without `Extension.use`; that is an existing gap, not one introduced by schedules." If you want the stronger guarantee instead, it needs an ownership brand on extension definitions. That is a separate change and should not be in this slice.

### C2. The behavior at bounded limits is unspecified or self-defeating

The draft caps mutation receipts at **10000 per repository**: new keys are rejected with `LimitExceeded`, and receipts are never pruned. It caps schedule IDs plus known tombstones at **128** and states no behavior at the cap. It also says "No daemon CLI disable flag in this slice; operational pause is sufficient." The first cap breaks that claim, and the second can block activation.

- **Counterexample A:** a deploy script pauses and resumes schedules around each of 20 deploys a day, which is about 40 receipts a day. Around day 250 the repository's receipts are exhausted. From then on, every `schedule pause` with a fresh (CLI-generated) key fails with `LimitExceeded` for **every** schedule, including during an incident. No operation can recover, and there is no disable flag. A cap on receipts must not turn into permanently losing the safety control.
- **Counterexample B:** a developer renames a schedule ID while iterating, which leaves a tombstone each time. After 128 distinct IDs, the next activation must either fail, with no forget operation, or behave in some undefined way.

**Smallest fix (text):**

1. Scope receipts **per schedule**. Retain the newest N (for example 64, after the cancellation-receipt precedent at `host-store.ts:634`) and **evict the oldest** instead of rejecting. State the bounded dedup window: a retry of an evicted key is treated as a new request. Because pause and resume are state setters, the worst case is a late retry re-asserting its own operation after N newer mutations. Also state the key scope: fingerprint `{scheduleId, operation, reason}`, scoped per schedule.
2. Apply the 128 cap to schedules **present in one revision** (`DefinitionError` at Registry build). Retain removed tombstones up to a separate bound, evicting oldest-removed first. An evicted ID that is re-added is a brand-new schedule: unpaused, with no history. Eviction must never let a new incarnation reuse an occurrence/admission key, for example by keeping a repository-wide monotonic incarnation or generation counter in the key. Otherwise a clock rollback could dedup a fresh slot against an old run.

The 10000-receipt `LimitExceeded` precedent in `lifecycle.ts:44-52` (daemon instances) is not a good model here, because it guards bookkeeping and not the operator's emergency control.

## 3. Non-blocking recommendations (fold in if convenient)

- **N1. Zone identity vs tzdata.** "Store the canonical zone name" combined with "tzdata change is not a new generation" can conflict, because ICU canonicalization has changed between runtimes (historically `Asia/Kolkata` and `Asia/Calcutta`). Today's Bun preserves the spelling [probe: `Asia/Kolkata`, `Asia/Calcutta` and `US/Central` round-trip; `utc` becomes `UTC`]. Base generation identity on the validated source spelling, and display the resolved name separately.
- **N2. Encoding order.** Specify: strict encode, then `checkJsonBudget` (mapping its `TaskRuntimeError` to `DefinitionError`), then `Schema.Json` decode, then canonical bytes, then strict codec decode **of the parsed canonical bytes**. The budget walker treats a `Date` as `{}` (`json-budget.ts:79-81`), so only `Schema.Json` rejects it [probe]. `-0` canonicalizes to `0`. Decoding the stored bytes proves that what runs is what was validated.
- **N3. Missed-reason rule.** Define `Downtime` as slots found during startup reconciliation, and `Late` as slots found by the live loop beyond grace. Otherwise the enum is public but its assignment is not.
- **N4.** A `latestWithin` shorter than the 60-second grace has no effect. Either reject windows under 1 minute or document the no-op.

## 4. Implementation acceptance tests (after user approval, not presentation blockers)

T1. Type fixtures: `NoInfer` rejects a wrong input and does not widen `S`; `Application.make` with `schedules` keeps `R`/`E`; the schedule-only workflow still requires its tasks. T2. Strict-encode tests: excess property rejected, `Date`-encoding codec rejected, stored bytes decode, caller mutation after `make` has no effect. T3. Grammar, satisfiability (Feb 30), Vixie AND/OR, no `Cron.format`; DST tables for Chicago, London and a southern zone, including §1's next/prev and exact-slot inclusivity. T4. Pure decision table plus TestClock loop: grace, late, downtime, catch-up window, rollback, pause/resume window, generation change, re-add. T5. SQLite transaction tests: occurrence, run and outbox, plus watermark rollback; scheduler namespace versus identical manual key in both lookup paths; drain gate inside the transaction; 1000-active-runs → pending candidate → AdmissionFailed coalescing. T6. Overlap with Waiting and NeedsAttention across generations; stale-tick admission after activation pinned to the captured revision; removal observed versus unobserved. T7. Receipt eviction window and key conflicts; tombstone eviction without occurrence-key reuse; cursor pruning → CursorExpired; history cap. T8. `Run`/`RunSummary`/watch Snapshot provenance agreement; manual-run JSON byte-identical; CLI golden output.

## 5. Summary

REQUEST CHANGES, limited to C1 (correct the false Extension.use guarantee) and C2 (define receipt and tombstone limit behavior so pause cannot be permanently disabled). Everything else in revision 2, including both deliberate deviations, is sound from the Effect perspective. With those two text edits, it is ready to present to the user. Reviewer approval is not user approval.
