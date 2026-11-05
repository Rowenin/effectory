# Background and durable execution

The [durability and recovery planning pass](durability-and-recovery.md) refines source-of-truth ownership, attempt fencing, uncertain outcomes and callback registration. Its engine integration remains a proof obligation, especially upstream Activity interruption retries and stale-owner result acceptance.

## Engine choice

Adapt Effect's [Workflow](../vendor/effect/packages/effect/src/workflow/Workflow.ts), [Activity](../vendor/effect/packages/effect/src/workflow/Activity.ts), [DurableDeferred](../vendor/effect/packages/effect/src/workflow/DurableDeferred.ts) and [DurableClock](../vendor/effect/packages/effect/src/workflow/DurableClock.ts). The candidate persistent backend is [ClusterWorkflowEngine](../vendor/effect/packages/effect/src/cluster/ClusterWorkflowEngine.ts) with [SingleRunner](../vendor/effect/packages/effect/src/cluster/SingleRunner.ts) and SQLite. SingleRunner requires SQL and Crypto services even with memory runner storage. `WorkflowEngine.layerMemory` is for tests/ephemeral use, not the daemon's crash recovery guarantee. Prove this assembly in the first runtime spike.

Domain RunStore records submission and observable status; the Effect engine owns activity results and execution state. Avoid two competing workflow journals. Submit writes a run plus an outbox item transactionally; a dispatcher starts an engine workflow using the run ID as its idempotency identity. After engine acceptance it marks the outbox item delivered. A crash between these operations retries the same engine ID. A reconciler projects engine outcomes into RunStore idempotently, including after a crash before the final status/event update.

Standalone tasks run as one-activity workflows, so they receive the same durable submission, watching, retry and cancellation semantics. Every graph node uses a stable activity identity including workflow revision, step ID and fan-out item key. Spec versions, resolved inputs, configuration and extension digests are pinned at submission. Resume does not reread changed source definitions.

## States

| State | Allowed progression |
| --- | --- |
| Queued | Running, Cancelled |
| Running | Waiting, Retrying, Succeeded, Failed, Rejected, TimedOut, Cancelling, NeedsAttention |
| Waiting | Running after a recorded decision/timer; Rejected, TimedOut, Cancelling |
| Retrying | Running when the persisted retry time arrives; Cancelling |
| Cancelling | Cancelled after children/finalizers settle; NeedsAttention on uncertain effects |
| NeedsAttention | Operator reconciliation then resume or cancel |
| Succeeded / Failed / Rejected / TimedOut / Cancelled | Terminal; a new attempt uses an explicit new run |

Rejected and TimedOut come from the [interaction proposal](pausing-and-input.md), and remain proposed control outcomes outside the task/workflow domain error schema. An unhandled wait rejection/expiry closes sibling waits and interrupts remaining work. Publish the terminal outcome after bounded finalization; uncertain external effects may require NeedsAttention. Independent branches can run while a wait is open, so an open wait alone does not imply the whole run is Waiting.

A run failing transiently does not become terminal until its retry policy is exhausted. Preserve task-domain errors separately from infrastructure faults, defects and interruption. Use compare-and-set state transitions so cancellation and completion cannot both become the final outcome.

## Durability is not exactly-once external execution

Completed activity outcomes can be replayed. A crash after an external side effect but before recording success can execute it again. Tasks must declare `idempotent`, `reconcile`, or `manual` replay behavior. Idempotent tasks propagate stable keys to external systems; reconcilable tasks inspect external state before retry; manual tasks enter NeedsAttention after an uncertain attempt. Never advertise exactly-once effects across arbitrary external APIs.

Time, randomness, lake query results and other nondeterministic inputs affecting graph decisions must be captured as activity results. A completed side effect must not share an activity body with a later durable wait: upstream Activity explicitly warns that suspended bodies can execute again. Persist waits and side effects at separate boundaries.

Retries have maximum attempts, exponential backoff, jitter, maximum elapsed time and an error classifier. Persist the chosen next-attempt time. Durable deadlines survive restarts; a sleeping fiber alone does not. Approvals and signals use stable wait IDs, typed payloads, a deadline and one accepted outcome. Duplicate identical decisions are idempotent; conflicting decisions return Conflict.

## Scheduling and lifecycle

Workers are children of the daemon scope, not the request scope. Bounded queues and concurrency limits apply globally, per workflow and to fan-out. A full admission queue returns a typed overload error before acceptance. Already accepted queued work remains durable. The initial single-writer repository lock prevents two daemons dispatching against the same local store.

Shutdown stops admission, persists drain state, allows a bounded grace period, then interrupts workers and closes resources. Cancellation first records intent, then interrupts active work and linked children. Subprocess execution needs process-group cleanup and escalation after timeout; arbitrary synchronous plugin code cannot be cooperatively interrupted. Isolate such code in worker processes. Finalizers are bounded and failures recorded. Compensation is explicit business logic, not a promise that interruption reverses external changes.

On restart, reconcile outbox entries, engine executions, interrupted attempts, wait deadlines, cancellations and run status projections before advertising full readiness. Preserve running extension bundles until their runs and recovery requirements expire. Detached child runs must be an explicit policy; normal nested workflows inherit parent cancellation.

## Required evidence

Kill the daemon after acceptance, after external success but before activity commit, during artifact publication, during an approval, and after engine completion but before status projection. Restart must recover the documented state without inventing success or losing accepted work. Disconnecting a client must leave execution unaffected. These are release gates, not claims verified by this documentation pass.
