# Agent setup implementation evidence

The user approved the [project-local contract](agent-setup-api-draft.md) on 2026-11-07. The implemented [commands](agent-setup.md) prepare Codex and Claude Code files without starting an agent, daemon, application Layer or network request.

## Implementation

- `packages/cli/src/agent-plan.ts` constructs bounded file actions and validates the fixed ownership inventory using Effect Schema. Shared blocks preserve surrounding bytes; installation, adoption, repair, override migration and removal all check recorded digests.
- `packages/cli/src/agent-files.ts` owns filesystem preflight, the existing SQLite ownership Layer, journal recovery and per-path status. Journals contain exact old/new bytes and a staging identity. Destination files are replaced individually, with the manifest last. Recovery checks every destination before writing and refuses intervening edits. Removal retains the other harness's installed content and ownership, including missing files.
- `packages/cli/src/main.ts` exposes setup, status and remove through the existing Effect CLI, repository option, JSON printer and error mappings.
- `packages/cli/assets/effectory-build/` is the portable skill source. A generated JSON import embeds identical assets into source and compiled CLIs; binary builds check that the inventory is current. The npm SDK remains independent and does not enroll harnesses.

## Focused evidence

These tests ran on the development machine with Bun 1.4.3 and Effect 4.0.5:

- Planner/filesystem tests: 14 passed, 57 assertions. Coverage includes additive enrollment, unchanged second setup, clones, removal, existing personal content, BOM/CRLF preservation, override migration, edited or malformed blocks, missing-file repair, exact adoption, untracked files, UTF-8 and size rejection, manifest path restrictions, SDK-pin mismatch, symlink/hardlink refusal, corrupt-manifest status and live lock contention.
- CLI/crash tests: 3 passed, 548 assertions. CLI tests verify exit codes 0/1/2/5, dry-run, repeated setup and removal without a runtime database. Subprocess tests kill with SIGKILL after each of 69 setup and 63 removal fsync/publication boundaries; the next command completes recovery, releases lock ownership and removes owned staging files. The fault injector wraps filesystem calls only in test subprocesses; no production fault switches were added. These are process-death tests, not power-loss or hostile concurrent filesystem mutation tests.
- A separate filesystem test writes a partial journal operation, makes a conflicting user edit, verifies recovery refuses, then restores the expected destination and recovers even with invalid partial staging bytes.
- Compiled CLI test: passed, 8 assertions. A newly built executable installs both harnesses in a project without `node_modules`, verifies the embedded skill bytes and healthy status, then runs the existing workflow test. The source inventory test checks every embedded reference, not only SKILL.md.
- The skill-creator validator passed. Existing authoring/composition/vault/report/Checks example evidence remains recorded in the approved draft. The installed references remove research-only status language; their tested code examples remain unchanged.

Focused logs: `/tmp/effectory-agent-cli-recovery.log`, `/tmp/effectory-agent-binary.log`. Full required verification passed: typecheck, formatting/lint and **550 tests across 142 files, 5,083 assertions**, zero failures (1256.00 seconds). All 379 captured build/source/asset/test files were unchanged, with no additions or removals. The manifest is at `/tmp/effectory-agent-verification/manifest.json`, with separate typecheck, check and test logs in that directory.

No authenticated agent session was launched. The installed paths and frontmatter follow documented discovery; actual model adherence and fresh-project authoring quality remain separate V1 evaluation work. This implementation does not approve or implement the runtime upgrade proposal.

The installed runtime runbook subsequently passed a [real manual-recovery incident exercise](agent-recovery-exercise-evidence.md): compiled setup for both harnesses, strict application typecheck, SIGKILL after a synthetic external action, read-only assessment, explicit authorization, stable-key reconciliation, fresh task Layers, one publication and unchanged run identity. No skill correction was needed. This closes the runbook exercise gap, not authenticated agent discovery or model-adherence evaluation.
