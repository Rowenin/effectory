# Durability, recovery and callback registration

Status: planning pass 4 of 5. These are proposed contracts, not implemented or verified guarantees. This refines [execution](execution.md), [task implementation](task-implementation.md) and [extension composition](extension-composition.md). The persistent Effect engine remains a candidate to prove before building the complete runtime.

## Recommendation and ownership

Use the Effect engine as the execution journal. Keep application admission, authorization, external wait decisions and lake publication in their own stores, with explicit durable handoffs. Sharing a SQLite database does not imply the engine and application automatically share a transaction.

| Record | Authority | Other representations |
| --- | --- | --- |
| Accepted run, original input, revision, request key | Application admission transaction | Engine receives immutable execution identity/input |
| Dispatch, cancellation and continuation intents | Application outbox/control records | Delivered repeatedly until acknowledged/reconciled |
| Task success/failure, branch decisions, fan-out expansion, recorded pure-map values | Effect execution/activity journal | Run/node views and events are projections |
| External approval/input/signal settlement | Application WaitStore, write-once outcome | Engine deferred carries a settlement notification/identity |
| Attempt admission, owner generation, uncertain start | Host attempt guard | Diagnostics; not a second task-result journal |
| Final executed run outcome | Engine outcome | RunStore terminal status/events are idempotent projections |
| Artifact bytes, exact versions and publication keys | Blob store plus catalog transaction | Task result may reference committed artifacts |
| Active revision and installed extension inventory | Versioned registry/activation protocol | New runs pin one effective application revision |

Persist runtime-dependent decisions as named engine activities with stable graph identities. The host must not separately decide that a node succeeded because a log, artifact, HTTP response or projected status appears successful. Attempt guards store dispatch/ownership facts, not replacement success values.

Wait settlement is deliberately application-owned: access checks, deadline races, idempotent receipts and audit identity must commit together. Only its dispatcher may complete the corresponding engine notification. The resumed graph reloads the canonical wait outcome; it does not accept a second independently editable answer.

## Acceptance and durable handoffs

1. Validate the target/input against a retained application revision. In one application transaction, enforce the request key, store the immutable run, retain its revision/artifact references, and write the dispatch intent.
2. Return `RunAccepted` only after commit. Omitted revision selectors remain omitted in request fingerprints; the chosen revision is stored separately.
3. Dispatch with a deterministic engine execution ID derived from repository/run identity. Repeated dispatch must attach to the same execution, not create one.
4. Mark delivery after engine acceptance. Reconcile a crash between engine acceptance and that acknowledgement using the same execution identity.
5. Project engine progress/outcomes using stable transition identities. Commit a projection update and its numbered event in one transaction, then notify watchers. Duplicate reconciliation must not append another copy of the same transition.

Cancellation also commits an intent before interrupt delivery. `Cancelling` means requested, not a final outcome. The engine arbitrates completion versus delivered cancellation; an in-flight completion can win. The host cannot overwrite a terminal engine success merely because its projection arrived after a cancellation request. An accepted but undispatched cancelled run still goes through the engine control path, with task admission blocked, so it has one authoritative terminal outcome.

Wait creation atomically stores its exact receiver ID, node identity, pinned codec, deadline and initial state before exposing the address. Settlement atomically stores the outcome, authenticated actor, idempotency receipt and continuation intent. A delivery, timeout and cancellation use the same conditional settlement; exactly one can win. Replay never overwrites that winner.

These protocols are at-least-once delivery with deduplicated application actions. Do not promise one transaction spanning arbitrary engine calls, filesystem rename and SQLite writes. Outbox/reconciliation closes those gaps explicitly.

## Attempt admission, fencing and uncertain outcomes

Before invoking task code, atomically acquire its attempt guard with execution, node, attempt and owner-generation identity. A stale owner cannot renew the guard, publish data, settle host state or dispatch further work. The single-repository daemon lock prevents ordinary competing hosts; generation checks still matter for old worker processes and late responses after interruption/restart.

The adapter must prove that engine result acceptance respects the same ownership boundary. Checking a fence immediately before returning a value is insufficient if ownership can change before the engine commits it. Use the engine's durable ownership mechanism or a correctly integrated adapter, not an unprotected final check. Host fencing cannot undo or prevent every external API request already sent.

If an attempt was admitted but no completed engine result exists, recovery does not know whether its external effect happened. Consult the engine before deciding; a completed result may exist while the host projection is stale.

- `idempotent`: re-enter only under a new valid attempt after confirming the provider's deduplication/result-recovery contract covers the recovery horizon. Reuse invocation-scoped `context.key(name)` values, never attempt IDs.
- `manual`: hold the invocation in `NeedsAttention`; do not re-enter its handler. A crash before the external call may therefore require attention too. This is the necessary conservative choice when the host cannot distinguish the cases.
- Automatic `reconcile` handlers remain deferred. A string declaration alone cannot establish how external state is inspected or converted into a result.

The attempt guard refuses unsafe entry; the interpreter suspends on that recorded attention condition instead of committing a fabricated task result. Its projected NeedsAttention state must agree with this engine suspension, not run a parallel host scheduler that independently decides which graph nodes succeeded.

The pinned [Activity implementation](../vendor/effect/packages/effect/src/workflow/Activity.ts) memoizes completed outcomes, warns that suspended bodies may rerun, and wraps handlers with interruption retries by default. That default is not our recovery policy. The integration spike must explicitly configure/intercept interruption retry and apply the attempt guard before every entry. A manual task must never silently execute twice because an upstream retry wrapper restarted its body.

## Separate external signal registration from waiting

Preserve `graph.waitForSignal` for cases where the producer can discover an open wait. Add a proposed two-stage form for workflows that themselves trigger an external job:

```ts
const completion =
  yield *
  graph.registerSignal("deployment-completed", {
    schema: DeploymentCompletion,
    timeout: "2 hours",
  });

const started =
  yield *
  graph.task("start-deployment", StartDeployment, {
    revision: Ref.field(input, "revision"),
    completion: completion.address,
  });

const event =
  yield *
  graph.awaitSignal("await-completion", completion, {
    after: [started],
  });

return yield * graph.task("record-result", RecordDeployment, event);
```

This belongs inside the construction Effect; task/schema names are illustrative. `registerSignal` returns a construction Effect yielding an opaque schema-typed handle. Its `address` is `Ref<SignalAddress>`, resolved only after the receiver is durably open. The registration node does not wait for a payload. `awaitSignal` declares the separate node whose result is the decoded payload.

Passing `completion.address` into StartDeployment creates the ordering edge: registration commits before the trigger handler can execute. A callback may then settle the receiver while StartDeployment is still running. Awaiting later reads that same stored outcome. `after: [started]` ensures an early event alone cannot make the workflow claim that the trigger task completed successfully.

Before dispatch, the host validates the address against the declared registration, run/scope and receiver generation/state under the invocation's admission fence. An arbitrary JSON object with a matching shape is not a graph registration handle. The receiver belongs to the logical invocation, so valid task retries reuse it; an obsolete worker cannot create a new receiver or renew its deadline. An already-accepted signal does not prevent safe recovery of its trigger task; timeout/cancellation does prevent new work through the normal admission guard.

The address contains receiver/run identity, not a secret or a universal webhook URL. StartDeployment's configured adapter conveys that correlation to its provider. The ingress adapter verifies provider authentication/signatures and authorized correlation before calling `WaitSignal`; an event's shape or wait ID alone proves neither authenticity nor ownership. This does not add a public unauthenticated callback server to v0; the local CLI/RPC adapter can exercise the same contract.

Registration and waiting have the following lifecycle:

- The timeout begins when registration opens, including trigger queueing/retries. Restart and entering `awaitSignal` do not reset it. Expiry is a control outcome even if the await node is not yet eligible; the run stops admitting dependent work and interrupts active work under normal finalization rules.
- Each registration has exactly one await consumer in the same activated scope. Missing consumers, scope escape and dependency cycles fail graph validation. Fan-out gives every captured item key its own receiver identity.
- Retry/replay recovers the original receiver and deadline by logical node identity. A new run or explicit new generation gets a different receiver. No named broadcast, pre-registration buffering or guessed ID is introduced.
- If the trigger fails terminally, unhandled failure closes the run's open waits. A callback already committed remains an immutable historical receipt; it does not turn the failed trigger into success. An uncertain trigger follows manual or idempotent recovery; a completion event is not automatic reconciliation.
- While a run is held in NeedsAttention, unexpired receivers may still accept authorized evidence, but continuation stays held. Cancellation closes remaining open receivers. Late signals cannot reopen a closed run or wait.

`graph.waitForSignal(id, options)` can compile to the same registration/await pair without exposing an address. Its existing payload result and timeout semantics remain unchanged. This is a proposed extension, not a typechecked API.

## Deadlines, publication and finalization

Persist absolute deadlines and selected retry wake-up times. A timer is a prompt to inspect state, not proof that it alone won settlement. Enforce wait expiry in the answering transaction as well as in the timer sweep. Use the deadline starts defined in [graph policies](graph-composition.md#execution-policies); ancestor deadlines bound children and never reset on replay.

The pinned [DurableClock](../vendor/effect/packages/effect/src/workflow/DurableClock.ts) defaults short waits to an in-memory Activity path. Select persistent scheduling for positive durable delays and prove restart behavior; a sleeping fiber does not meet the promise. Zero delay can be an immediate completed control node.

Artifact publication follows blob-first/catalog-second commit. Its stable key is invocation + output name + explicit caller key, as proposed in [task publication](task-implementation.md#identity-retries-and-publication). Identical content/metadata returns the original version; changed data conflicts. An artifact committed before task completion stays visible with producer state, even if the task later fails. It is not evidence of successful task completion.

Preserve domain failures, host execution failures, defects, cancellation and wait control outcomes as distinct encoded categories. Rejected/TimedOut ends admission and closes sibling waits, then interrupts/finalizes remaining work. Publish the terminal projection only after the engine settles its final outcome. Uncertain effects may require NeedsAttention instead of claiming clean completion.

Daemon drain stops new admissions, persists its intent and allows bounded cleanup. It does not cancel durable runs by default. Recover interrupted attempts after restart using their replay contracts. Subprocesses require process-group cleanup; in-process blocking code cannot be made cooperatively interruptible by an Effect type. A supported executor must define and prove its termination/fencing behavior.

## Minimum operator recovery

V0 `RunGet`/`SystemDoctor` should expose the blocked node, attempt, pinned revision, uncertainty reason and safe diagnostic references. Retain available publication and external-operation key metadata without leaking secrets.

The safe initial manual action is explicit cancellation/abandonment after the operator investigates. `RunCancel` closes admission and waits for local owners to quiesce; its final record retains `unresolvedEffects` evidence. Cancelled means Effectory will perform no more work, not that external effects were rolled back or determined absent. If local ownership cannot be safely fenced/quiesced, keep NeedsAttention rather than falsely reporting completed cancellation.

Do not initially expose generic `resume`, "mark succeeded", arbitrary result injection or "retry anyway" RPCs. Reconciliation that supplies a verified result or authorizes retry needs a separate audited protocol. A new run has new keys and may repeat external actions; it is not a recovery shortcut for an uncertain run.

## Revision activation and restart

Retain source bundle, codecs, non-secret config snapshot, provider/contract digests, extension selections, patch bindings and effective graph identity before accepting runs against a revision. Missing retained code is a blocked recovery error, never permission to execute today's implementation. Secret references remain pinned; credential rotation must not silently change account/tenant identity.

Installed inventory and active application are distinct revisions. An update to a selected package builds a candidate against both expected revisions. Serialize activation with source reload and compare both before swapping the active pointer. For selected updates, validate before committing the candidate lock/inventory; an interrupted filesystem/database activation uses the durable activation intent to finish or restore a consistent pair. Failure leaves the prior active revision available. An unselected install need not change application behavior.

On startup: acquire exclusive ownership, migrate storage, validate retained revisions, reconcile activation, reconcile engine/attempt ownership, replay outbox deliveries, inspect elapsed deadlines and cancellation intents, and repair status projections. Advertise readiness only when these admission invariants hold. A single blocked run may remain NeedsAttention without blocking unrelated valid runs.

## Crash/recovery matrix

| Crash point | Required recovery |
| --- | --- |
| Before acceptance commit | No accepted run; retry can create it |
| After acceptance, before dispatch | Outbox dispatches the original run/revision |
| After engine accepts, before outbox acknowledgement | Same execution ID attaches to existing execution |
| After attempt admission, before known result | Consult engine; replay only if contract permits, otherwise NeedsAttention |
| After external success, before engine completion | Stable provider key recovers result or operator attention; never invent success |
| After artifact commit, before task completion | Same publication key recovers exact version; task still requires its own outcome |
| After receiver registration, before trigger | Recover same address/deadline; trigger remains eligible subject to expiry |
| Callback arrives before trigger task completes | Retain outcome; await waits for trigger dependency |
| After wait settlement, before engine wake | Continuation outbox/reconciliation delivers the stored outcome |
| After engine terminal result, before projected event | Reconcile one terminal projection/event with stable transition identity |
| During selected extension activation | Reconcile candidate intent; old runs retain old effective revision |
| Old worker responds after ownership changes | Fence host writes and engine completion; external effect remains separately uncertain |

## Engine proof and remaining choices

The pinned [WorkflowEngine contract](../vendor/effect/packages/effect/src/workflow/WorkflowEngine.ts) provides execute, resume, interrupt, activity and durable-deferred operations. [ClusterWorkflowEngine](../vendor/effect/packages/effect/src/cluster/ClusterWorkflowEngine.ts) backs these with cluster messages; [SingleRunner](../vendor/effect/packages/effect/src/cluster/SingleRunner.ts) is the candidate local host. Their presence is not proof of this integrated design.

The first engine spike must prove stable dispatch IDs, interrupted manual-task admission, durable result lookup before recovery decisions, stale-owner rejection, write-once wait delivery, deadlines after restart, and idempotent projections. Kill the process at every matrix boundary. Verify callback-before-trigger-return, trigger failure after an accepted callback, and timeout/cancel/delivery races. If the engine cannot support an invariant, document that specific adapter gap before considering a custom engine or weakening the public contract.

The main tradeoffs are application-owned external wait decisions with durable handoffs, explicit registration/await for callbacks, and conservative manual recovery rather than unverified result injection. The largest engine risk is integrating admission/fencing and interruption retries without creating a second execution journal. No runtime or crash behavior was tested in this pass.
