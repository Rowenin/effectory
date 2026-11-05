# Scheduling API review — consumer perspective, round 1

Reviewer: Claude (consumer viewpoint). Subject: `docs/scheduling-api-draft.md` (NOT APPROVED draft). This review is not user approval. Nothing below was implemented or typechecked; every snippet is a proposal.

## Verdict: REQUEST CHANGES

The draft is a sound basis for a small, coherent feature: an app-owned, revisioned cron trigger with bounded catch-up, overlap suppression and read-mostly operations. The authoring shape is close to right. It should not go to the user yet. Six points either contradict each other or leave a normal operator unable to answer "why didn't my schedule run?". They are listed as blockers below. All of them can be fixed in the text, and none needs a broader design.

## Facts verified against source (existing behavior)

| Fact | Where |
| --- | --- |
| Child workflows reached from a registered graph are **auto-registered** (pushed onto `pending`), with a canonical-identity check (`Noncanonical workflow`). Only top-level workflows must be listed. | `packages/core/src/application.ts` (workflow loop) |
| `Application.make` computes `R` from tasks and extensions only. Workflows contribute no `R`. | `application.ts` `make` signature |
| Workflow input boundary is `Schema.Codec<unknown, unknown, never, never>`, so `spec.input["Type"]` is available for typing scheduled input. | `packages/core/src/boundary.ts:6`, `workflow.ts` `Spec` |
| Constructors are `X.make` and return frozen specs. `WorkflowPatch.make` already sets the `Workflow*` namespace precedent. | `workflow.ts:507`, `workflow-patch.ts:19`, `index.ts` |
| Durations are strings such as `"1 hour"`, parsed by `durationMillis` (units up to `weeks`). | `packages/core/src/policy.ts:4` |
| Every RPC uses the hard-coded principal `"owner"`. Run list, get, inspection and waits are filtered by `principal`. | `platform-bun/src/control-plane.ts:299,345`, `run-history.ts`, `inspection.ts` |
| Run dedup is `UNIQUE(principal, requestKey)` with an input/target/revision fingerprint. Reusing a key for a different submission fails with `Conflict`. | `host-store.ts:130-132, 890-912` |
| `Run` has a required `requestKey: String` and no provenance field. `RunGet`, `RunList` items and `WorkflowRun` all return `Run`. | `packages/runtime/src/protocol.ts` |
| CLI `--request-key` is **optional** everywhere and generated with `crypto.randomUUID()`. On uncertain delivery the CLI prints a retry hint. | `packages/cli/src/main.ts:45,193,270,372` |
| Extension mutations use an `expectedRevision` that the CLI fetches when omitted. This is the precedent the draft cites. | `main.ts:777-815` |
| The daemon only runs when started explicitly (`daemon start`/`serve`). The client does not auto-start it. | `main.ts:722-770`, `withClient` |
| `SystemStatus` reports `daemon {drain, instanceId, startedAt}` plus readiness. Capabilities are a fixed string list. | `system-protocol.ts`, `control-plane.ts:167` |
| `NeedsAttention` is nonterminal and requires "operator reconciliation then resume or cancel". Wait nodes require a `timeout`. | `docs/execution.md:22`, `workflow.ts` `WaitNode` |
| Effect 4.0.5 `Cron.parse(expr, tz?)` accepts 5 or 6 fields (seconds first) with `*`, lists, ranges, steps and month/weekday aliases. If both day-of-month and weekday are restricted, a date matches when either one matches. It has no nicknames (`@daily`) and no `L`/`#`/`?`/`W` (not in the documented grammar). `Cron.next` and `Cron.prev` exist (`prev` since 3.20). | `node_modules/effect/src/Cron.ts:515-560, 800-830` |
| Swamp schedules are a per-workflow `trigger.schedule` (croner grammar: nicknames, `L`, `#`). Catch-up is `policy: latest` with `maxDelay` (at most 31d). Overlap skips. `lastMissed` is coalesced current state (`count`, capped, `saturated`), not a row per slot. A file watcher reloads live. | `vendor/swamp/design/primitives/workflows.md:2740-2890` |

Everything else in this review is a proposal.

## Blockers

### B1. Scheduled runs must be visible and must not collide with user request keys

Today runs are visible only under principal `"owner"`, and dedup is per `(principal, requestKey)`. The draft never says which principal or request key a scheduled run gets.

- If a scheduler principal is used, scheduled runs disappear from `run list`, `run get`, `run wait`, waits and logs, because every query filters by principal. That would break the draft's own troubleshooting story.
- If `"owner"` is used with a derived key such as `schedule:<id>:<gen>:<instant>`, a user who happens to pass the same `--request-key` either gets the scheduled run back or hits a `Conflict`.

**Fix (proposal).** Admit scheduled runs under the same owner principal so all existing inspection works unchanged. Derive `requestKey` deterministically from occurrence identity and put it in a reserved namespace, `sched:<scheduleId>:<generation>:<scheduledForIsoUtc>`. Reject user-supplied keys that start with `sched:` with `InvalidInput`. A key over 200 characters must still fit `Id`, so hash the tail when needed, and say so. The derived key also gives the transactional occurrence dedup the draft wants for free, since it reuses the existing fingerprinted lookup. Add provenance as an optional field on `Run`, which also reaches `RunList`/`RunWatch` items. State that explicitly instead of saying "RunGet only":

```ts
// protocol.ts (proposed)
export const RunOrigin = Schema.Struct({
  scheduleId: Id,
  generation: Schema.Int,
  scheduledFor: Schema.String, // ISO-8601 UTC
  catchUp: Schema.Boolean,
});
export const Run = Schema.Struct({
  ...existing,
  schedule: Schema.optionalKey(RunOrigin),
});
```

Manual runs keep their current shape, with the key absent. Use `optionalKey`, not `NullOr`, so that existing manual `Run` JSON stays byte-identical, as the draft promises.

### B2. "Blocked by a waiting run" must be a first-class, visible state

With one nonterminal run per schedule, a run parked in `Waiting` (bounded by its wait timeout, which may be days) or in `NeedsAttention` (unbounded until an operator acts) silently stops the schedule. A user who sees "nothing ran since Tuesday" needs `schedule list` to show it at a glance, without paging through occurrences. The draft's `ScheduleGet` fields are only named, not shaped, and `list` has no state column.

**Fix (proposal).** Use a derived `state` with a small, closed set of values, plus a blocking pointer:

```ts
export const ScheduleState = Schema.Literals([
  "Active",
  "Blocked",
  "Paused",
  "Removed",
]);
export const ScheduleSummary = Schema.Struct({
  scheduleId: Id,
  workflowId: Id,
  state: ScheduleState, // Blocked = Active but a prior run is nonterminal
  cron: Schema.String,
  timeZone: Schema.String,
  nextFireAt: Schema.NullOr(Schema.String), // null when Paused/Removed
  lastFire: Schema.NullOr(
    Schema.Struct({ scheduledFor: Schema.String, runId: Id, status: RunStatus })
  ),
  blockedBy: Schema.NullOr(
    Schema.Struct({ runId: Id, status: RunStatus, since: Schema.String })
  ),
  missed: Schema.NullOr(MissedSummary), // see B5
});
```

`ScheduleGet` returns the summary plus `definition` (encoded input, catchUp, the application revision that set the current generation, generation, definitionDigest) and `pause` (`{pausedAt, requestKey} | null`). Human CLI output for `Blocked` should print the next step: `blocked by run <id> (NeedsAttention since …); inspect with "run get <id>", stop with "run cancel <id>"`. The draft should also state as an intended semantic that `NeedsAttention` blocks the schedule. It is the right default, because uncertain effects should not be re-fired, but it has to be said.

### B3. Pause/resume semantics contradict the expected-generation guard

The draft says pauses "persist across restart and same-ID schedule edits", so pause is operator state on the schedule ID. It also says pause/resume carry an expected generation "to avoid acting on a different edited definition". Those two rules cannot both hold. If a pause survives edits, guarding it on generation only makes pause fail precisely when an operator wants to stop a schedule that was just redeployed. Pausing is the safe direction and should never need an optimistic-concurrency token. It is also unlike the extension precedent, where `expectedRevision` protects a non-idempotent change to installed code.

**Fix (proposal).**

- Drop `expectedGeneration` from pause/resume.
- The idempotency scope is `(scheduleId, requestKey)`, and the fingerprint includes the operation. The same key with the opposite operation returns `Conflict`, as the draft says.
- Pausing an already-paused schedule (with a new key) succeeds with `changed: false`. The same applies to resume. Operators run these from scripts.
- `--request-key` is optional and generated, matching every other mutating CLI command. On uncertain delivery the CLI prints `Retry with --request-key <key>`. The draft shows it as required.
- Pause and resume on a `Removed` schedule are allowed (see B4). That lets an operator pre-pause an ID before re-adding it.

```ts
export const ScheduleReceipt = Schema.Struct({
  scheduleId: Id,
  operation: Schema.Literals(["Pause", "Resume"]),
  paused: Schema.Boolean,
  changed: Schema.Boolean,
  generation: Schema.NullOr(Schema.Int), // generation observed, informational only
  requestKey: Id,
  actor: Schema.String,
  acceptedAt: Schema.String,
});
```

Document on the receipt and in CLI help that pausing does not cancel the in-flight run. Point to `run cancel`.

### B4. Resolve schedule identity, generations and same-ID recreation

Proposal for the open question:

- **Identity is the schedule ID, per repository, permanently.** Removing it from source moves it to `Removed`. History and pause state are kept and listed with `--state removed`.
- **Re-adding the same ID is continuity of identity, not of firing.** It always opens a **new generation**, even with an identical definition. Firing starts at the next future slot, and the removal gap is not missed time and is never caught up. Pause state carries over: if an operator paused the ID, it comes back paused, and `daemon` start logs a line saying so. Operator intent beats surprise firing.
- **Generation** is a per-ID monotonically increasing integer shown to users, with a `definitionDigest` alongside for machines. A digest alone is unreadable in `schedule get`.
- A generation is created when the daemon **activates** the application revision, not when the bundle is built. "First activation starts at the next future slot" is then measured from activation time. State that the slot equal to the activation instant is excluded.
- The draft lists the generation-changing fields. Cosmetic fields that do not change it are `description` only, in v1.

### B5. Skipped-occurrence history must be bounded by construction

"Later slots are recorded skipped for overlap" makes one row per slot. A `*/1 * * * *` schedule blocked by a `NeedsAttention` run over a weekend writes about 3,000 rows. A six-field every-second expression writes 86,400 per day. Swamp avoids this by coalescing (`lastMissed` with `count`, cap and `saturated`).

**Fix (proposal).** An occurrence row exists for each admitted run. Consecutive non-admitted slots with the same reason (`Overlap`, `Paused`, `Downtime`, `Unavailable`) coalesce into one row `{reason, firstSlot, lastSlot, count, countCapped}`. `MissedSummary` on the schedule is the latest such row. Retain at most N occurrence rows per schedule (proposal: 1,000) and say so in `schedule occurrences`.

Separately, decide the **six-field question now**. My recommendation is **five fields only in v1**, with `seconds` fixed at 0, and an error that names the reason. Per-second durable admission is a scheduling-platform feature, not this one. It can be added later without breaking anyone, while removing it later would break people.

### B6. Make startup and liveness observable

Schedules only fire while `daemon serve` is running. Because nothing auto-starts the daemon, a laptop that sleeps or a daemon that is never started counts as "downtime". Consumers will hit this on day one.

**Fix (proposal).**

- Extend `SystemStatus` with `scheduler: { state: "Running" | "Draining" | "Stopped", active: Int, blocked: Int, paused: Int }`.
- Add the capability `"schedule.v1"` to `ServerHello`, so the CLI can say "this daemon does not support schedules" instead of failing generically.
- The README and CLI help must say plainly that schedules fire only while the daemon runs, and that the catch-up policy decides what happens after it was down.
- `schedule list` should succeed even when no schedules are declared, returning an empty page with the active application revision, as `DefinitionPage` does.

## Preferences (non-blocking, recommended)

### P1. Name: keep `WorkflowSchedule.make`; reject the alternatives

- `WorkflowSchedule.make` follows the verified `WorkflowPatch.make` precedent, reads correctly next to `Workflow.make`, and does not shadow `import { Schedule } from "effect"`. Effectory users import that constantly for retries, so a collision in the same file is a real annoyance.
- `Workflow.schedule(...)` hides the feature inside a namespace whose other members are graph builders, and it suggests one schedule per workflow. The draft rightly allows many.
- `Trigger.cron` is a premature umbrella. Add it if webhooks arrive, by aliasing then.

One spelling, no aliases. Agreed with the draft.

### P2. Fewer declarations: auto-register the scheduled workflow

Child workflows are already registered implicitly. Requiring `workflows: [CheckReleases]` and `schedules: [HourlyCheck]` makes the user say the same thing twice, and the failure ("schedule targets an unregistered workflow") teaches nothing. **Proposal:** a schedule's workflow is added to the application exactly like a child workflow, under the same canonical-identity check. The one caveat: if the target is an extension workflow, it must still pass existing extension selection, so the schedule cannot be a back door. Use the same rule child linking follows today, and state which rule that is. If the parent rejects this, the explicit-registration error must name the schedule ID and the missing workflow ID.

Minimal declaration then becomes:

```ts
// Proposed (not typechecked)
const HourlyCheck = WorkflowSchedule.make({
  id: "hourly-release-check",
  workflow: CheckReleases,
  cron: "0 * * * *",
  input: { repository: "Rowenin/example" },
});

export default Application.make({
  tasks: [FetchReleases, PublishReport],
  schedules: [HourlyCheck],
}).provide(Services);
```

Typing proposal:

```ts
export function make<
  const W extends Workflow.Definition,
  const Id extends string,
>(spec: {
  readonly id: Id;
  readonly workflow: W;
  readonly cron: string;
  readonly input: W["spec"]["input"]["Type"];
  readonly timeZone?: string; // default "UTC"
  readonly catchUp?: "skip" | { readonly latestWithin: string }; // default "skip"
  readonly description?: string;
}): Definition<Id, W>;
```

`input` stays **required**, even though the CLI defaults manual input to `{}` (verified, `parseInput`). A scheduled run has no human to notice a wrong default. Making it optional only when `{}` is assignable adds conditional-type cleverness for little gain.

### P3. Defaults are right; make them visible

UTC and `"skip"` are the predictable defaults. Defaulting to the daemon host's zone would make the same source behave differently across machines. Because `0 9 * * *` in UTC surprises people, `schedule get` and `list` should always print the effective `timeZone`, and `nextFireAt` in UTC plus, in human output, the zone-local time with its offset. `latestWithin` uses the existing duration grammar (`"1 hour"`), capped at `"31 days"`, consistent with Swamp's `maxDelay`.

### P4. Cron input: string only in v1

Do not accept Effect `Cron` values in v1. That creates two syntaxes, and a `Cron` value carries its own `tz`, which conflicts with `timeZone`. Its serialization then has to be specified. A string is already deterministic and can be shown verbatim in `schedule get`. Reject the following with errors that name the token and say "not supported in v1": `@nicknames`, `L`, `#`, `W` and `?`, plus six-field expressions (B5). The draft must list these as **explicit gaps against Swamp parity**, alongside live reload, HA fire-claim and per-run tags.

### P5. CLI surface

```
effectory schedule list [--workflow ID] [--state active|blocked|paused|removed] [--limit N] [--cursor T]
effectory schedule get ID
effectory schedule pause ID [--reason TEXT] [--request-key KEY]
effectory schedule resume ID [--request-key KEY]
effectory schedule history ID [--limit N] [--cursor T]
```

- `--state` rather than `--status`. `status` already means run status and has a different value set. The default list excludes `removed`.
- `history` rather than `occurrences`. It is more discoverable and matches what users type. The RPC can stay `ScheduleOccurrences`. Rows join the current run status, so `schedule history` answers "did it succeed?" without a second command.
- An optional `--reason` on pause, mirroring `run cancel --reason`, tells the next operator why.
- `run list --schedule ID`: defer. History with joined status covers the need.
- No `schedule run-now`. Agreed. Document `workflow run <workflowId> --input …` as the manual path in `schedule get` help. A manual run does not take the overlap slot, which the draft already states, so that sentence belongs in help text too.

### P6. Error shape

Invalid schedules fail application activation with `DefinitionError` messages that start with `Schedule <id>:` and name the field (`cron`, `timeZone`, `input.<path>`, `catchUp`). One bad schedule blocks the whole revision, which is consistent with today's all-or-nothing activation. Accept that, but make the message precise. Use the existing `OperationError` codes: `NotFound` (unknown ID), `Conflict` (key reuse), `InvalidInput` (reserved `sched:` key). No new codes are needed.

### P7. Drain and capacity

Fine as drafted. Add one rule: a slot that could not be admitted because of `StorageFull` or `Unavailable` is recorded as `Unavailable` (coalesced, per B5) and retried with the same derived key only within the same slot's eligibility window. Under `skip` that means until the next slot. Under `latestWithin` it means within the window. That keeps the queue bounded.

## Feasibility proofs to require before implementation approval

1. **Type test** (`bun run typecheck`): `input` is checked against `W["spec"]["input"]["Type"]`. A wrong field fails to compile. Adding `schedules` changes neither `Application`'s `R` nor its `E` beyond `DefinitionError`.
2. **Effect Cron grammar test** against 4.0.5: confirm rejection of `@hourly`, `L`, `#`, `?` and `W`, and confirm the documented day-of-month/weekday OR rule. Separately check croner's default for the same rule before claiming parity.
3. **DST test** with `Cron.parse(expr, "America/Chicago")` and `Cron.next`/`Cron.prev` across the 2026-03-08 gap (`30 2 * * *`) and the 2026-11-01 fold (`30 1 * * *`). Record the actual outputs and document them as the contract: one fire or two, skipped or shifted. Do not assume.
4. **Admission idempotency**: crash between run admission and watermark update, restart, and assert exactly one run for that occurrence via the derived key. Then a user `--request-key sched:…` → `InvalidInput`.
5. **TestClock scheduler test** covering skip, `latestWithin` (one catch-up, using `Cron.prev`), overlap with `Waiting` and `NeedsAttention` (state `Blocked`), pause across restart, and remove/re-add (new generation, pause retained, no gap catch-up).
6. **Bounded history**: a blocked every-minute schedule over a simulated 72h produces O(1) coalesced rows.
7. **CLI golden output** for `schedule list` and `get` in human and `--json` modes, including `Blocked` with its next-step hint.

## Summary for the parent

The authoring shape and name are right (`WorkflowSchedule.make`, UTC/skip defaults, app-owned, no run-now). Before presentation, fix the blockers: B1 run principal and reserved request keys plus optional `Run.schedule` provenance; B2 a visible `Blocked` state; B3 drop the expected-generation guard on pause/resume and make the request key optional; B4 the identity, generation and recreation rules; B5 coalesced, bounded missed history and five-field-only cron; B6 scheduler liveness in `SystemStatus` plus the `schedule.v1` capability. The preferences cut the normal declaration to one `WorkflowSchedule.make` plus `schedules: [...]`, and keep v1 honest about where it falls short of Swamp.
