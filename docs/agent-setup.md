# Project instructions and skills

Effectory prepares project-local instructions and an `effectory-build` skill for Codex and Claude Code. It works offline without a daemon or installed project dependencies. It does not start an agent, change agent permissions, install a harness, or configure authentication.

```sh
effectory init ./project
cd project
effectory agent setup --harness codex --harness claude-code --dry-run
effectory agent setup --harness codex --harness claude-code
effectory agent status
```

Commit `.effectory-agent.json` and the generated instruction and skill files. A clone retains the ownership information. Start your chosen agent yourself; restart an existing agent session after updating its files.

Codex receives `.agents/skills/effectory-build/` and a marked block in the effective root instruction file: a nonempty `AGENTS.override.md`, otherwise `AGENTS.md`. Claude Code receives `.claude/skills/effectory-build/` and `.claude/rules/effectory.md`. The two skills contain identical guidance on task/workflow authoring, invocation services and resource lifetime, artifacts, vaults, reports, Checks and runtime recovery. Nested instructions and harness settings can still affect discovery. Status checks files, not whether a running model loaded them.

Setup adds selected harnesses to the recorded set. After a package upgrade, `effectory agent setup` updates that set to the executing CLI's bundled assets and repairs missing files. Setup verifies the initialized project's declared host and SDK pins; use `effectory upgrade` and install its pinned dependencies if they differ. Setup does not change packages or execution compatibility.

```sh
effectory agent setup --dry-run
effectory agent setup
effectory agent remove --harness claude-code --dry-run
effectory agent remove --harness claude-code
```

Removal deletes only unchanged managed content for the selected harness. It preserves shared instruction files, bytes outside the marked block, unknown files in skill directories and the other harness's installed version. It leaves directories and the ownership manifest in place. There is no force-overwrite option: move personal additions outside the marked block or owned skill files, restore their recorded content, then retry. Deleting an owned file allows setup to repair it. A changed root override moves the unchanged managed block while preserving surrounding content in both files.

Both mutations support `--dry-run`; it creates no locks, journals or directories. `--repository` and `--json` work on all commands. Results list file actions, and status reports current, missing, modified, outdated, conflicting or shadowed paths, installed/available versions, and pending work. Unhealthy status exits 1. Invalid input exits 2, I/O unavailability 3, and conflicts or limits 5.

An OS-managed project lock serializes mutations. The journal under ignored `.effectory/agent-setup/` records exact target bytes, and the ownership manifest is written last. If interrupted, rerun a mutating command to complete the recorded operation before planning the next. Dry-run reports pending work without recovering it. If a destination changed after interruption, recovery refuses to overwrite it: preserve the edit elsewhere and restore the recorded old or new content before retrying. A corrupt manifest or journal is a conflict; restore it from a known-good copy rather than editing ownership digests to bypass checks.

Updates span several files and are not atomic to a running agent. Relevant symlinked parents, linked destination files and symlinked repository roots are refused. Shared files must be valid UTF-8; their BOM and line endings outside managed blocks are preserved. Limits are 256 managed files, 1 MiB per file, 2 MiB bundled content and a 256 KiB manifest; oversized content is rejected without truncation.

Assets are embedded in the source CLI and compiled executables. The npm SDK is a separate authoring dependency and does not install harness files. `bun scripts/generate-agent-assets.ts` refreshes the embedded inventory after editing `packages/cli/assets/effectory-build`; binary builds reject a stale inventory. Tests compare every asset and run setup from a compiled executable in a project without `node_modules`.

Installed-harness diagnostics are recorded in [discovery evidence](agent-harness-discovery-evidence.md). They found one limitation in Codex 0.167.0: an existing zero-byte `AGENTS.override.md` suppresses the generated root instruction block, even though current status reports healthy. The skill remains discoverable. A [placement correction](agent-setup-empty-override-amendment.md) is proposed but not yet implemented. The diagnostics do not establish fresh-project model authoring quality.
