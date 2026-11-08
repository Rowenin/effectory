# Manual recovery — reviewed proposal

Status: user-approved on 2026-11-06; implemented and verified. Incorporates consumer round 2 and Effect round 2, including the exact continuation-obligation rule. See [current usage](manual-recovery.md) and [implementation evidence](manual-recovery-implementation.md).

## Outcome and scope

An operator inspects a held run, acknowledges the possibility of repeating external actions, and authorizes one additional entry of every currently recorded uncertain manual attempt. The daemon resumes those tasks and siblings suspended by the hold. Native completed activities, input, revision, settled waits and publication identities are retained. A receipt means permission was accepted, not that the workflow succeeded or that the earlier external action failed.

This covers direct task runs, workflow tasks including fan-out, patches and children, and manual reporter runs. Ordinary approval/input/signal waits use their existing commands. A stopped run with unfinished finalizers cannot be recovered. No synthetic success, abandoned-invocation outcome, engine-journal edit, or new author hook is added.

All-current-holds is the proposed v1 scope. Selection can support staged operator work, as the parent's native fan-out probe demonstrated, but would also need explicit behavior for continued progress while other holds remain. This slice does not add that behavior. All-current-holds still cannot safely recover a non-reconciling task whose action must not repeat: the operator must decline authorization and may cancel the run. Neither scope solves that case by itself.

## Operator interface

One command is read-only by default:

```sh
# Assessment; JSON goes to stdout under existing CLI conventions.
effectory run recover run-123 --json

# Authorize exactly the set described by that assessment token.
effectory run recover run-123 --authorize rcv1.OPAQUE --acknowledge-reexecution \
  --request-key recovery-incident-42 --reason 'Provider records checked'

# Acceptance does not wait for completion.
effectory run watch run-123
```

Assessment flags: `--cursor`, `--limit` (default 50, maximum 200). Mutation flags: `--authorize`, required `--acknowledge-reexecution`, optional `--request-key` and `--reason`. Combining paging flags with mutation is InvalidInput. An acknowledgment or mutation-only option without `--authorize` is InvalidInput, not a silent read. There is no additional `--watch` flag in this slice.

Assessment exits 0 when successfully inspected, including when recovery is unavailable; scripts inspect `state`. Mutation exits 0 for Accepted. Errors reuse the existing CLI mapping: InvalidInput exits 2; Unavailable and transport failure exit 3; every other OperationError code, including Conflict, RevisionUnavailable, NotFound, CursorExpired and LimitExceeded, exits 5. Scripts distinguish refusals by reassessing and reading `state`, not by exit code or parsing messages. Reading or mutating another principal's run returns NotFound. No new OperationError fields or codes.

The CLI checks `run.recovery.v1` before either RPC. A new CLI connected to an older running daemon fails Unavailable before mutation. Guidance says to use the compatible daemon build and inspect the run; it must not promise that an arbitrary upgrade can load a pinned revision. On transport or other non-OperationError failure after sending the mutation, print a shell-safe retry command containing the token, acknowledgment and request key, with a separate instruction to repeat the same reason. Never interpolate arbitrary reason text into that command. A returned OperationError is a refusal, not uncertain delivery. A retry uses the same token, acknowledgment and reason.

Human assessment displays the total number of uncertain entries, whether the page is incomplete, fixed deadlines, the fresh timeout policy, and this consequence: **All entries in this assessment are authorized together, including entries on other pages. External actions may repeat. Existing publications do not prove success.** The command never selects the newest run implicitly.

Also state: this assessment lists uncertainty recorded so far. Leaves still restarting may add entries later; they are never covered by an earlier token. Reassess when the run returns to NeedsAttention. Show the effective timeout rule, `min(entryStart + attemptTimeout, absoluteDeadline)`, so an operator can see when an absolute deadline leaves little time.

Plain `run watch` stays attached through a re-hold. Its human NeedsAttention line shows invocation, attempt and entry, plus a `run recover <id>` hint. Existing foreground commands still exit at NeedsAttention; their exit-4 guidance adds the assessment command when `run.recovery.v1` is advertised. Ordinary approval/input/signal waits remain distinct from recovery.

## Public RPC shapes

The following are proposed wire types, not implemented SDK declarations or typechecked examples. Implementation uses Effect Schema at each boundary. Timestamp means canonical ISO instant; IDs/tokens/cursors have explicit byte/length bounds below. `RunStatus` is the existing schema. No unbounded invocation path is required in a command.

```ts
type RecoveryState =
  | "Recoverable"
  | "NotHeld"
  | "Pending"
  | "Stopping"
  | "Terminal"
  | "FinalizationStalled"
  | "ExecutionActive"
  | "RevisionUnavailable"
  | "DeadlineElapsed"
  | "AuthorizationLimit";

type RecoveryEntry = {
  invocationId: string; // existing opaque report invocation ID
  pathPreview: string; // at most 2,048 code points
  pathTruncated: boolean;
  taskId: string;
  taskVersion: number;
  attempt: number; // declared retry attempt, unchanged by recovery
  entry: number; // entry whose native result is unknown
  priorAuthorizations: number;
  firstStartedAt: string;
  lastEnteredAt: string;
  observedAt: string;
  attemptTimeoutMillis: number | null;
  absoluteDeadline: string | null; // minimum known run/ancestor deadline
  publicationCount: number; // evidence only; use run outputs for references
};

type RecoveryAssessment = {
  runId: string;
  revision: string;
  status: RunStatus;
  state: RecoveryState;
  reason: string;
  token: string | null;
  total: number; // whole unresolved uncertain set, not this page
  entries: readonly RecoveryEntry[];
  nextCursor: string | null;
  latestAuthorization: null | {
    authorizationId: string;
    requestKey: string;
    actor: string;
    acceptedAt: string;
    authorized: number;
    pendingEntries: number;
    consumedEntries: number;
    supersededEntries: number;
    continuationPending: boolean;
  };
};

type RecoveryAssessmentRequest = {
  runId: string;
  cursor?: string;
  limit?: number;
};

type RecoveryRequest = {
  runId: string;
  token: string;
  acknowledgeReexecution: true;
  requestKey: string;
  reason?: string;
};

type RecoveryReceipt = {
  runId: string;
  authorizationId: string;
  requestKey: string;
  actor: string;
  acceptedAt: string;
  reason: string | null;
  authorized: number;
  outcome: "Accepted";
};
```

`RunRecoveryGet`: request RecoveryAssessmentRequest, success RecoveryAssessment, error existing OperationError. `RunRecover`: request RecoveryRequest, success RecoveryReceipt, error existing OperationError. No change to Run or RunSummary is required. `latestAuthorization` is inspection, not a mutable receipt; a consumed entry that subsequently becomes uncertain appears in `entries` again.

Bounds: runId/requestKey/token maximum 200 characters; cursor maximum 2,000; reason maximum 8,192; nonnegative counts and positive safe integers for attempt/entry/version; at most 10,000 invocation records per existing run limit. IDs and tokens never contain the full node path. Recovery-specific generated messages are bounded and include an assessment command. The token hashes the sorted **whole** unresolved set and a durable generation, not a page or last event sequence. Log writes do not stale it. New uncertainty, authorization or a changed terminal/fence condition makes it unusable. Cursors bind the set generation; changed membership returns CursorExpired, rather than mixing pages. All pages of an unchanged set share one token. A token is not a credential and never bypasses principal checks.

State precedence: terminal, stop/finalization, unavailable pinned revision, elapsed absolute deadline, live target entry, authorization limits, pending recovery, recoverable uncertainty, otherwise NotHeld. Stop/finalization distinguishes a stopped run still cleaning up from an ordinary cancellation in progress. No token is issued unless Recoverable. Inspection can still show entries when refused. A pending generation must be delivered before accepting another generation; newly discovered holds remain visible in the meantime.

## Admission and status invariants

Uncertainty is durable per `(run, invocation, activityAttempt, entry)`. The run is held when an uncertainty row exists with no accepted authorization. A generic suspension because another entry is held is not itself proof that this task is uncertain. Run status is a projection of these rows and stop state, not the authorization source.

Admission, in one host write transaction:

1. Check lease, terminal state, Cancelling and stop fence. A fence wins, including after authorization was accepted.
2. Check absolute run/ancestor deadlines. An elapsed absolute deadline follows the stop path and returns TimedOut.
3. Inspect the prior entry **before** the run-wide hold gate. For manual replay, atomically consume an unused authorization matching that prior entry and admit with a fresh window, or record uncertainty and suspend. Do not check the old attempt window on this path. Recording the same refused generation again is idempotent. An authorized entry may proceed even if an unrelated newly discovered hold exists.
4. For a prior idempotent entry, an expired preserved attempt window fences the run and returns TimedOut, as today.
5. Hold gate: suspend new admissions while unresolved uncertainty remains, recording the sequenced gate row specified below.
6. Otherwise admit: a first entry gets a new window and idempotent replay keeps its existing window. Capture the incremented entry and lease fence.

Every admission clears the previous gate row for that `(run, invocation, activityAttempt)` in the same transaction, whatever the outcome; a newly gated result writes a new sequence. This includes early terminal, cancelled and timed-out outcomes.

Admission and the in-memory per-entry reservation increment run in one synchronous SQLite transaction callback, atomic with recovery's live-entry check on the daemon's JS thread. This is the acquire of `Effect.acquireRelease`; release decrements only for an Admitted result. Its surrounding `Effect.scoped` encloses the handler, task Layer, Vault tracker and logger scope. The acquire is uninterruptible, so interruption cannot land between commit and finalizer registration. No reservation is taken for a refused admission. This ownership lasts through Layer and owned I/O cleanup, not merely until the handler returns. Arbitrary author fibers detached with `forkDetach` escape structured Scope ownership; this mechanism does not prove external work in those fibers has stopped.

The first entry of a declared attempt needs ordinary admission only. A known domain-error retry creates a new attempt, uses the normal retry budget and does not require recovery. Every subsequent entry of an uncertain manual attempt needs its own consumed authorization. Idempotent tasks keep their existing replay policy.

The attempt number, attemptId, ctx.key and publication identities do not change. The proposed timeout rule gives an **authorized manual re-entry** a fresh attempt-timeout window starting at admission. Preserve the original first-start timestamp for inspection. Absolute run/ancestor deadlines never reset and cap this window. An expired prior entry timeout must not fence the run before its manual uncertainty is recorded; otherwise the fresh-window choice is impossible. This change does not grant a fresh window to ordinary idempotent replay. Existing timeout/cancel fences are never cleared.

Persist `windowStartedAt`: now for a first entry or authorized manual re-entry, unchanged for idempotent replay. Both admission and the in-handler timeout read this value. `firstStartedAt` remains the original start for inspection. Updating only admission while the handler still reads the original timestamp would immediately time out the recovered task.

Status remains NeedsAttention while unresolved uncertainty exists. A wait settlement or stale runner poll cannot overwrite it with Running/Waiting. The authorization acceptance transaction re-projects status: Running if no unauthorized uncertainty or finalization stall remains, otherwise NeedsAttention. The engine may subsequently project Waiting; a new hold projects NeedsAttention again. This does not mean the handler has started. An actual root failure/cancel/deadline still follows normal termination; holds cannot override terminal state.

Already-running siblings may finish and publish during an uncertainty hold. Their original invocation lifetime, captured entry, lease and absence of a stop fence remain required. Closed or superseded entries cannot publish merely because their lease is current. Reader operations need the same hold-safe admission analysis. New sibling admissions obey the hold gate; no sibling is cancelled solely to make recovery possible.

## Authorization, continuation and crash recovery

Principal check comes first, then receipt lookup by `(runId, actor, requestKey)` before current-state checks. Identical payloads return the stored receipt, even after completion. An absent reason is stored as null; otherwise reasons are compared byte for byte without trimming, as in cancellation. A changed token or reason under an accepted key returns Conflict. Acknowledgment is always the literal true. The receipt is immutable. Refused requests write no receipt and reserve no key; that key can be used with a new token later.

In one host transaction, recompute the set and state, verify the token, require each target's previous live entry/finalizer to be gone, and write authorizations, receipt, event and durable continuation intent together. No author code or native engine call runs inside that transaction. No stale request can authorize a later entry.

| Mutation condition | OperationError code |
| --- | --- |
| Changed set/generation, already authorized or resolved token | Conflict; name the change and accepted authorization when available |
| NotHeld, Pending, Stopping, FinalizationStalled, Terminal, ExecutionActive, DeadlineElapsed | Conflict |
| Unavailable pinned revision in a running host | RevisionUnavailable |
| Per-attempt or per-run authorization limit | LimitExceeded |
| Malformed input, missing acknowledgment, incompatible CLI flags | InvalidInput |
| Missing run or principal mismatch | NotFound |

Capability refusal is Unavailable. Expired inspection cursors return CursorExpired. These errors do not change the existing CLI mapping.

Use a **separate durable recovery-intent table**, not a new value in legacy `host_outbox.kind`. The existing runner loop drives this table; this is not a new scheduler. Store pending consumption independently of whether a resume call was issued. Startup re-derives unfinished delivery from durable generation/entry state.

Continuation is driven by durable obligations, not a scan's observation that leaves are or are not Suspended:

1. Give admission a monotonic host sequence. Gated admission upserts `(run, invocation, activityAttempt) -> gatedSeq`. Every later admission of that key clears the gate row in its transaction, whatever its outcome. Re-gating writes a newer sequence.
2. A generation records `acceptedSeq` at acceptance. Its obligations are its authorized entries and uncleared gate rows with `gatedSeq < acceptedSeq`. An authorization closes on consumption or supersession. A gate closes on any later admission, not only successful admission. Re-gating under a new hold gets a higher sequence and belongs to the next generation, so it cannot keep the older generation pending forever.
3. Each runner pass pages through open obligations and polls their leaves: resume Suspended; close Complete as superseded without replacing its result; retain None and retry on a later pass. A stop or terminal root supersedes every obligation. A generation is delivered exactly when no obligations remain; `continuationPending` means open obligations exist.
4. Membership and completion never depend on an arbitrary leaf polling Suspended. A leaf sleeping in ordinary retry backoff is not an obligation unless it actually recorded a gate/uncertainty; it cannot delay another recovery just by staying suspended. A gate committed before the native Suspended result remains an obligation until later admission, covering the resume-before-suspension race.
5. Native resume calls can retry indefinitely, so never await them inline in the shared runner tick. Fork them into the runner Scope, deduplicated per invocation, like existing interruption delivery. Failure leaves the obligation open for retry; shutdown owns those fibers. Bound each pass's work so one recovery cannot stall cancellation or reconciliation for other runs.

The root is not blindly resumed as a substitute for these obligations. Completed native tasks are never restarted. Late-discovered uncertainty receives no older permission and is assessed in a later generation once the older obligations close.

No custom result journal is introduced. Native Activity results determine replay; a completed cached handler never enters the admission body again. If a leaf completes natively, reconcile both authorized candidates and unauthorized uncertainty rows as superseded without deleting or replacing its result. An obsolete unauthorized row must not keep a run held forever.

| Crash or race | Required result |
| --- | --- |
| Before authorization commits | No permission or receipt exists. |
| After commit, before/during continuation | Intent survives; resume and admission are retried. |
| After consumption, before action/result | Next uncertain entry requires a new assessment and authorization. |
| After native result, before host projection | Replay uses the saved result; no repeated handler. |
| Cancel/deadline after acceptance, before admission | Host fence/deadline wins; receipt still says Accepted. |
| Duplicate explicit or automatic wake | Admission cannot consume one permission twice. |
| A new hold appears during delivery | It receives no permission from the older token; it remains visible. |

Engine interrupt alone is not a cancellation fence: the review demonstrated a resume winning that race. Recovery never interrupts a leaf to manufacture quiescence. Track live target entries internally; unrelated long-running siblings do not block authorization. Scope cleanup must finish before the live target count reaches zero, including reader/publication cleanup and task-local Layers.

## Events, limits and operator consequences

Keep existing event names where possible: NeedsAttention adds attempt/entry information; AttemptStarted adds entry; new RecoveryAuthorized carries authorizationId, actor and authorized count. Event keys include entry/generation so a second hold after another crash is observable. Do not expose an unbounded list of all paths in the event or receipt. No ctx.entry field is added.

Preserve AttemptStarted.startedAt as the first start of the declared attempt for compatibility; its deadline is the current entry's effective deadline from `windowStartedAt`, capped by the absolute deadline. Use entry to distinguish re-entries. This follows the consumer review's field-compatibility correction while using the Effect review's fresh persisted window for actual timers; consumers must use deadline rather than reconstructing it from the first-start field.

Approved limits: 16 additional authorized entries per manual attempt and 64 accepted recovery generations per run. Retain those receipts for the run's lifetime; no eviction makes an old key become a new permission. Failed requests consume no quota. Exhaustion refuses further recovery, leaves the hold visible and preserves the separate cancel path. These limits do not promise every arbitrary repeated-crash run remains recoverable forever.

If any current entry reaches its 16-authorization limit, all-current-holds scope refuses authorization for the whole set, including other fresh entries. Cancellation on a compatible host is the remaining disposition. The 64-generation run limit has the same consequence.

Recovering report runs may temporarily exceed the ordinary active report admission count because held reports were excluded; the existing four execution permits still bound executing reporters. Recovery must not strand an existing report behind fresh admissions. Same-run reader pins, pending-report source protection and schedule overlap remain attached to the original run. Queries and vault reads execute afresh; previously acquired pins persist until terminal. Reacquire task-local Layers and the per-entry vault tracker. Report obligations are not fabricated again.

Re-publishing identical content under the original key returns the existing receipt. Different content stays PublicationConflict. The handler should reconcile the provider's existing resource using its stable key and return the original typed result. Changing a publication key is not a way to undo or conceal a duplicate external action. No new reconciliation hook is necessary for this slice. Author examples use yielded ArtifactStorage, not a new context helper.

## Compatibility and evidence limits

No arbitrary cross-host-build recovery promise: an older or newer host refuses to start while revisions with a different ABI are retained. The ABI hashes every source file in core, runtime and platform-bun; the catalog is built before the runner and RPC server. Recovery and cancellation are both unavailable through that incompatible daemon until the compatible host is restored. A held scheduled run continues to block its schedule. An already-running compatible host unable to resolve an individual revision can return RevisionUnavailable; that differs from startup refusal where no RPC is available. Recovery uses the source's pinned revision and compatible host build. Deploying different application code on that same host does not change the code of the held run. Introducing recovery does not automatically migrate old held runs across the host ABI change.

The Effect review's B9 needs qualification. `runner.dispatch` would fall through on an unknown kind if given one, but `HostStore.outbox` decodes the existing strict Outbox enum before dispatch. Keeping recovery intents outside that outbox avoids depending on either behavior. Source inspection establishes the ABI startup refusal described above; retain a real older-binary proof with a pending intent as an implementation gate. Preserve durable pending state for returning to the compatible host. Do not remove retained revisions or edit manifests to bypass this boundary.

Installed Effect evidence: [parent engine probes](manual-recovery-engine-evidence.md), [uncertain-action probe](manual-recovery-uncertainty-evidence.md), and the Effect review's kill/restart probes. These establish native continuation and the need for a host gate, not a working Effectory recovery implementation. The consumer's in-memory evidence is narrower. Review recommendations are not user approval.

## Required proofs before completion

1. Real interpreter, SQLite and process kills: first uncertainty, repeated restart without permission, authorized continuation, another kill after consumption, and every crash point in the table. Assert per attempt `handlerEntries <= 1 + consumedAuthorizations` for manual replay.
2. Two uncertain leaves are both recorded despite the run hold; delayed discovery stales an assessment. A hold discovered after acceptance gets no old permission; once the earlier obligations close, it gets a new assessment token. Recover all known leaves, gate-suspended siblings, child/fan-out/patch tasks and settled waits without repeating successful activities.
3. Durable obligations handle a committed gate row whose native Suspended result is saved after the first continuation pass, multiple pages, partial delivery and restart. Re-gating under a newer hold closes the older obligation. A leaf in retry backoff cannot delay delivery or have its completed handler repeated. Native resume retry does not stall the shared runner tick. A root-only resume is not accepted as this proof.
4. Lost-response replay, identical receipt after terminal, different payload conflict, two racing operators, principal-first protection and token/cursor generation checks. A refused key can be reused with a new token; an accepted one cannot. One entry at its authorization limit blocks the whole set, but compatible-host cancellation still reaches terminal.
5. Fresh attempt timeout with fixed ancestor/run deadlines; expired absolute deadline, existing fence and cancel/consume races. Known domain-error retry/backoff is not assessed as uncertainty.
6. Slow target finalizer prevents recovery; a live sibling does not. Held sibling publishes and reads successfully; stale/closed entries fail. Wait settlement and runner snapshots cannot clear holds. Re-hold produces a new event. Acceptance atomically re-projects status and permits previously withheld Settle delivery. Native completion also supersedes unauthorized holds.
7. Manual reporter recovery with saturated report admission, retention pins/source protection, Vault and Layer acquisition/finalization, schedule blocking and publication dedup/conflict. A fifth active report record can exist while execution never exceeds four reporter permits.
8. Source-pinned code after an application deployment; missing revision refusal within a running compatible host. Real old daemon capability refusal. Real incompatible-host startup with pending recovery refuses before RPC/runner startup, retaining intents without consuming permissions or dispatching work; restarting the compatible host permits cancellation or recovery. Do not expect an RPC refusal or successful cancellation from a daemon that never starts.
9. Bounded 10,000-invocation assessment/continuation, bounded event/receipt sizes and ordinary runner responsiveness. More entries than one page share a token, and authorization from page 1 covers the total. CLI golden output covers incomplete-page/all-pages warnings, all refusal exit mappings, capability refusal, mutation/paging conflicts, watch hints, and reason strings with quotes/newlines/shell metacharacters that never become executable retry-command text.
10. Repository verification: `bun run typecheck && bun run check && bun test`. Current execution results are tracked in the implementation evidence document.

## Decisions for user approval

The recommended package is: all-current-holds authorization; fresh attempt window with fixed absolute deadlines; read-only default command plus explicit acknowledgment; Accepted-only receipt and separate watch; same attempt identities and retry budget; limits 16/64; hold-safe siblings; report recovery with bounded execution; compatible-host recovery without automatic ABI migration. Selection, abandoned outcomes, result injection and a new author context field are not included. The user approved this package before implementation.
