# V1 runtime correctness, upgrades and agent setup

Status: current work direction, set by the user on 2026-11-07. This replaces the open-ended Swamp parity loop as the active priority. It does not approve new public commands, schemas or compatibility policies; those still require discussion. Internal investigation and correctness fixes can proceed.

## Objective and scope

Make the existing local Effectory runtime reliable to execute, restart, upgrade and maintain, and supply the agent harness setup and skills needed to author applications correctly. Continue to use Effect Context, Layer, Scope and durable engine primitives, with explicit resource ownership.

Additional third-party extensions are deferred until the user needs them in actual use. Preserve the implemented AWS extension. Keep the 1Password research and selected local CLI direction, but do not treat its pending API approval as a blocker for this objective. Broad Swamp feature parity is a reference inventory, not the completion criterion for V1.

UI concepts are explicitly deferred at the user's request. Do not design or build dashboards, browser onboarding, graphical workspace selection or terminal-window orchestration in this work. Agent setup is a CLI/project capability. The user confirmed Codex and Claude Code as the V1 harnesses; the approved commands and managed-file behavior are described in [agent setup](agent-setup.md).

## Work order

1. **Upgrade compatibility and recovery.** Inventory the host ABI, stored schemas, retained application bundles and native Effect execution state as separate compatibility boundaries. Reproduce upgrade refusal with retained revisions and establish what remains inspectable and recoverable. Propose the supported upgrade/rollback policy before changing it. Preserve pinned execution identity and never silently replay uncertain work or relabel old bundles as compatible.
2. **Runtime correctness.** Reproduce the stale Waiting projection after timer/backoff wake; cover running siblings, approvals, manual recovery holds, cancellation and deadlines. Audit interruption, shutdown and resource cleanup at the existing attempt, operation and revision boundaries. Fix established contract violations with regressions. Discuss any new status meaning or foreground exit behavior first.
3. **Revision and history lifecycle.** Define when revision resources and files can be retired, accounting for unfinished runs, report retries, schedules, historical inspection and retained execution results. Build on existing offline run-family reclamation and automatic artifact retention. Automatic run/report cleanup is a distinct policy decision, not implied by this scope change.
4. **Agent authoring setup for V1.** Provide harness-specific project instructions and discoverable, versioned skills that teach the actual SDK and CLI. Define installation, repeated setup, upgrade and repair behavior together. Preserve user-authored instructions and edits; report conflicts rather than silently replacing them. No UI is required for this workstream.

This order starts with the upgrade blocker; agent setup is a required V1 deliverable, not optional extension parity. Research and documentation can progress across the workstreams without waiting for all runtime code to finish.

## Current evidence

The [HTTP disconnect and same-format upgrade correction](runtime-http-disconnect-evidence.md) is implemented and verified. The certified pre-reclamation target passed 757 tests, all four certified Darwin ARM64 upgrade matrices, real HTTP disconnect/shutdown proofs and Linux component checks against 460 unchanged files. Earlier results below remain evidence for their named checkpoints. New revision-reclamation source is in progress and is not covered by that executable certificate.

Source audit and linked verification; each experiment retains its scope limits:

- `packages/platform-bun/src/host-runtime.ts:sourceAbi` hashes TypeScript sources in core, runtime and platform-bun. The compiled host embeds the corresponding digest.
- The original catalog rejected any mismatched retained ABI and built every retained application at startup. The implemented catalog now validates metadata first, lazily acquires application Layers and retains them through scoped borrowers. The compatibility policy separates execution contracts from provenance. The four exact [Darwin ARM64 predecessor/target transitions](runtime-http-disconnect-certification.json) are certified; other transitions remain refused.
- `packages/platform-bun/src/sdk.ts:upgradeProject` updates package pins and the project version marker. It is not a migration of saved bundles or native workflow state. Current backup/restore documentation requires a compatible build.
- The earlier runner left Waiting visible during executing sleep/retry successors. The approved correction now tracks invocation work outside permit acquisition and reconciles Running through execution and cleanup. [Wake-status evidence](runtime-wake-status-evidence.md) records the failed-before cases, new regression coverage and full verification.
- Existing revision lifetime and rollback tests cover retained Layer acquisition/release and failed manifest publication. They are not evidence that cross-build upgrades or revision retirement work.

The initial upgrade assessment must distinguish source facts from real old/new-host, crash and restore proofs. A passing suite for one build is not upgrade compatibility evidence.

## Remaining V1 gates

| Requirement | Evidence now | Work still required |
| --- | --- | --- |
| Stop, interruption and cleanup ownership | [Stop-fence regression](runtime-status-research.md), [mixed cleanup causes](task-cleanup-cause-evidence.md), [post-finalizer validation](task-finalization-boundary-evidence.md), and [gated cancellation/shutdown ownership](task-stop-ownership-evidence.md); checkpoint full-suite baseline: 559 passed, 0 failed | Retain these regression gates as upgrade/lifecycle work proceeds; keep forced-stop and crash guarantees separate rather than treating graceful cleanup as a SIGKILL guarantee. |
| Status after durable wake | Approved [contract](runtime-wake-status-api-draft.md), real persistent-host and CLI regressions for work, cleanup, queues and restart | Implemented and verified: typecheck, formatting/lint and 559 tests passed against 381 unchanged files. See [evidence](runtime-wake-status-evidence.md); retain these gates during upgrade work. |
| Execution upgrades and rollback | [Current exact-build certification](runtime-http-disconnect-certification.json), actual old/new-host and offline-writer proofs | The approved offline upgrade contract is implemented. Four Darwin ARM64 paths passed against the current target: storage 1 and 3 from the preceding current host, storage 2 from the earlier certified host, and storage 1 from the legacy host. Typecheck, formatting/lint and 757 tests passed against 460 unchanged files. Other builds/platforms require their own executable proofs. |
| Revision lifecycle | Scoped catalog acquisition/release, real Activity shutdown/cleanup and historical vault-operation tests; full verification passed 610 tests with zero failures and 398 captured files unchanged | Active and borrowed revisions retain their Layers; startup no longer builds inactive retained revisions. Each Activity retains its own borrow through cleanup. The [shared-acquisition cancellation audit](revision-shared-acquisition-evidence.md) also passed direct catalog and compiled-daemon cases: one disconnected waiter leaves the other alive, the last waits for cleanup, and later access reacquires. The new [concurrent shutdown/activation proof](revision-activation-shutdown-evidence.md) passes at preparation and post-publication cleanup boundaries; typecheck, formatting/lint and the full 711-test suite passed against 451 unchanged files. Real compiled-host HTTP vault reads also retain the provider through gated cleanup on daemon stop and SIGTERM; see the [HTTP shutdown proof](revision-http-shutdown-evidence.md). Cross-build replay passed for the exact certified upgrade edge. The actual catalog and compiled daemon reproduce [exhaustion by never-activated candidates](revision-retirement-research.md). The user approved [offline revision reclamation](revision-retirement-api-draft.md) on 2026-11-08. Implementation is in progress; deletion is not exposed yet. |
| Codex and Claude Code project setup | Both harnesses selected; [command/file proposal](agent-setup-api-draft.md) and [draft content evidence](agent-setup-research.md) | Approved and implemented setup/status/remove; preservation, actual process-kill recovery and compiled assets have targeted test coverage. Typecheck, formatting/lint and the full suite passed: 550 tests, zero failures, with all 379 captured source/build/test files unchanged. Installed Codex/Claude discovery now has [metadata diagnostic evidence](agent-harness-discovery-evidence.md); a zero-byte Codex override exposed a [placement correction](agent-setup-empty-override-amendment.md) that the user deferred on 2026-11-08. Fresh-project model authoring remains a separate quality gate. |
| Agent authoring quality | Basic, composition and vault/report examples typechecked, task-tested and exercised through the daemon; the latter two include graceful restart checks | The installed recovery runbook passed a [compiled-host incident exercise](agent-recovery-exercise-evidence.md). The exact installed composition and vault/report examples now pass [SIGKILL/restart exercises](agent-example-interruption-evidence.md). Actual installed-harness metadata discovery passed root/nested checks, nonempty override precedence and a Claude settings exclusion control. The zero-byte Codex override remains a disclosed gap; the user chose to keep current placement behavior. Fresh-project model authoring remains unverified; diagnostics do not prove a model selects or follows the skill. |

This is a requirement audit, not a declaration that V1 is complete. Extension breadth and UI are deferred by the user and are not missing gates in this table. The upgrade contract now has concrete old/new-host evidence; that does not substitute for the remaining agent authoring quality gates or certify other upgrade edges.

## Agent setup requirements

The user's reference is Swamp's start-like agent setup, specifically harnesses and skills that guide application building. The vendored [`start` design](../vendor/swamp/design/surfaces/start.md), [`harness` table](../vendor/swamp/src/domain/start/harness.ts), [`agent setup` command](../vendor/swamp/src/cli/commands/agent_setup.ts) and [`skill directory` mapping](../vendor/swamp/src/domain/repo/skill_dirs.ts) show separate concerns: enrollment, instructions/skills, task briefs and agent launch. Their browser/workspace UI is outside this V1 work. Source inspection does not prove current compatibility with the external harness versions.

Proposed content responsibilities, not final skill names:

- Bootstrap a project against the installed host/SDK versions and discover existing definitions before editing.
- Author typed tasks and durable workflows, including error/retry policy, idempotency, waits and schedules.
- Use Effect services and Layers with the correct application/attempt lifetime; do not confuse ordinary Effects with durable graph execution.
- Use tags, vaults, artifacts/readers, reports and checks through their implemented APIs.
- Run meaningful tests, inspect a real run, and handle uncertain execution, cancellation and restart without unsafe replay.
- Understand upgrade/retention compatibility and when existing extensions can be installed and used.

Setup must distinguish managed files from shared instructions, keep a versioned ownership inventory, handle interrupted updates, and be safe to repeat. Verify each supported harness's discovery paths and launch/configuration contract before implementation; do not copy the vendored harness flags as a current guarantee. Keep content and examples synchronized with the actual SDK, and prove a fresh project can follow them to a tested task/workflow and observed run.

## Completion evidence

- Relevant real-process proofs for restart, cancellation/timeout, manual recovery, publication/read cleanup and status projection, plus focused regressions for changes made.
- An explicit, user-approved upgrade compatibility policy with old/new build tests, interrupted migration/recovery where applicable, backup/restore and downgrade refusal or supported rollback evidence.
- A user-approved revision lifecycle with dependency protection and exactly-once resource release tests before introducing retirement.
- Repeatable harness setup/upgrade that preserves user edits, detects drift and leaves a usable project after interruption; typechecked runnable skill examples and a fresh-project authoring check.
- Required `bun run typecheck`, `bun run check` and `bun test` for implementation changes, recorded against the tested source state. No new full-suite result is claimed by this planning update.

New providers, remote workers, multi-user hosting, dashboards and broad query/cron expansion are not gates for this objective unless the user adds them explicitly.
