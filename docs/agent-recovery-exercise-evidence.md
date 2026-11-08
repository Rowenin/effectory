# Installed agent recovery runbook exercise

The installed Codex and Claude Code guidance was exercised on 2026-11-07 using the compiled host captured after the passing 559-test wake-correction verification. This is an operator/authoring exercise, not a live model session or proof of agent discovery/adherence.

The driver initialized a disposable project with the real CLI, ran `agent setup` for both harnesses, checked healthy status, and verified both installed runtime references were byte-identical to the bundled asset. It then authored and strictly typechecked a small application using the documented Task, Workflow, Context, Layer and ArtifactStorage APIs.

## Incident and observations

The application uses a manual task with a task-local Layer owning an actual file descriptor. A synthetic external service keeps its idempotency ledger outside the project runtime database. It commits a generated confirmation under `context.key("external-action")`, then the handler waits on an explicit test gate before publication. No third-party API, credential or real transaction was involved.

1. A background workflow was durably accepted. Once the external action appeared in its ledger, the driver sent SIGKILL to the daemon and awaited its exit.
2. Restart with the same compatible binary produced NeedsAttention and a Recoverable assessment. Repeating the submission key returned the same run. Repeated assessment did not re-enter the handler or repeat the external action.
3. Authorization without `--acknowledge-reexecution` exited 2 and caused no entry.
4. The exercise explicitly authorized recovery with the assessment token, acknowledgement, request key and fixed reason. The receipt was Accepted. A repeated identical authorization returned the identical receipt.
5. Recovery rebuilt the task-local Layer. Its second entry kept the original attemptId and `context.key` value, found the existing external confirmation, and did not create another action. The task published one artifact version and the workflow reached its subsequent approval.
6. After approving that synthetic review, the same pinned run succeeded. Repeating the original submission returned that completed run and result.

There were two handler entries and two resource acquisitions, but one external action and one artifact version. Only the second resource's finalizer ran: SIGKILL cannot run the first process's Effect finalizers. The second daemon exited normally. All command/daemon processes were awaited, and the disposable project and ledger were removed.

## Evidence and limits

Strict application typecheck exited 0. The driver exited 0 with all assertions passing. Scratch source, driver, replies and logs are retained at `/tmp/effectory-agent-recovery-exercise`; the binary is `/tmp/effectory-upgrade-baseline/effectory-darwin-arm64`.

Application SHA-256: `06bd41fc68436db38149f5994d26276e8de2a12c523d96b0fd607828bef74c05`. Driver SHA-256: `279b01a37900a7ed527b477958ff088ecf218dba117ce64648b4961f38264e9a`. Installed runtime-reference SHA-256: `e35e8a2786d43b45d82a3410f43a0ba998da5db38981a0362ee05114af876199`.

The existing runbook matched the observed CLI and runtime behavior, so no shipped skill content changed. This closes its previously unexercised incident path. It does not prove remote-provider deduplication, power-loss durability of the synthetic ledger, automatic safety of manual re-execution, authenticated harness discovery, or model authoring quality. The exact advanced composition/vault examples subsequently passed their own [SIGKILL/restart exercise](agent-example-interruption-evidence.md); that separate result must not be attributed to this authored incident example.

No production source changed for this exercise. The prior full-suite result remains the implementation baseline; no new full-suite result is claimed.
