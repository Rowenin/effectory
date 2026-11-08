# Runtime Scope and Layer ownership audit

Date: 2026-11-05. Source audit of the current worktree, following the user's request to treat Effect Context, Layer and Scope as primary runtime design tools. This records existing behavior, not a new public API or authorization to change lifetimes. Live-console reviews remain separate.

Update, 2026-11-07: the table and retention findings below describe the original audit snapshot. The approved runtime-upgrade work now implements [scoped revision ownership](runtime-upgrade-implementation.md#scoped-revision-ownership): active pins and scoped borrowers replace eager startup acquisition of every retained Layer. Each native Activity has its own borrow through cleanup; a leaf workflow alone is not a sufficient owner. The wake-status correction also supersedes the timer-status finding below. The [activation/shutdown proof](revision-activation-shutdown-evidence.md) additionally checks cleanup and lease ownership while preparation or active-pin release is interrupted.

## Owners in the current runtime

| Lifetime | Owner and construction | End and restart behavior |
| --- | --- | --- |
| Daemon host | `daemon.ts` builds one service Context; `host.ts` composes ownership, storage, engine, catalog, execution resources, runner and scheduler Layers | Enclosing Scope closes services; hard process death does not run finalizers |
| Application revision | `revisions.ts:loadApplication` forks the catalog Scope and builds the exported Layer with `Layer.buildWithScope` | Failed load closes its child Scope. Successful revisions stay in the catalog until its parent closes; they are rebuilt after restart |
| Accepted run | HostStore rows, durable engine identity, outbox and pinned revision | Logical durable lifetime, not a dedicated continuously live Effect Scope. Final terminal reconciliation releases run-indexed semaphore/interrupt maps |
| Physical task attempt | `interpreter.ts` Activity body calls Task.execute; `task.ts:definition` creates fresh tag snapshot, publication owner and Layer MemoMap | Task-provided Layers have scoped acquisition. Cleanup finishes before the activity result; the next attempted execution gets fresh instances |
| Publication | `publication-lifetime.ts` owns tracked child fibers and an idempotent close Effect | Caller interruption interrupts and awaits its child; invocation close interrupts all tracked publications before task-layer teardown |
| CLI observer | `consumeObservation` scopes a child fiber and awaits its Exit; connection belongs to the CLI operation Scope | Disconnect releases framed observer resources; it does not cancel the accepted run |
| Download / HTTP watch producer | HTTP request Scope plus stream resource acquisition | Finalizers release file descriptors/permits. Producer completion does not prove the socket consumer has drained every byte |

This table describes distinct owners; it does not imply one Scope must exist for every row. In particular, persisted workflow state is not serialized Context or Scope state.

## Application versus task Layers

`Application.make` captures its construction Context and provides it when calling registered task definitions (`packages/core/src/application.ts`). This supports shared application services. `Task.execute` then provides invocation-owned Tag.Values and ArtifactStorage inside that wrapper. An inner Task.provide can replace them deliberately.

Task.provide builds using the invocation's explicit MemoMap and a task Scope. The fresh map prevents an application-level build of the same Layer object from supplying a stale, run-specific instance to a task. Nested task providers share that invocation map, so repeated use of the same Layer can still share within the attempt. The requirement types remove runner-owned services while preserving other dependencies.

Existing focused proofs live in `packages/core/test/tag.test.ts` (task Layer acquisition/release under a revision memo map; typed read failures; explicit overrides) and `artifact-storage.test.ts` (parallel/partial acquisition failure, publication close ordering, caller interruption and concurrent invocations). These test runtime behavior, not merely type aliases. Dynamic application loading still cannot inspect unfulfilled TypeScript requirements: the source boundary casts the exported Layer after checking Layer.isLayer. Exported applications should retain the documented `satisfies Application.Application<never>` check.

## Waiting and retries

A task handler's Layers are acquired inside its Activity body. In `interpreter.ts:leafLayer`, a failed attempt completes before RetryScheduled is emitted and DurableClock.sleep is awaited. The next attempt calls execute again and receives a new publication owner and MemoMap. A completed task's resources are therefore not retained merely because the graph later waits for approval, input, a signal or a timer.

This does not mean every resource disappears while a run is Waiting. Application-revision Layers remain loaded. Other branches may still execute task handlers, and current status projection can retain Waiting after a timer wakes. The status is not a resource census. ExecutionResources.track counts physical active bodies; runner reconciliation will not project terminal completion while that count is positive. The two-second NeedsAttention policy is tied to an explicit stop fence and unfinished cleanup; it is not a universal finalizer deadline.

Durable engine replay can reuse a completed Activity result without invoking its handler. That differs from an attempt that genuinely executes again and reacquires resources. No Scope finalizer supplies crash recovery or external-effect exactly-once behavior.

## Background work and publication supervision

Runner and scheduler loops use Effect.forkScoped in their Layers. ExecutionResources.interrupt forks into its captured host Scope so a slow interrupt/finalizer does not hold the reconciliation loop. Accepted work is dispatched from durable outbox state rather than being owned by the admission HTTP request.

Publication ownership uses Effect.forkDetach internally, but it is not unowned fire-and-forget: each child is registered in the invocation set under an uninterruptible mask, removed on completion, interrupted on caller cancellation, and interrupted/awaited by close. This explicit owner covers a source forked by application code that would otherwise outlive the handler. The private MemoMap decorator ensures a failed Layer acquisition closes publications before acquired sources unwind. The code inspects `scope.state` and inherits the MemoMap brand with Object.create; these are coupling points to recheck when upgrading pinned Effect.

Arbitrary author-created detached fibers are not automatically made durable by this mechanism. The publication API is fenced; that is not a promise to supervise every possible detached external side effect.

## Revision retention is a real resource-retention boundary

At startup the catalog loads every valid retained revision (up to 128) and builds its application Layer, not just the active revision or revisions with unfinished runs. New prepared revisions are loaded before activation. Successful prepared revisions are stored in the same map; rejecting a stale activation does not unload them. `runner.ts` releasing run resources only clears run-indexed maps, not catalog entries or revision Scopes.

Consequences from source inspection. The new `revision-lifetime.test.ts` directly exercises stale activation retention, shutdown release and restart reacquisition; it does not exercise run completion:

- An application-level connection/resource can remain open after all runs using it have finished.
- Restart reacquires application services for all retained revisions. Application Layer setup must not be mistaken for “once per new run” or “only active revision”.
- There is no current per-revision retirement/disposal operation or lazy-load reference counting.
- A fault-injection test reproduced resource retention when manifest publication failed after successful Layer acquisition. The private load rollback boundary now includes manifest publication and registry insertion, so prepare fails only after the new child Scope closes. Successfully retained revisions keep the lifetime described above.

Do not silently add retirement: old runs, historical definition inspection, extension selections and future replay can still need the registry. A proposed policy needs explicit identity/lifetime semantics and consumer/Effect review before user approval. The current retained-revision limit bounds count, not the external resources each application Layer acquires.

## Follow-up research with concrete proofs

1. Added `revision-lifetime.test.ts`: three revision Layers acquire before activation, a stale activation leaves the prepared revision acquired, parent shutdown releases all three, and restart reacquires and releases all three retained revisions. This passed with 5 assertions. It does not test run completion. A second test now injects manifest publication failure after acquisition and verifies immediate cleanup.
2. Completed: manifest publication failure is inside loadApplication's rollback boundary. The regression failed before the fix and passes afterward; the active registry remains unchanged, and failed-candidate resources release once before prepare returns. The artificial filesystem obstruction is removed with the test repository; this test does not claim to solve disk repair or crash recovery.
3. Completed for sequential retry and approval: `task-layer-lifetime-daemon.test.ts` runs a real daemon and CLI, records distinct acquired resource identities for two retry attempts, checks the first release timestamp against RetryScheduled, and verifies both attempts have released before approval. It kills/restarts the daemon at that wait, confirms no completed-attempt Layer was reacquired, then approves and verifies a fresh instance for the next task. This passes with 13 assertions. Concurrent branch lifetime remains covered by existing SDK tests, not by this new daemon case.
4. For any eventual revision-retirement API, define whether historical describe/plan reload resources and whether module evaluation can rerun. Do not confuse deleting a cached Context with unloading a JavaScript module.
5. Re-run publication ownership probes on Effect upgrades: acquisition failure, parallel Layers, nested scopes, explicit service overrides and caller interruption are the sensitive cases.

No new public service, Scope wrapper, Layer constructor or lifecycle hook is proposed by this audit.

Verification for this audit: the new revision lifetime test passes; the existing tag, ArtifactStorage and revision tests also pass (21 tests, 79 assertions). These focused checks supplement the earlier 264-test full run; they are not a new full-suite result.

Internal cleanup follow-up: after reproducing the manifest-write failure, the two revision test files pass (4 tests, 22 assertions). Typecheck and repository formatting/lint pass. The completed full regression run passes **266 tests across 69 files, 1749 assertions** (332.58 seconds). The earlier full-run count remains historical evidence.

The subsequent daemon lifetime test passes (1 test, 13 assertions, 11.24 seconds); typecheck and targeted formatting/lint pass. It supplements the 266-test full run and changes no production code or public behavior.
