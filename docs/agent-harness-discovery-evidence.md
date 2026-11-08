# Installed agent-harness discovery evidence

The compiled Effectory CLI installed its real bundled instructions/skills into a fresh disposable Git project, without project dependencies. Local diagnostics then exercised **Codex 0.167.0** and **Claude Code 2.1.319**, on Darwin ARM64 with Bun 1.4.3. The [machine evidence](agent-harness-discovery-evidence.json) retains filtered results, exact probe source, executable/log hashes and the limits below. No model turn, prompt to another agent, or token-counting API request was submitted.

## What passed

Codex's installed `debug prompt-input` command rendered the project instruction chain and skill metadata. At both project root and a nested directory it included the user's root canary, the Effectory block, and `effectory-build` metadata. Skill paths used a root alias; the first probe incorrectly expected one absolute path and was corrected to check the alias's directory and file separately.

A nonempty root override replaced the root instruction file, and setup placed the block there. Removal made the skill disappear from discovery while preserving the user's override text. These are actual compiled-setup plus installed-harness diagnostic results, not only filesystem assertions.

Claude was initialized through its official Agent SDK 0.3.319, installed only in scratch storage and pointed at the existing native executable. The input iterator yielded no user message. `supportedCommands()` listed `effectory-build`, and `getContextUsage({ detail: "summary" })` identified both its project skill path and `.claude/rules/effectory.md`. Root and nested working directories passed. Excluding project settings removed both entries. API usage remained null.

The Claude process allowed the Skill tool but invoked nothing. With all tools disabled in the first probe, the slash-command list still contained the skill but the context summary did not include its metadata. That failed assertion is retained separately. Hooks, MCP and persistence were disabled for the isolated diagnostic; this does not prove every customized user configuration will load the same files.

## Zero-byte Codex override mismatch

An existing zero-byte `AGENTS.override.md` suppresses root `AGENTS.md` in this installed Codex diagnostic. Effectory currently treats the empty override as absent, puts its block in `AGENTS.md`, and reports `healthy: true`. The resulting prompt contains the skill metadata but **does not contain the generated root instruction block**.

Whitespace-only overrides also suppress root instructions. Current Effectory setup already selects that nonzero-length file; this edge does not require a change. When there is no override file, root instructions load normally.

A manual candidate layout moved the unchanged generated block into the existing empty override and retained all root user text. The diagnostic then included the block. The scratch edits were restored. No production planner, status behavior or ownership manifest was changed by the layout probe.

The [proposed correction](agent-setup-empty-override-amendment.md) is to select any existing override, including a zero-byte file, and to report a managed root block shadowed whenever an override exists. The approved contract explicitly says “nonempty,” so the correction remains a public-contract amendment awaiting the user. Discovery is therefore partially verified, not declared complete.

## Documentation and scope

Current official [Codex skills documentation](https://learn.chatgpt.com/docs/build-skills) identifies `.agents/skills` at repository scope and ancestor discovery. The [AGENTS.md guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md) specifies override precedence, one instruction file per directory and empty-content skipping. The zero-byte observation above is reported as measured installed-CLI behavior rather than extrapolated from that wording.

Claude's [skills documentation](https://code.claude.com/docs/en/skills) describes project/nested discovery and the effect of project settings. Its [memory documentation](https://code.claude.com/docs/en/memory) describes unscoped `.claude/rules` loading and the same settings exclusion. The [Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) documents initialization metadata, available commands and summary context inspection without token-counting requests.

This evidence does not cover cloud sessions, organization-managed restrictions, all harness versions, actual model selection of the skill, or fresh-project model authoring. It does not make `agent status` a harness-invocation command; status still inspects local files only. No account setup, global harness configuration change, repository runtime change or extension integration was added. The temporary SDK is a probe dependency, not an Effectory package dependency.

All 457 source/configuration/example/script/test files in the completed upgrade certificate remained unchanged. This turn's repository changes are documentation/evidence only. Formatting/lint was rerun; no new full-suite result is claimed. The earlier 748-test passing checkpoint remains the source baseline.
