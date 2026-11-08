# Project agent setup for V1

Status: approved for implementation, 2026-11-07. The user approved the project-local setup/status/remove commands and managed-file contract for **Codex and Claude Code**. Command implementation and repository verification are complete; see [implementation evidence](agent-setup-implementation.md). Live harness authoring evaluation remains a separate V1 quality gate. This covers the requested harness/instruction/skill setup portion of Swamp start; UI and agent launching remain outside this proposal. The commands and bundled skills are implemented; current usage is in [agent setup](agent-setup.md).

## User workflow

```sh
effectory init ./project
cd project
effectory agent setup --harness codex --harness claude-code --dry-run
effectory agent setup --harness codex --harness claude-code
effectory agent status
# After changing the Effectory version, refresh managed instructions/skills:
effectory agent setup
# Stop managing one harness, preserving its unrelated files:
effectory agent remove --harness claude-code --dry-run
effectory agent remove --harness claude-code
```

`setup` adds the explicitly selected harnesses to the recorded set and updates that whole set to the executing CLI's bundled assets. With no flags it updates the recorded set; an unconfigured project must select at least one. `remove` removes only selected registrations and unchanged Effectory-owned content. Neither removes the harness executable. Both mutations have `--dry-run`, which returns the same proposed file actions/conflicts without creating a lock, journal or directory. Re-running setup is the repair/upgrade operation; there is no separate repair command.

Commands use existing `--repository` and `--json`. They do not need a daemon or acquire application Layers. Setup requires an initialized package manifest and matching declared host/SDK package pins; dependencies need not yet be installed. A mismatch explains the existing package upgrade/install path; setup never updates packages itself. It works offline with embedded assets and makes no network, model or authentication request.

The initial scope is local CLI harness discovery. Users start their chosen agent themselves after setup. No model selection, permission/trust change, MCP configuration, hooks, browser flow, terminal-window orchestration or global harness installation is implied. This is a deliberate boundary for approval, not a claim of complete Swamp start parity.

## Files and discovery

| Harness | Always-loaded guidance | Discoverable skill |
| --- | --- | --- |
| Codex | One marked block in the effective root `AGENTS.override.md` when nonempty, otherwise `AGENTS.md` | `.agents/skills/effectory-build/` |
| Claude Code | Owned `.claude/rules/effectory.md`, without path conditions | `.claude/skills/effectory-build/` |

Codex documents root-to-working-directory instruction precedence and repository `.agents/skills` discovery. Its instruction size budget means a large existing instruction chain may truncate guidance. Setup detects the root override and reports its selected path; it does not rewrite global settings or nested instructions. [Instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [skills](https://learn.chatgpt.com/docs/build-skills).

Claude Code documents project `.claude/skills` and `.claude/rules` discovery. Using a dedicated rule avoids replacing either form of CLAUDE.md or changing whether AGENTS.md is loaded. Harness policy/settings can still disable discovery. [Skills](https://code.claude.com/docs/en/skills), [project rules](https://code.claude.com/docs/en/memory).

Both skill copies contain identical portable content; no symlink is required. Always-loaded guidance only identifies Effectory and routes authoring to the skill. The skill itself uses on-demand references and the installed SDK/CLI, not obsolete design drafts. The [draft skill](agent-setup-draft/effectory-build/SKILL.md) includes tested authoring, [composition](agent-setup-draft/effectory-build/references/composition.md) and [vault/report](agent-setup-draft/effectory-build/references/vaults-and-reports.md) applications, plus a recovery runbook. Durable execution of the advanced examples, real recovery exercises and actual harness authoring remain proof gates before shipping.

A tracked `.effectory-agent.json` records format, asset-bundle digest, host/SDK versions, selected harnesses, and installed file/block digests. It is outside `.effectory/`, which `init` ignores, so a clone retains ownership information with its skills. Asset identity is a content digest, not merely the package version. The manifest cannot supply arbitrary write paths: implementation accepts only the fixed harness destinations and embedded asset inventory.

A new clone with the manifest and files is already configured. Missing/corrupt manifests are reported, not silently reconstructed by claiming existing user files. With no manifest, an absent destination can be created and an exactly matching current owned asset can be adopted; any other collision is a Conflict. An existing instruction file without a managed block is shared user content and receives only the block.

## Preservation and interrupted updates

Shared instruction blocks have fixed unique begin/end markers. Preserve every byte outside those markers. A block changed since the recorded digest, duplicate/broken markers, invalid text, or an edited owned asset causes Conflict before ordinary writes begin. There is no force-overwrite option in V1. The error names the paths and explains how to move personal guidance outside managed content before retrying.

When the root Codex instruction target changes, the plan moves only its unchanged managed block to the newly effective root file. It preserves both files' other content. Removing a registration removes its unchanged block but does not delete a shared instruction file. Unknown files inside a skill directory are preserved; do not recursively delete a directory containing user files. Symlinked or multiply linked destinations, including relevant parent paths, are refused rather than followed or replaced implicitly. Root resolution and symlink behavior need explicit filesystem tests.

Preflight the complete action set before mutation. Use a project-local setup lock and a durable journal under ignored `.effectory/agent-setup/`; this lock is separate from daemon ownership. Stage bounded content and record old/new digests before touching destinations. Replace files individually and write the tracked manifest last. Fsync publication/recovery boundaries. Recheck each destination before replacement so an intervening user edit yields a conflict.

Multi-file setup is not atomic to an agent already reading files. Run it before starting a session and restart an existing session afterward. `status` reports an interrupted operation as incomplete, even if some files are new. The next mutating agent command finishes the recorded operation before starting another, using its recorded target bytes; it must not silently reinterpret an old journal with new bundle content. A destination matching neither the recorded old nor new content stops recovery with an actionable conflict. Never roll back over a new user edit. No daemon-start recovery is added for these files.

## Results and limits

`status` is read-only and reports selected harnesses, installed/available asset versions, pending operation, and per-path states: current, missing, modified, outdated, conflicting or shadowed. It reports local installation evidence, not a promise that a live model loaded or obeyed the skill. It must not launch an agent to check that claim.

Mutation and dry-run results list created, updated, removed and unchanged paths plus conflicts. A dry-run conflict is unsuccessful too. Reuse existing CLI error mappings: InvalidInput exits 2, Unavailable exits 3, Conflict/LimitExceeded exit 5; an unhealthy status exits 1 with its report. No RPC, new daemon capability or task service is required.

Bound input and staged data: at most 256 managed files, 1 MiB per shared instruction file, 2 MiB total bundled skill content, and a 256 KiB manifest. Reject oversized input before staging; do not truncate user instructions. Custom instruction fallback names, harness plugins, nested per-package enrollment and global enrollment are not supported in this first contract. Document those limits alongside the chosen harness versions.

## Evidence and implementation gates

- Official discovery documentation was fetched on 2026-11-07. No authenticated harness session was launched; documented support is not an end-to-end discovery proof.
- The draft application's exact TypeScript and tests passed against the workspace SDK and Effect 4.0.5: two tests, three assertions, plus strict typecheck. Explicit daemon start, workflow run and stop were exercised; final status was Succeeded with `Hello, Ada`. The initial attempt before daemon startup failed as expected, so the guide includes startup explicitly. Dependencies were linked from this workspace, not installed from a release registry.
- The separate composition example also passed strict typecheck and two task tests with seven assertions, using workspace dependencies. It verifies invocation tag isolation, observable Layer release, inherited publication tags and artifact fixture handoff. A separate real CLI/daemon run verified workflow admission, publication/read results, request-key deduplication after graceful restart, a second version with different tags and an exact read of the older version. It does not test interrupted execution or graph retry on storage failure.
- The vault/report example passed strict typecheck and three tests with eight assertions: memory substitution, a typed missing-secret error, report outcomes for success/cancellation, and rejection of an accidentally returned synthetic secret. A separate daemon probe used a synthetic local-vault value and temporary external key directory, verified automatic report execution, then checked receipt replay, retained content and a new secret read after graceful restart. No real credential, remote provider or rotation was exercised. The recovery runbook was checked against implemented command/contract sources, not run by these examples.
- The Checks example passed strict typecheck and three task tests with six assertions. It shows that raising `failOn` can let a task succeed while the lower-severity observation stays Failed, and that the default threshold yields a typed AssertionFailed. Its CLI/JUnit commands are grounded in existing command/tests, not an additional daemon run of that example.
- Before shipping: real setup/status/remove tests, unchanged second setup, clones, additive enrollment, native discovery, instruction overrides, user edits, untracked content, symlinks, hardlinks, encoding/line endings, stale locks and interrupted updates at every publication boundary.
- Prove source CLI and compiled distributions contain the same versioned assets and work offline. The npm SDK is a separate authoring package and does not install agent files. Ensure supported harness discovery can see the files without modifying trust or permissions. Independently evaluate fresh-project authoring when authorized; mechanical schema validation is insufficient.
- Typecheck runnable advanced examples for task-local Scope/Layer lifetime, typed errors/retries, artifacts, tags, vaults, reports and recovery; pin them to actual released APIs. Run the repository's required checks for implementation.

## Public choices requested

1. **Confirmed harnesses: Codex and Claude Code.** The proposed scope is project-local setup, with agent launching left for a later contract.
2. Approve `agent setup|status|remove`, repeated `--harness`, and mutation `--dry-run`, with setup also serving update/repair.
3. Approve the marked Codex instruction block, dedicated Claude rule, duplicated portable skills and tracked ownership manifest; preserve user edits with conflicts rather than overwrite them.

The runtime upgrade proposal is independent. Approving agent asset setup does not approve execution compatibility changes or new upgrade commands.
