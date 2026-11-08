# Manual recovery

A manual task whose process dies before its result is recorded enters `NeedsAttention`. Recovery lets an operator authorize another execution within the original run. External actions may repeat; acceptance does not prove that the first action failed or was undone.

```sh
# Read-only: inspect recorded uncertainty and obtain an assessment token.
effectory run recover <run-id> --json

# Authorize every uncertain entry in that assessment.
effectory run recover <run-id> --authorize <token> --acknowledge-reexecution \
  --request-key incident-42 --reason 'External provider records inspected'

# Watch continuation and the eventual result.
effectory run watch <run-id>
```

Without `--authorize`, the command is read-only. Assessment supports `--limit` (default 50, maximum 200) and `--cursor`. Authorization covers the **whole assessed set**, including entries on other pages. Leaves still restarting may reveal further uncertainty; they require a new assessment and authorization. A changed assessment returns Conflict without authorizing anything.

`RunRecoveryGet` returns a schema-validated assessment; `RunRecover` returns an immutable `Accepted` receipt with an authorization ID and count. The CLI generates a request key if omitted. On uncertain delivery, retry with the same token, key and reason. Accepted keys keep returning the same receipt, including after the run completes. A different token or reason under an accepted key conflicts. Refused requests do not reserve keys.

Assessment exits 0 even when its `state` says recovery is unavailable. Mutation exits 0 on acceptance, not completion. Existing error exits apply: InvalidInput 2, Unavailable/transport failure 3, and other OperationError codes 5. Inspect assessment state instead of guessing the refusal from exit code 5. Plain watch stays attached through another hold; its progress line points back to assessment.

## What re-entry preserves

The original run input, pinned application revision, completed native activities, settled waits, attempt number and domain-retry budget stay unchanged. `attemptId` and `ctx.key(name)` remain stable. An authorized manual re-entry gets a fresh attempt-timeout window; absolute workflow/ancestor deadlines never reset. Existing stop fences cannot be cleared by recovery.

Task-local Layers are acquired again for each entry. Their previous finalizers must finish before recovery can admit the same task. Already-running siblings can finish, publish and read while another task is held. Closed or superseded entries cannot publish under the new entry's authority.

Use existing provider idempotency keys or reconcile external state in the task body. Re-publishing identical content under the same publication key returns the original receipt; changed content fails `PublicationConflict`. Recovery neither injects a result nor bypasses task schemas, Vault protection or publication checks.

The same rules apply to manual report runs. Reader pins and pending-report source protection remain attached to the original run, and a held scheduled run still blocks overlap. Queries and secret reads execute afresh. No new task-authoring API or context field is required.

## Limits and refusals

An attempt can receive at most 16 additional authorizations; a run can receive at most 64 accepted recovery generations. Their receipts remain for the run's lifetime. If one entry exhausts its limit, the whole current set is refused; cancellation on a compatible host remains available.

Recovery refuses terminal/stopping runs, finalization stalls, expired absolute deadlines, live target entries, pending recovery delivery, missing pinned revisions and exhausted authorization limits. Approval/input/signal waits use their existing answer commands. Recovery is not a replacement for them.

Both RPCs require `run.recovery.v1`. Retained revisions require their original host ABI: an incompatible host build refuses startup before the RPC server is available. Restore the compatible build to recover **or cancel** that run. This feature does not migrate a pre-existing held run across a host ABI change; an arbitrary host upgrade is not a recovery procedure.

The [approved contract](manual-recovery-api-draft.md) contains all wire shapes and the admission/continuation invariants. [Implementation evidence](manual-recovery-implementation.md) separates executed tests from limitations.
