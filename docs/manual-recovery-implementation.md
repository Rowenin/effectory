# Manual recovery implementation evidence

User approved the reviewed contract on 2026-11-06. Implementation and repository-wide verification are complete.

## Implementation

- Effect Schema definitions in `packages/runtime/src/recovery-protocol.ts`; `RunRecoveryGet` and `RunRecover` RPCs and `run.recovery.v1` capability.
- Durable holds, one-entry permissions, immutable receipts, sequenced gates and generation obligations in `recovery-store.ts`. Recovery intents are separate from the legacy outbox.
- Scoped native delivery in `recovery-continuation.ts`. Obligation completion depends on admission or native completion, not a scan that happens to see no suspended leaves. A native resume retry cannot block the shared runner loop.
- Interpreter admission uses an acquire/release reservation enclosing task execution and Layer finalization. A persisted `windowStartedAt` supplies both admission and in-handler deadlines. Failed SQLite commit rolls back the in-memory reservation too.
- Private entry fences protect publication and reads. Run status projections retain unresolved uncertainty while allowing admitted siblings to finish.
- CLI read-only assessment, explicit acknowledgment, schema validation, capability preflight, shell-safe uncertain-delivery hints and recovery-aware progress.

## Executed focused evidence

- `manual-recovery.test.ts`: whole-set paging, receipt replay after terminal, repeated uncertainty, delayed discovery, re-gating, cancellation before consumption, fresh attempt windows, fixed deadlines, persisted pending intent, live-entry refusal, limits and stale cursors.
- `manual-recovery-process.test.ts`: real interpreter and SQLite, repeated SIGKILL/restarts, acceptance persisted without dispatch, kill after consumption, second authorization, preserved upstream native result, task-local resource reacquisition and deduplicated publication. The external-action counter is synthetic; it deliberately increments once per authorized re-execution.
- `manual-recovery-continuation.test.ts`: installed native engine and production host continuation with a deliberately delayed rejection-to-suspension seam. Checks late suspension, re-gating under a newer hold and an unrelated retry backoff. Its custom native handler isolates this seam; it is not the full interpreter.
- `manual-recovery-lifecycle.test.ts`: the real interpreter retains its live reservation through a blocked task-local Layer finalizer; recovery reports `ExecutionActive`, and native completion then clears the obsolete uncertainty.
- `manual-recovery-lake.test.ts`: admitted sibling publication and JSON reads during a hold; superseded entry rejects both operations.
- `manual-recovery-cli.test.ts`: real daemon/RPC/CLI inspection, acknowledgment refusal, original-run completion and identical receipt replay.
- `packages/cli/test/recovery.test.ts`: flag combinations and quoting of retry commands. `watch-compat.test.ts` additionally checks old-daemon preflight before any recovery request is sent.

The separate older-build proof ran the CLI test with:

```sh
EFFECTORY_RECOVERY_PREVIOUS_BINARY=/tmp/effectory-recovery-previous-build/effectory-darwin-arm64 \
  bun test packages/platform-bun/test/manual-recovery-cli.test.ts
```

That executable was compiled before subsequent host changes, with ABI `a907bca142dd8e775773e3e72f0dd825924f0ed8b41650773e94b6e2b966ad31`. It is an actual earlier build of this checkout, not an historical published release. The test stopped the compatible daemon, committed acceptance without dispatch, verified the earlier binary refused startup without consuming or changing pending holds, and restarted the compatible host to finish. It passed 11 assertions in 28.81 seconds. The normal test without that environment variable separately passed 8 assertions.

This does not establish compatibility with arbitrary historical binaries, cross-host ABI migration, distributed leases, or recovery of external effects detached from structured task scopes. No real payment or other external action was performed.

## Additional production-component probes

These ran outside the checkout with synthetic data; they are separate from the repository test suite.

A six-report crash/restart probe used the real host, interpreter, lake, report queue, Vault service and task-local Layers. Four reporters entered before the first SIGKILL. On restart those four held, two more entered, and a second SIGKILL left all six held. Offline acceptance committed six authorizations without dispatch; the compatible host then completed all six. Observed results:

| Measurement | Result |
| --- | --- |
| Running report records immediately after acceptance | 6 |
| Maximum simultaneously executing report handlers | 4 |
| Source executions | 6, with no source replay |
| Reporter entries / synthetic external-action count | 12: first entry plus one authorized re-entry each |
| Fresh Vault reads and resource acquisitions | 12 each |
| Resource finalizers after successful recovery | 6; SIGKILL cannot run finalizers |
| Source versions protected in every pre-recovery phase | 6 |

Scratch source and driver: `/tmp/effectory-recovery-reports/fixture.ts` and `run.py`; result: `/tmp/effectory-recovery-reports/result.log`. No real secret or external provider was used. The reporter read its protected source through `ArtifactReader` and republished under the original key.

A separate in-memory SQLite probe seeded 10,000 prior attempts and invocation locators, then used production admission to hold them, production assessment and authorization, and the production continuation work query. One 200-entry assessment carried the token for all 10,000 entries; one 234-character receipt authorized them all. The assessment was 71,718 characters. Continuation enumerated 200 pages of at most 50 entries. On this machine during the suite, assessment took 76 ms, acceptance 102 ms and the complete work scan 878 ms. These are observations, not latency guarantees. This did not execute 10,000 task handlers. Scratch source and result: `/tmp/effectory-recovery-scale/probe.ts` and `result.log`.

## Final verification

On 2026-11-06, `bun run typecheck`, `bun run check` and `bun test` passed. The full suite ran **398 tests across 105 files, with 3,038 assertions and zero failures** in 665.06 seconds. All 278 captured source/test/package-manifest hashes remained unchanged during verification. This run includes all new recovery tests and existing scheduling, reporting, Vault, reader, publication, live-watch, extension and backup regressions.

Logs: `/tmp/effectory-recovery-final-typecheck.log`, `/tmp/effectory-recovery-final-check.log` and `/tmp/effectory-recovery-full-tests.log`. Final documentation-only updates were followed by another formatting/lint check. This verification ran locally on macOS; it does not establish a Linux recovery run. No commit or PR was created.
