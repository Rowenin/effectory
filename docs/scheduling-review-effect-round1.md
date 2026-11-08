# Scheduling API review — Effect perspective, round 1

Reviewer: Claude (Effect-native API review sub-agent). Subject: `docs/scheduling-api-draft.md` (unapproved). **This review is not user approval.** No runtime code, draft, or other review file was modified.

## Verdict: REQUEST CHANGES

The overall shape is right and proportionate: a pure, frozen, application-owned spec; no executable `Schedule`; no new Layer; a host scheduler that composes into the existing host Layers; one durable admission per occurrence. Do not change that direction. The draft is not ready to present because it leaves six semantics unspecified or unsound. Four of them are already proven by probes against the pinned Effect 4.0.5 (§1). They need decisions, not more exploration: the DST fold behavior, unsatisfiable cron expressions, a lossy `Cron.format`, and codec excess-property stripping. The other two are the principal of a scheduled run and the definition of "on time" versus "missed". Each blocker has a concrete fix that is small enough to fold into the next draft.

## 1. What I verified, and how

Label key: **[code]** means read in source, **[probe]** means I ran it with `bun` against `effect@4.0.5` in this checkout (throwaway script, since removed), and **[proposal]** means my recommendation, not existing behavior. None of the API snippets below were typechecked.

| # | Fact | Basis |
| --- | --- | --- |
| F1 | `Boundary = Schema.Codec<unknown, unknown, never, never>`, so input codecs cannot require services. Encoding a scheduled input at definition time is service-free. | [code] `packages/core/src/boundary.ts:6` |
| F2 | `Workflow.Definition<S>` has no `R` parameter. Service requirements accumulate only from `tasks` (and extensions) in `Application.make`'s `Requirements<T>`. A schedule that only references a workflow cannot erase or add requirements by construction. | [code] `workflow.ts:262-270`, `application.ts:11-14,58-66` |
| F3 | Existing "pure" constructors throw `DefinitionError` **synchronously** (`identifier()`, `version()` in `Workflow.make`, `Task.contract`). Graph and membership validation happen later, inside the `Registry` Layer build (`Effect`, `E = DefinitionError`). | [code] `workflow.ts:521-535`, `application.ts:66-185` |
| F4 | Workflow identity is reference-canonical: `prior !== node.workflow` → "Noncanonical workflow". Linked child workflows are added to the registry implicitly, without being listed in `workflows:`. | [code] `application.ts:112-127` |
| F5 | The `GraphBuilder.workflow` precedent types child input as `Ref.Input<NoInfer<S["input"]["Type"]>>` against `Definition<S>`. | [code] `workflow.ts:223-228` |
| F6 | `encode()` uses `Schema.encodeUnknownSync(schema)(value)` with default options. **It silently strips excess properties**: `{repository:"abcd", extra:1}` encodes to `{"repository":"abcd"}`. It does enforce checks, and it rejects a raw `Date` for `DateTimeUtcFromString`. `decode()` rejects excess properties (`onExcessProperty: "error"`). | [code] `boundary.ts:25-35`; [probe] |
| F7 | `canonical(Json)` exists and produces sorted-key canonical JSON. It is suitable for an input fingerprint. | [code] `boundary.ts:37-52` |
| F8 | `Cron.parse` accepts 5 fields (seconds is set to `0`) or 6 fields (seconds first), plus `*`, lists, ranges, steps, and month or weekday aliases. It **rejects** `@hourly` ("Invalid number of segments"), `L`, `#`, `?`, and `W`, all with the generic "Expected a positive integer", which gives no precise modifier diagnosis. The time-zone argument also accepts offsets like `"+05:00"`. | [code] `Cron.ts:552-605,1250-1437`; [probe] |
| F9 | **Unsatisfiable expressions parse successfully, but `Cron.next` throws a plain `Error`**: `"0 0 30 2 *"` → `THROW Unable to find cron date`. Inside an Effect that is a defect, not a typed failure. | [code] `Cron.ts:1047`; [probe] |
| F10 | **`Cron.format` is not a faithful serialization.** `"0 0 */2 * 1"` parses with `and = true` (days starts with `*`, Vixie-style), but formats as `"0 0 1-31/2 * 1"`, which re-parses with `and = false`. The two give different `next` values (Nov 9 vs Nov 2 2026). `and` is `@internal`. | [code] `Cron.ts:83,575-583,652`; [probe] |
| F11 | `Cron.next(cron)` with no `now` reads `new Date()` (wall clock), not Effect `Clock`. | [code] `Cron.ts:837` |
| F12 | **DST, America/Chicago, with probes:** fall-back hourly `0 * * * *` fires 05:00Z, 06:00Z, **08:00Z**. The repeated 01:00 CST (07:00Z) is skipped, so each wall time fires once at its first instant. `*/15` jumps from 06:45Z to 08:00Z, a **75-minute gap**. Spring-forward `30 2 * * *` fires at 08:30Z (03:30 CDT, shifted forward). Hourly across the gap gives 07:00Z then 08:00Z (no 02:00 slot, no duplicate). | [probe] |
| F13 | `Cron.equals("0 0 * * *", "0 0 0 * * *")` is `true`. | [probe] |
| F14 | Host storage is one SQLite DB per repository behind an exclusive OS lock (`RepositoryLease`), so only one process owns a repository. Swamp's HA fire-claim and dedup machinery has no counterpart here and should not be imported. | [code] `ownership.ts:18-60`, `host-store.ts:122-175` |
| F15 | `host_runs` has `UNIQUE(principal, requestKey)`, and `requestKey` is limited to 1–200 chars. `submit(request, resolvedRevision, principal)` inserts inside a `database.transaction`. Cancellation receipts are keyed `(runId, requestKey, actor)` with a fingerprint, and reuse with a different fingerprint returns `Conflict`. | [code] `host-store.ts:128-163,600-660,1228-1300` |
| F16 | The active revision pointer is an in-memory `active` plus `active.json` on disk, **not SQLite**. `activate` accepts a synchronous `publish` callback that runs before the pointer swap. `get(revision = active)` returns `{registry, revision}`. | [code] `revisions.ts:256-296` |
| F17 | Host code timestamps with `Date.now()` / `new Date()` throughout (e.g. `host-store.ts:642,1294`, `runner.ts:64`). No host service reads Effect `Clock` today. `effect/testing/TestClock` (`adjust`, `setTime`, `layer`) exists. | [code] |
| F18 | `NeedsAttention` is non-terminal and is set when finalization stalls (`runner.ts:60-78`). `Waiting` can last up to 365 days (wait timeouts use `durationMillis`, max 365 days). | [code] `protocol.ts:5-25`, `policy.ts` |
| F19 | The codebase already has a `WorkflowPatch.make` namespace: a two-word `Workflow*` namespace exported from `@offtree/effectory-sdk`. | [code] `index.ts`, `workflow-patch.ts` |

## 2. Blockers

### B1. Scheduled input: encode strictly, and say exactly when and where it is validated

The draft says that input is the decoded `Type` and is "encoded/validated during application construction". Two problems:

- F6: a non-literal input such as `input: config` with an extra key would be silently stripped, while a manual `WorkflowRun` with the same JSON is rejected by `decode`. That asymmetry is a correctness bug.
- "Application construction" is ambiguous. Given F3, there are two phases, and the draft must assign each check to one.

**Fix [proposal]:**

- In `WorkflowSchedule.make`, which runs synchronously and throws `DefinitionError` like `Workflow.make` (F3), check `identifier(id)`, the cron grammar, the zone, and the catch-up duration. Then compute `encoded = Schema.encodeUnknownSync(workflow.inputSchema)(input, { onExcessProperty: "error" })`, apply the `Schema.Json` check and `checkJsonBudget`, and confirm that `decode(workflow.inputSchema, encoded)` succeeds (a round-trip proof). Freeze `{ ..., encodedInput, fingerprint }`. Never retain the `Type` value as the source of truth.
- In the `Registry` Layer build, which runs as an Effect, check: duplicate schedule IDs; that `schedule.workflow` is reference-identical to a **top-level registered** workflow; and whether a workflow that is only reachable as a linked child (F4) counts. I recommend rejecting that case, with the message "schedule targets workflow X, which is not listed in `workflows`". Extension workflows follow the existing explicit selection rules.
- Type the input like the builder precedent (F5), so that inference comes from `workflow` and `input` is checked rather than inferred:

```ts
// [proposal — not typechecked]
export function make<const S extends Workflow.Spec>(spec: {
  readonly id: string;
  readonly workflow: Workflow.Definition<S>;
  readonly input: NoInfer<S["input"]["Type"]>;
  readonly cron: string;
  readonly timeZone?: string; // IANA name; default "UTC"
  readonly catchUp?: "skip" | { readonly latestWithin: string };
  readonly description?: string; // cosmetic: not part of the generation
}): Definition<S>;
```

`Type`, not `Encoded`, is correct for TS authors because it matches `builder.workflow` and the existing task and workflow call sites. `Encoded` is the wire and storage form only. The draft's "no duplicated schema" is correct, and there should be no `inputSchema` override.

**Feasibility proof needed:** compile-time tests (`// @ts-expect-error`) showing that a wrong input type is rejected and that `input` does not widen `S`, and a runtime test showing that a non-literal excess key throws `DefinitionError`.

### B2. Cron grammar: pin it to a precise subset, with a pre-lexer and a satisfiability probe

Effect Cron does not cover Swamp's croner grammar (F8). The parts it does accept have edge cases that would crash the scheduler or corrupt identity (F9, F10).

**Fix [proposal]:**

- **v1 grammar = 5 fields only**: minute, hour, day-of-month, month, day-of-week, with `*`, lists, ranges, steps, and the `jan…dec` / `sun…sat` aliases. Day-of-month and day-of-week use Vixie semantics, which is what Effect implements: if either field starts with `*`, both must match; otherwise either may match. Document this explicitly, and note in the doc that croner's default may differ for patterns like `*/2`. That divergence is a parity gap, not a bug.
- **Defer the 6-field seconds form.** It adds sub-minute schedules, which multiply occurrence history (B5) and timer pressure, and no consumer case in the draft needs it. Adding it later is backward-compatible. Removing it is not.
- **A pre-lexer before `Cron.parse`** turns unsupported syntax into precise `DefinitionError`s, for example: "`@hourly` nicknames are not supported; use `0 * * * *`", "`L` (last day) is not supported", "`#` (nth weekday) is not supported", "`?` is not supported; use `*`", "`W` is not supported", "6-field expressions with seconds are not supported". Effect's own messages are too generic to meet the draft's "precise error" requirement (F8).
- **Satisfiability probe at `make`:** wrap `Cron.next(parsed, FIXED_EPOCH)` in try/catch and reject `"0 0 30 2 *"`-style expressions (F9). At runtime, always call `Cron.next` through `Effect.try` mapped to a typed scheduler error, never as a defect.
- **Never pass `now` implicitly** (F11). Always pass `yield* Clock.currentTimeMillis`.
- **Identity text:** the generation uses the whitespace-normalized **source string**, never `Cron.format` (F10). `"0 0 * * *"` and `"0 0 0 * * *"` are moot once seconds are deferred.
- **Reject the "accept `Cron` values" convenience.** A `Cron` value has no faithful public serialization (F10: `and` is internal), and it carries its own `tz`, which conflicts with `timeZone`. One syntax is enough.

**Feasibility proofs needed:** a grammar table test that runs each accepted and rejected token through `make`, a round-trip of the Vixie AND/OR cases, and the `Feb 30` rejection.

### B3. Time zones and DST: adopt the probed Effect behavior as the documented contract

The draft requires DST proof before approval. F12 is that proof for Chicago, and it shows one consequence that consumers will notice.

**Fix [proposal], to be written into the draft as the contract:**

- `timeZone` accepts an IANA name validated with `DateTime.zoneMakeNamed` plus the literal `"UTC"`. Fixed offsets such as `"+05:00"` are rejected, because Effect accepts them (F8) but they are a footgun. The stored zone is the normalized name.
- **Gap (spring forward):** a wall time that falls in the gap fires once, shifted forward by the gap length. For example, 02:30 fires at 03:30 local. If that collides with an existing slot (hourly at 02:00 becomes 03:00), it fires once.
- **Fold (fall back):** each matching wall time fires **once**, at its **first** instant. Consequence: sub-hourly schedules in a DST zone have one interval of roughly 1h15m each fall-back. Document "use `UTC` for interval-like schedules".
- Zone rules come from the runtime's ICU tzdata. A tzdata change may move future instants without changing the generation. That is acceptable but should be documented.

**Feasibility proof needed:** commit the F12 cases as unit tests (Chicago fall-back hourly, fall-back `*/15`, spring-forward `30 2`, spring-forward hourly), plus one southern-hemisphere zone and `Europe/London`, all against pure `Cron.next` with explicit instants. These are cheap and catch Effect upgrades that change behavior.

### B4. Define "on time" versus "missed": one tick algorithm, testable with TestClock

The draft defines downtime catch-up but not what happens when the scheduler wakes late while running: a GC pause, laptop suspend, a slow transaction, or a long `setTimeout` drift. Under `"skip"`, a slot detected 3 seconds late must not be "missed", and one detected 3 hours late after suspend should be. Today that line is implicit.

**Fix [proposal]:** a single algorithm runs at startup, after resume and generation changes, and on every wake:

```
due   = cron slots in (watermark, now], computed from Clock and the schedule zone
L     = latest(due)               // older slots are recorded as missed (count, capped)
if paused                       → record L…as paused; watermark := L
else if now − L ≤ GRACE         → admit(L, catchUp=false)   // subject to overlap
else if catchUp.latestWithin and now − L ≤ latestWithin
                                → admit(L, catchUp=true)    // subject to overlap
else                            → record missed(reason)     // downtime | draining | late
watermark := L                  // monotonic; if now < watermark (rollback) do nothing
sleep min(next(watermark) − now, MAX_TICK)                  // recompute on every wake
```

- `GRACE` is a fixed internal constant (say 60 s) and is documented, but it is **not** a public setting.
- `MAX_TICK` (say 60 s) bounds the damage from a wall-clock jump that occurs while `Clock.sleep` is pending. Without it, a jump forward is noticed only when the old timer fires.
- Missed-slot counting uses a bounded walk with a cap (for example 10 000) and reports `{count, saturated}`, in the style of Swamp's `lastMissed`.
- The **first activation** sets watermark := now, so there is no history replay, as the draft says.

**Feasibility proof needed:** extract the decision as a pure function `decide(state, definition, now): Decision`. Test it table-style with plain instants, then run one thin `Effect` loop under `TestClock.adjust` with an in-memory SQLite store. Note F17: host-store stamps `acceptedAt` with wall time, so TestClock tests must not assert those fields, or the scheduler-owned columns (`scheduledFor`, `decidedAt`) must come from `Clock`. Use Clock for everything the scheduler writes. Do not refactor the existing host-store clocks as part of this feature.

### B5. Occurrence storage, principal, and the bounded-history contract

The draft says "occurrence identity = schedule ID + generation + UTC instant" and "admission and dedup receipt are transactional", but leaves several points open. Who owns the run? How does the occurrence key fit F15's `requestKey` limit? Is the occurrence history bounded? A minutely schedule blocked by one `NeedsAttention` run (F18) would write 1 440 overlap rows per day indefinitely.

**Fix [proposal]:**

- **Principal:** scheduled runs belong to the repository owner principal (the codebase defaults to `"owner"`, e.g. `lake.ts:166`). That keeps them visible in `RunList` and cancellable with `RunCancel` with no new authorization model. State this explicitly.
- **Do not overload `requestKey`.** Schedule ID (≤200 characters) plus generation plus instant does not fit in 200 characters. Add a `host_schedule_occurrences(scheduleId, generation, scheduledFor, outcome, runId NULL, …)` table with `PRIMARY KEY(scheduleId, generation, scheduledFor)`. Insert it **in the same SQLite transaction** as the `host_runs` row (F15 shows that `submit` already runs in a transaction, so this needs a store-level `submitScheduled` variant). The run's `requestKey` can be a derived opaque digest, for example `sched_<sha256-prefix>`, in a namespace that the CLI rejects for user keys.
- **Bounded history:** record each _admitted_ occurrence individually. **Coalesce** consecutive non-admitted slots with the same reason into one range row `{fromSlot, toSlot, count, saturated, reason}`. Retain the last N rows (for example 1 000) per schedule. The draft should state the exact cap, which it currently leaves open ("may be capped").
- **Reasons enum (closed):** `Admitted | Overlap | Paused | Downtime | Draining | Late | AdmissionFailed`. Use `AdmissionFailed` only when the host returns a typed capacity or limit error. A rolled-back storage failure records nothing, and the slot is reconsidered on the next tick with the same identity, which already satisfies the draft's "retries keep the same occurrence identity".

### B6. Generation and revision coupling: derive the generation, do not store it ahead of activation

"Captured atomically with the schedule generation" cannot be literally atomic, because the active pointer lives in a file and in memory, not in SQLite (F16). There is also the same-ID recreation edge case.

**Fix [proposal]:**

- On each tick, the scheduler reads `{registry, revision} = revisions.get()` **once**. It computes `generationKey = sha256(canonical({workflowId, workflowVersion, encodedInput, cronSource, timeZone, catchUp}))` from that registry. Admission uses that same `revision`. A generation row is created lazily the first time the scheduler observes the key. If activation happens mid-tick, the next tick sees the new revision. Nothing needs to commit across stores, and a crash between SQLite and `active.json` cannot leave the two out of sync.
- `generation` on the wire is a monotonically increasing integer per schedule ID, assigned when a new key is first observed. The key itself is internal. `description` is excluded.
- **Same-ID recreation resolves to continuity of identity, not of time:** the ID is the identity, so the pause state and occurrence history are retained across removal and re-addition. Any removed→present transition starts a **new generation epoch**, even when the definition is byte-identical. Otherwise the old watermark would cause catch-up of slots that fell during removal. Show `paused: true` prominently when a re-added schedule inherits a pause.
- Pause and resume on a `removed` schedule return `Conflict` (`ScheduleRemoved`).

## 3. Non-blocking: Effect-native shape and preferences

**P1. Name: keep `WorkflowSchedule.make`.** F19 gives a direct precedent (`WorkflowPatch.make`). `Schedule.make` collides with `effect/Schedule` in every file that imports both, which is a real cost, not just a conceptual one. `Workflow.schedule(...)` puts a non-graph concept into the namespace that holds `Builder`, and makes `Definition` ambiguous. `Trigger.cron` is premature. Recommend one shape only and no aliases. The `schedules:` field on `Application.make` is right, and it should not change `Application<R>`'s type parameters (F2). I recommend a typecheck proof that adding `schedules` leaves `Application.make(...)`'s inferred `R` unchanged.

**P2. Registry.** Extend `Registry` with `schedules: ReadonlyMap<string, CompiledSchedule>`. The scheduler is a separate host service, `Scheduler.layer: Layer<never, never, Revisions | HostStore | Lifecycle>`, built with `Layer.effectDiscard` + `Effect.forkScoped`, so that Layer teardown interrupts it. No timers are started while the application loads, as the draft requires. Admission is a synchronous SQLite transaction inside `Effect.try`, so interrupting the scheduler fiber cannot split an admission.

**P3. Drain.** On `drain`, the scheduler fiber stops before the run-admission gate closes. Slots that fall during the drain are recorded as `Draining` at the next start (via B4). Make this ordering explicit.

**P4. Overlap lock wording.** "At most one nonterminal scheduled run" includes `Cancelling` and `NeedsAttention` (F18). That is safe, but it can block a schedule indefinitely. Leave the lock un-configurable in v1, which I agree with, and require that `ScheduleGet` expose `blockedBy: {runId, status, since}`. `RunCancel` on that run is the documented remedy. The consumer reviewer should weigh in on this.

**P5. Pause/resume `expectedGeneration`.** Pausing is always safe, so making the CLI fetch the generation and send it back is ceremony without protection, because it only re-reads the state. Recommendation: make `expectedGeneration` an optional wire field and have the CLI omit it. Idempotency follows the cancellation precedent (F15): key `(scheduleId, requestKey, actor)`, fingerprint `{operation}`, and reuse of a key with the opposite operation returns `Conflict`.

**P6. Wire schemas.** Use `Schema.Struct`, consistent with `protocol.ts`. Represent timestamps as ISO UTC strings, matching `acceptedAt` on the existing `Run`. Add an optional `schedule: Schema.optional(ScheduleProvenance)` to `Run`. That is additive, and existing manual-run responses stay byte-identical when the field is absent (needs a check of `Schema.optionalKey` versus `optional` encoding). Defer `RunList --schedule`, because `schedule occurrences` already joins to `runId`.

```ts
// [proposal — not typechecked]
export const ScheduleProvenance = Schema.Struct({
  scheduleId: Schema.String,
  generation: Schema.Int,
  scheduledFor: Schema.String, // ISO UTC
  catchUp: Schema.Boolean,
});
export const OccurrenceOutcome = Schema.Literals([
  "Admitted",
  "Overlap",
  "Paused",
  "Downtime",
  "Draining",
  "Late",
  "AdmissionFailed",
]);
export const Occurrence = Schema.Struct({
  fromSlot: Schema.String,
  toSlot: Schema.String, // == fromSlot for single slots
  count: Schema.Int,
  saturated: Schema.Boolean,
  outcome: OccurrenceOutcome,
  generation: Schema.Int,
  runId: Schema.NullOr(Schema.String),
});
```

**P7. Workflows cannot see `scheduledFor`.** A consumer gap that the draft does not mention. Swamp exposes `swamp.trigger.scheduledFor` to workflows. With fixed input and no provenance in the run context, a "report for the hour ending at the slot" must read the execution-time clock, which drifts on catch-up and retries. I agree that schedule metadata stays out of the user's input schema. As a separate, additive follow-up, consider a read-only `schedule: Option<{scheduleId, scheduledFor}>` on `Task.Identity`. Decide before presentation whether v1 includes it. My recommendation is to defer it, but to name it as a known limitation.

**P8. `latestWithin` bounds.** Positive and ≤31 days is fine. It reuses `durationMillis` (which allows 365 days), plus an explicit 31-day check. No `"0 seconds"`.

**P9. Swamp parity statement.** Gaps to list honestly: nicknames, `L`, `#`, `W`, seconds, the croner day-of-month/day-of-week defaults, live filesystem reload, HA dedup (not applicable per F14), and the max-concurrent-scheduled-runs queue (Effectory instead admits into its normal run queue).

## 4. Feasibility proofs to run before implementation approval

1. A type-level test that `WorkflowSchedule.make` rejects wrong input, does not widen `S`, and leaves `Application.make`'s `R` unchanged (B1, P1).
2. A runtime test that encoding a non-literal input with an excess key throws, and that a check failure throws (B1).
3. A grammar table and the Feb-30 satisfiability probe, plus the Vixie AND/OR cases and a demonstration that `Cron.format` is not used for identity (B2).
4. DST tables built from F12 plus two more zones (B3).
5. A pure `decide` table and one `TestClock` + in-memory SQLite loop test covering on-time, late, downtime, catch-up within and outside the window, clock rollback, pause, and overlap (B4).
6. A transaction test that a crash or rollback between occurrence insert and run insert leaves neither row, and that a retry reuses the identity (B5).
7. Activation during a tick, and removal → re-add with an identical definition, which creates a new generation, inherits the pause, and does not catch up (B6).

## 5. Summary for the parent

Request changes. Keep the spec/Layer separation, the `WorkflowSchedule.make` name, and the `Type`-typed input. Before presenting:

- **B1:** encode input strictly (`onExcessProperty: "error"`, because the current `encode` strips silently) and split make-time from Layer-time checks.
- **B2:** limit the v1 grammar to 5 fields, with a pre-lexer for precise errors and a satisfiability probe. Never use `Cron.format` for identity, and drop the `Cron`-value convenience.
- **B3:** adopt the probed DST contract (gap shifts forward, fold fires once at its first instant, IANA names only).
- **B4:** specify one tick algorithm with a fixed grace and a bounded sleep.
- **B5:** owner principal, a separate occurrence table admitted in the same transaction, and coalesced bounded history.
- **B6:** derive the generation from the revision read once per tick, and give re-added IDs a new epoch.
