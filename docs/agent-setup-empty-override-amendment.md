# Codex empty override placement correction

Status: proposed correction to the approved [agent setup contract](agent-setup-api-draft.md), **deferred by the user on 2026-11-08; not implemented**. The user chose to keep current behavior for now. The existing rule selects a nonempty `AGENTS.override.md`, otherwise `AGENTS.md`. Actual installed-harness diagnostics now show a mismatch at the zero-byte boundary. Evidence is recorded in [harness discovery verification](agent-harness-discovery-evidence.md).

## Reproduced behavior

On Codex CLI 0.167.0, an existing zero-byte root `AGENTS.override.md` suppresses the root `AGENTS.md` in `codex debug prompt-input`. The existing Effectory setup selects `AGENTS.md` in this case, and `agent status` reports healthy even though its instruction block is absent from the diagnostic's model-visible input. The skill itself remains discoverable; this failure concerns the shared root instruction block.

A whitespace-only override also suppresses `AGENTS.md`, before and after setup. The existing length check already selects that override, so its placement needs no change. A nonexistent override allows root `AGENTS.md` to load, as expected.

The official guidance specifies override precedence and skipping empty content, but does not establish same-directory fallback strongly enough to override the installed CLI result. This is a version-specific diagnostic observation, not an assertion that every Codex release has the same behavior.

## Recommended change

Use root `AGENTS.override.md` whenever that regular file exists, including when it contains zero bytes. Otherwise use `AGENTS.md`. Keep every existing ownership and conflict rule:

- Preserve all user bytes outside the marked Effectory block. Never delete an override file to expose another file.
- An unchanged block previously installed in `AGENTS.md` moves to the existing empty override during setup. The root user's text stays in `AGENTS.md`; it was already shadowed by the override before setup.
- Status marks a managed `AGENTS.md` block shadowed whenever an override exists, regardless of its length. The unhealthy status remains exit 1 and the remedy remains `agent setup`.
- Truncating the managed override to an empty file is treated as missing managed content and repaired in that same file. A modified nonempty managed block still conflicts.
- If the user removes the override file, setup moves/repairs the block in `AGENTS.md` using the current missing-file rules.
- Removal still removes only the unchanged managed block and leaves shared files in place. An empty override that remains after removal keeps Codex's own precedence behavior; Effectory does not delete it.
- Symlink, hard-link, UTF-8, dry-run, crash-recovery and manifest-last rules remain unchanged. No new flags, schema fields, commands, permission changes or harness launch are added.

A manual layout probe moved only the existing generated block into the empty override. Codex's diagnostic then included that block and continued to discover the skill; the root user's text remained on disk. This proves the candidate layout, not a planner implementation. The temporary edits were restored after the probe.

## Required verification after approval

Add planner/status regressions for an existing zero-byte override, moving an unchanged root block, repairing a truncated override, removing the override, dry-run preservation and removal that retains shared files. Prove the diagnostic fails before and passes after actual setup using the corrected CLI, at root and nested working directories. Keep the normal/whitespace/nonexistent override and Claude discovery checks. Run the required typecheck, formatting/lint and full suite; refresh the final compiled-binary evidence as appropriate without claiming its previous executable digest covers a newly built CLI.

This changes the approved placement rule for an existing user file. It therefore needs the user's public-contract approval before modifying `agent-plan.ts` and `agent-files.ts`.
