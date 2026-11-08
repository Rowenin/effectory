# Scheduling API — approved revision 3

The user approved this public API with “lgtm” after two rounds of Claude critiques from Effect and consumer perspectives. The constructor, application discovery, durable scheduler, CLI and RPCs are now implemented. The review history below records the design decisions; implementation evidence is summarized in [implementation status](implementation-status.md).

## Decisions after Claude review

Retain a pure frozen `WorkflowSchedule.make` specification, application-owned schedules, fixed schema-bound input, and the normal durable run submission path. Use five-field cron strings only. Add explicit inspection/provenance, bounded history, strict encoding, stable pause identity, and concrete timing semantics. This revision incorporates both rounds of Claude review. The round-2 reviewers conditionally approved presentation once the narrow retention and extension-wording corrections were applied; those corrections are recorded below. No reviewer has approved runtime implementation on the user's behalf.

Two reviewer suggestions are deliberately adjusted:

- Do not reserve a prefix in existing users' request keys. Internal scheduled admission gets its own deduplication namespace while sharing the owner principal. This avoids a new public restriction and prevents any collision even if a caller copies the displayed opaque schedule key.
- Automatically discover workflows referenced by schedules, using the same canonical-identity and task-contract checks as linked workflows. Requiring the same workflow twice in Application is unnecessary. Neither linked-child discovery nor an explicit workflows entry detects a directly imported module-extension workflow used without Extension.use when its canonical tasks are otherwise registered. Schedule discovery follows exactly that existing rule. Extension.use remains necessary to select extension provenance, patches and implementations; this feature does not introduce ownership branding for directly imported definitions.

Other choices: no generation precondition on pause/resume, which act on stable IDs; removed schedules may still be paused/resumed; generation is an integer (digest internal); history is named `schedule history`; list uses `--state`; schedule provenance is available in Run and RunSummary (these are separate existing schemas). No scheduled-input callback or runtime schedule creation.

## Consumer authoring

```ts
import { Application, WorkflowSchedule } from "@offtree/effectory-sdk";

const HourlyCheck = WorkflowSchedule.make({
  id: "hourly-release-check",
  workflow: CheckReleases,
  input: { repository: "Rowenin/example" },
  cron: "0 * * * *",
  timeZone: "America/Chicago",
  catchUp: { latestWithin: "1 hour" },
});

export default Application.make({
  tasks: [FetchReleases, PublishReport],
  schedules: [HourlyCheck],
}).provide(Services);
```

`workflows: [CheckReleases]` remains legal but is not required just to schedule it. The same definition can be registered both ways without duplication. Multiple schedule IDs may target the same workflow with different fixed inputs. Tasks and extension service requirements must still be supplied normally.

Public type signature:

```ts
function make<const S extends Workflow.Spec>(spec: {
  readonly id: string;
  readonly workflow: Workflow.Definition<S>;
  readonly input: NoInfer<S["input"]["Type"]>;
  readonly cron: string;
  readonly timeZone?: string;
  readonly catchUp?: "skip" | { readonly latestWithin: string };
  readonly description?: string;
}): Definition<S>;
```

Input is required, including explicit null/{} where the workflow needs it. Default zone UTC; default catchUp "skip". No new handler, Layer acquisition, or timers in the constructor. No Effect Schedule or Cron objects in this spec.

### Validation and Effect integration

At make time, synchronously throw DefinitionError for invalid IDs, options, cron, zone, catch-up window, or input, consistent with existing constructors. Input is the decoded codec Type. Encode with `onExcessProperty: "error"`, preflight JSON byte/depth/value budget before recursive JSON decoding, then verify strict decode of encoded input. Retain an immutable copy of encoded JSON rather than a mutable caller object. Encoding may normalize input according to the codec; equality of decoded object identities is not required. JSON limits match current 1 MiB/depth 64/value-count 100000. Do not route this through the existing permissive encode helper unchanged.

During the Registry Layer build, detect duplicate schedule IDs, conflicting workflow identities, missing tasks/services. Directly imported module-extension definitions follow the existing task-contract rule described above; do not claim a separate workflow ownership check. Schedule discovery must not erase Application's existing task/extension service requirements. Same canonical workflow referenced from multiple schedules is compiled once. Different definitions with the same workflow ID fail, as for linked children.

### Cron and time zones

Five fields: minute, hour, day-of-month, month, day-of-week. Accept wildcard, list, range, steps and month/weekday aliases supported by pinned Effect Cron. Explicitly reject six-field expressions, nicknames, L/#/W/? with actionable syntax errors. Preserve whitespace-normalized source text for identity; never serialize via Cron.format, which loses wildcard semantics in Effect 4.0.5. Do not claim complete croner grammar parity.

Day-of-month and weekday use Effect's Vixie rules: if either starts with `*`, both conditions match; otherwise either may match. Validate satisfiability with a caught next-occurrence probe from a fixed epoch; impossible expressions such as Feb 30 throw DefinitionError, never an uncaught daemon defect. Runtime next/prev errors are caught and shown as schedule errors.

Accept UTC and named IANA time zones, reject numeric offsets. Validate the named zone but preserve its spelling as authored for identity; do not change the generation solely because runtime ICU canonicalizes an alias differently. Future instants follow runtime ICU tzdata; changing tzdata is not a new source generation.

Adopt pinned Effect Cron's DST semantics: missing spring wall times shift forward by the gap; repeated autumn wall times fire once at their first instant. UTC is recommended for interval-like schedules. Chicago examples measured against Effect 4.0.5: `30 2 * * *` fires 2026-03-08 at 08:30Z (03:30 local); `30 1 * * *` fires 2026-11-01 at 06:30Z and not 07:30Z. A quarter-hour schedule can have a 75-minute autumn interval. Keep tests for gaps, folds, collisions, next/prev agreement, London and a southern zone before shipping.

## Durable operational semantics

Scheduling works only while the repository daemon runs. The feature does not install an OS service or auto-start the daemon. Startup reconciles the retained state and active application before enabling the scheduler. Drain closes admission before interrupting the scheduler; no newly accepted occurrence can pass the closed gate.

### Identity, revisions and updates

Schedule ID is stable identity within the repository owner while its record is retained. It retains history and pause state across restart, edits, removal and re-addition. Unknown or evicted IDs are NotFound; removed retained IDs remain inspectable and can be paused/resumed. A newly activated definition may be NotFound until reconciliation; that response identifies both active and scheduler revisions so callers can wait for SystemStatus.scheduler.revision.

Generation is drawn from a repository-wide increasing counter and never reused, including after tombstone eviction. It changes when target ID/spec version, encoded input, normalized cron, zone or catch-up policy changes. Description is cosmetic. Identical schedule definitions across application revisions preserve generation/watermark and adopt the newer implementation for future runs. Existing runs keep their pinned revision.

The scheduler reads one `{registry, revision}` snapshot per reconciliation/tick, and admission captures that exact revision. We do NOT claim a filesystem pointer and SQLite commit form one atomic transaction. Scheduling changes become effective when that snapshot is reconciled; SystemStatus reports the scheduler's reconciled application revision. A tick that already captured the preceding revision may finish before the next reconciliation. Activation/drain checks must fence a stale scheduler from admitting after shutdown, but user edits are not a transaction spanning all current ticks.

First observation of a new/changed generation begins at the next future slot, without retroactive input changes or pre-creation catch-up. A removed state actually observed by the scheduler stops new admission; admitted runs continue. Observing a removed ID become present opens a fresh generation even with identical content, preserves its pause, and does not catch up the removal interval. Source edits never activated or intermediate revisions never observed by scheduling do not manufacture a remove/re-add event. This observation boundary must be visible via scheduler revision and tests.

### Overlap and pause

At most one nonterminal scheduled run per schedule ID, across generations, including Queued/Running/Waiting/Retrying/Cancelling/NeedsAttention. Later eligible occurrences are skipped for overlap. Manual runs and different schedule IDs are independent; there is no per-workflow global lock. NeedsAttention can block indefinitely until resolved through the existing inspect/cancel path; no automatic retry-anyway is added.

Pause stops future admission, not accepted runs. Resume starts strictly after its operation time (a slot exactly at that instant is excluded) and never catches up the deliberately paused interval, even if the daemon was down. A pause survives same-ID edits and re-addition. Pause/resume are idempotent mutations on stable identity, with no expectedGeneration parameter. While its receipt is retained, repeating the same request key returns the original receipt without applying the mutation again; reusing it for the opposite operation or changed reason conflicts. Keys are scoped to schedule ID and actor. Only the newest 256 pause/resume receipts per schedule are retained; an evicted key is treated as a new request and can change current state. Thus automatic retries are guaranteed only within that retained mutation window, not forever. A new key applied to an already-matching state succeeds with changed=false. Removed state remains Removed after either mutation; it only controls future re-addition.

### On-time and missed occurrences

One algorithm handles startup reconciliation and loop wakes using injected Effect Clock, always passing explicit instants to Cron. Fixed advertised admission grace: 60 seconds; recheck wall time at least every 1 second while live (internal sleep strategy may improve without changing semantics).

For unchanged, unpaused definitions, find due slots after the watermark and at or before now. Cron.next/prev are exclusive at exact matches: explicitly handle a matching current instant rather than dropping that slot. Consider only the latest due slot for admission, coalescing older ones as missed. If latest is no more than 60 seconds old, admit as on-time; otherwise admit as catch-up only under latestWithin and within its window (minimum 1 minute, maximum 31 days). Otherwise record missed. Overlap/pause rules always apply. A restart within the 60-second grace may admit with catchUp=false even under "skip"; skip means skip older missed slots, not require an exact millisecond timer wake. Forward jumps/suspend use the same rules; rollback never decreases the watermark or replays admitted slots.

Storage/temporary capacity failure is not a successful firing and does not advance the admission watermark. Retain at most one pending candidate per schedule, retry using its same identity while still eligible. If a later due slot supersedes it, coalesce the older candidate as AdmissionFailed once storage is available; never accumulate a queue. Under skip, eligibility is the 60-second grace; under latestWithin, use max(grace, window). Failed writes may leave only in-memory diagnostics until storage recovers. No claim to persist diagnostics when the disk is full.

Occurrence identity is `(owner, scheduleId, generation, scheduledForUTC)`. Atomically commit occurrence admission, native run admission/outbox, and watermark in the same SQLite transaction. Use an internal admission namespace in addition to the existing owner + requestKey dedup identity; all existing manual keys remain valid and cannot refer to the scheduler namespace. Scheduled runs expose an opaque key <=200 characters, but callers must not use it as a manual retry recipe. Schedule recovery uses occurrence identity. Preserve original manual-run dedup semantics. The same displayed requestKey may occur in different internal namespaces; use run.schedule to identify scheduled runs, not its requestKey spelling.

## Public inspection/control

New `schedule` CLI group; existing `--repository` / `--json` flags apply:

- `schedule list [--workflow ID] [--state active|blocked|paused|removed] [--limit N] [--cursor TOKEN]` -> ScheduleList.
- `schedule get ID` -> ScheduleGet.
- `schedule history ID [--limit N] [--cursor TOKEN]` -> ScheduleHistory.
- `schedule pause ID [--reason TEXT] [--request-key KEY]` -> SchedulePause.
- `schedule resume ID [--request-key KEY]` -> ScheduleResume.

CLI generates optional request keys once and reports them on uncertain delivery. RPC always requires a key. No run-now alias, source mutation RPC, generation guard, or run-list schedule filter in this slice. Manual WorkflowRun remains available. Every boundary uses Effect Schema and existing owner authorization before pagination or receipt lookup.

Summary wire shape (implemented with Effect Schema):

```ts
type ScheduleSummary = {
  scheduleId: string;
  workflowId: string;
  generation: number;
  state: "Active" | "Blocked" | "Paused" | "Removed";
  cron: string;
  timeZone: string;
  nextScheduledAt: string | null;
  blockedBy: { runId: string; status: RunStatus } | null;
  lastRun: { runId: string; status: RunStatus; scheduledFor: string } | null;
  lastMissed: MissedRange | null;
  lastError: { code: string; message: string; at: string } | null;
};
```

State precedence: Removed > Paused > Blocked (prior scheduled run nonterminal) > Active. blockedBy may still be populated while paused/removed. nextScheduledAt is null for Paused/Removed; for Blocked it shows the next occurrence to be considered, not a promise of admission. Get adds encoded input, catch-up policy, description, reconciled application revision, and pause `{at, actor, reason} | null`. A waiting blocker should point humans to `run waits`; NeedsAttention points to `run get` and `run cancel`. Do not claim ordinary cancellation force-resolves an uninterruptible effect.

Mutation receipt: `{scheduleId, operation: "Pause"|"Resume", paused, changed, generation, requestKey, actor, acceptedAt}`. It records the state accepted at that time; duplicate receipts can differ from current state, as with cancellation. Reason length <=8192 bytes; absent/null conventions must follow concrete Schema design rather than silently alter request fingerprints.

List excludes Removed by default; use `--state removed` to include those retained identities. An application with no schedules returns an empty page. List returns `{items, cursor, snapshot}` with fixed identity membership and current projections, matching RunList. History returns `{items, cursor, snapshot}` from a frozen retained view. Admitted entries contain scheduleId, generation, scheduledFor, runId, current run status and catchUp. Missed entries contain scheduleId, generation, fromSlot, toSlot, count, saturated, and reason `Overlap|Paused|Downtime|Late|AdmissionFailed`; at restart, old slots since the persisted checkpoint are Downtime; late wakes in the same process (including suspend) are Late. Shutdown absence is Downtime, not a guessed separate Draining reason. Count is capped at 10000 per range; saturated says further slots exist.

Consecutive misses with the same generation/reason coalesce. Keep at most 1000 history entries per schedule; record trimming bounds for inspection. Mutable ranges cannot silently change across a cursor: version their stored projection or freeze bounded rows for the cursor. A pruned snapshot returns CursorExpired, never a successful gap. Old admitted runs remain in ordinary run history; a monotonic watermark/tombstone preserves dedup beyond history pruning. Receipt records are immutable while retained. Keep the newest 256 per schedule, evicting the oldest as new mutations commit. Pause/resume never fails solely because its receipt count reached the cap; physical storage errors remain possible. See the finite retry guarantee above.

At most 128 schedules may be declared in one application; exceeding it fails Registry build with DefinitionError. Separately retain up to 1024 removed identities. Evict the oldest removed identity only if unpaused and without a nonterminal scheduled run, dropping its schedule history and receipts; ordinary run history/provenance remains. Re-adding an evicted ID starts fresh and gets a never-reused generation. Paused or blocked removed identities are never evicted. If no eligible identity can be reclaimed, a change that would exceed the bound fails clearly and directs the operator to resume an unblocked removed schedule; do not silently discard pause or overlap protection. Pages <=200, bytes <=1 MiB. These limits are advertised by SystemStatus and may be raised later.

Add optional `schedule: {scheduleId, generation, scheduledFor, catchUp}` using Schema.optionalKey to both Run and RunSummary so Get, List, foreground results and Watch snapshots agree. Manual responses retain their existing field shapes. Events/occurrences link to run IDs. Schedule metadata is NOT injected into customer input. The initial scheduling slice did not expose scheduledFor to task handlers. The subsequent approved [task context addition](scheduled-task-context-api-draft.md) now exposes it as context.occurrence; it identifies one slot and does not guarantee contiguous processing windows.

SystemHello advertises `schedule.v1`. SystemStatus adds scheduler `{state: "Running"|"Draining"|"Stopped", revision, activeSchedules, pausedSchedules, blockedSchedules, lastError}`. Repository daemon must be running. A per-schedule calculation failure is reported in lastError and does not stop unrelated schedules; unobserved revision and scheduler-wide failure are visible here. No daemon CLI disable flag in this slice; operational pause is sufficient.

## Explicit scope and parity gaps

This feature delivers durable app-owned scheduling, inspection, pause/resume, bounded latest-only catch-up, overlap suppression and restart deduplication. It does not yet cover all Swamp scheduling features: croner nicknames and L/#/W/? grammar, seconds fields, live filesystem reload, scheduledFor available inside tasks, Swamp's dedicated scheduled-run concurrency queue and configured run tags. Effect's Vixie day matching can differ from croner. HA claims are outside this single-owner host. These are outstanding parity work, not silently considered complete.

## Evidence and implementation gates

Verified against pinned code and direct probes: Effect accepts 5/6 fields, rejects unsupported modifiers, shifts Chicago spring 02:30 to 03:30, chooses the first fall 01:30 instant for next/prev, and strict codec encoding rejects excess fields. `Cron.next` throws on Feb 30; `Cron.format` changes wildcard AND/OR behavior (Effect review probe). Parent evidence is in dist/scheduling-review/cron-evidence.json; review files distinguish other code findings from proposals.

Acceptance criteria: negative/positive type fixtures (NoInfer, decoded codecs, preserved Application services); strict encode/decode and mutation-copy tests; grammar/satisfiability/zone/DST tables; pure decision and TestClock tests; transactional crash/rollback dedup; activation/reconciliation/drain races; overlap including Waiting/NeedsAttention across generations; pause/remove/re-add; receipt conflicts and uncertain delivery; bounded coalescing and cursor pruning; and real CLI output. The focused scheduling tests cover these criteria; the full repository checks remain the release gate.

## Review resolution and approval gate

Both round-2 Claude reviews request only narrow text corrections and explicitly allow presentation after those fixes, without another full review round. This revision applies them:

- Receipt cap: per schedule, newest 256, oldest-first eviction, explicit finite dedup window; no permanent inability to pause.
- Identity limit: 128 declared schedules, separate 1024 removed-record retention with only unpaused/unblocked eviction, repository-wide never-reused generations, explicit exhaustion remedy.
- Extension guarantee: accurately states canonical workflow/task checks and the existing direct-import ownership gap; does not promise a nonexistent Extension.use enforcement check.
- Clarifications: list excludes removed by default; keys scoped by schedule/actor; resume excludes its exact instant; catch-up minimum 1 minute; revision-lag diagnostics; authored time-zone identity; exact-now cron handling; downtime versus live lateness.

The reviewer conclusions were design reviews. The user subsequently approved implementation. Runtime correctness is checked separately by the constructor/type fixtures, timing tests, SQLite fault injection, TestClock scheduler tests and daemon/CLI recovery test.

## Implementation timing evidence

Acceptance tests exposed two subtleties beyond the review probes: `Cron.prev` truncates milliseconds before stepping, so adding 1 ms does not include an exact occurrence, and reverse search can throw inside a spring-forward gap. Due-slot calculation walks `Cron.next` forward, with bounded counting and a transition window for long outages. Tests cover exact instants, Chicago/London/Sydney gaps and folds, colliding shifted times and rollback. The public DST contract is unchanged.

The host admission schema now separates manual and scheduled deduplication namespaces. Existing repositories built with an older host format fail closed, consistently with retained host ABI checks. No in-place host upgrade/migration is claimed; preserve old repositories with their original build and backup procedure.
