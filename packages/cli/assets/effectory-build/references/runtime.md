# Runtime boundaries

Workflow construction builds a durable graph. Put external operations in task handlers, not in `Workflow.make`'s construction Effect. Choose stable graph node keys and task/workflow versions deliberately; changes to identities can affect replay and publication identity.

A task marked `idempotent` must tolerate re-entry. The runtime cannot make an arbitrary external mutation idempotent. Use the external service's supported idempotency mechanism where available. An interrupted manual task can enter NeedsAttention; inspect recovery assessment before authorizing another execution. Authorization can repeat an external action and is not a rollback.

Use application Layers for services whose lifetime can span runs. Use `Task.provide` for resources and services that must be acquired per invocation, including Layers that read run tags or other invocation services. Let Effect Scope own acquisition and release. Do not detach resource-using work from an invocation to escape its timeout or cleanup. Starting a separate `Effect.runPromise` inside a handler also loses the handler's service context and supervision.

A publication must use an artifact declared by that task. Reusing the same publication key with different content can conflict; retries should reproduce the intended content. `ArtifactReader` protects external versions on first successful access, not when a reference appears in input. Acquire required references before waiting if they must remain available. Query results alone do not pin versions. A streamed byte read is fully verified only after successful completion; do not equate an early prefix with verified whole content.

A schedule occurrence identifies one admitted slot, not a guarantee of contiguous data coverage. Use an application watermark when full coverage is necessary. Report runs have their own lifecycle; a source run's successful exit does not imply every report succeeded.

Start the daemon explicitly before commands that require it. `--json` suppresses human progress and keeps the final result machine-readable; `run watch --jsonl` streams observation frames. After observation fails, use the accepted run ID to inspect the outcome. Use the same request key when retrying the same uncertain submission, not a new key that could admit another run.

Stopping a daemon, cancelling a run and retiring history are different operations. Follow the user's requested scope. Retained revisions require either their matching host build or an explicitly tested execution/storage transition. A matching version or execution-contract label alone grants no permission. Bare `effectory upgrade` updates project package pins; runtime migration uses the separate offline `upgrade plan`, `upgrade inspect <plan-id>` and `upgrade apply <plan-id>` commands. Stop the compatible daemon first, inspect the plan and its blockers, and preserve its verified recovery copy and the predecessor executable. Retry an accepted interrupted upgrade with its original plan ID and accepting host. Rollback restores the verified pre-upgrade image with the compatible predecessor; it does not preserve later writes or undo external actions. Do not edit manifests or native workflow tables to bypass incompatibility. Historical data can remain readable while operations needing incompatible application code explicitly refuse.

## Manual uncertainty runbook

Start with existing read-only commands on the compatible host:

```sh
effectory run get <run-id>
effectory run recover <run-id> --json
```

Without `--authorize`, recovery only assesses the run. Check its returned `state`; exit 0 does not mean the run is recoverable or that anything has resumed. NeedsAttention can also mean unfinished finalization, which cannot be fixed by authorizing another entry. Approval/input/signal waits use their own answer commands.

Inspect the external system's recorded action before deciding whether another execution is appropriate. Obtain the user's decision when re-execution has not already been authorized. The existing mutation uses `--authorize <token> --acknowledge-reexecution` and a request key. It covers the whole assessed set, including other pages; it is not a per-task retry. On uncertain delivery, preserve the exact token, request key and reason for the retry. A stale assessment requires a new assessment and decision, not removal of durable records.

An Accepted receipt means permission was recorded, not that recovery completed. Observe the original run afterward. Run identity, pinned revision, `attemptId` and `context.key(name)` remain stable. Use that stable key with the external provider's supported idempotency mechanism; the runtime cannot stabilize a separately generated random key. A fresh manual entry rebuilds task-local Layers and reads secrets again; absolute deadlines do not reset. This runbook describes the implemented commands and invariants, not a recovery experiment performed by the skill examples.
