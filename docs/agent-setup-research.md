# V1 agent harness and skill setup research

Date: 2026-11-07. The user requires start-like harness/skill setup for V1, explicitly defers UI concepts, and has confirmed Codex and Claude Code as the initial harnesses. This is source research and implementation requirements, not approval of the proposed command/file contract. No agent process is launched and no user agent configuration is modified.

## Existing boundaries

Effectory's `initProject` in `packages/platform-bun/src/sdk.ts` creates a starter application and TypeScript configuration when absent, adds ignore entries, then updates project package pins. It does not enroll a harness or install instructions/skills. Bare `upgrade` updates package metadata; agent asset versioning must not be confused with the separate proposed runtime-state migration.

The vendored Swamp start implementation separates workspace/task records, a brief, harness enrollment and launch. Its browser flow and terminal-window launcher are outside this V1 work. Relevant source:

- `vendor/swamp/src/domain/start/harness.ts`: harness-specific initial/open/resume command specifications. The initial prompt points to a brief and the getting-started skill; the user brief itself is not interpolated into a shell command.
- `vendor/swamp/src/domain/repo/skill_dirs.ts`: several tools share a discovery directory; others use distinct paths. Installation deduplicates common destinations.
- `vendor/swamp/src/cli/commands/agent_setup.ts`: tool configuration distinguishes shared instructions from wholly owned files and allows custom tool definitions.
- `vendor/swamp/src/infrastructure/assets/skill_assets.ts`: the distribution bundles a skill plus topic references. Discoverable entry points and on-demand references are separate from large always-loaded project instructions.
- `vendor/swamp/src/domain/repo/repo_service_property_test.ts`: source contains checks for idempotent upgrades, preserving user text, avoiding duplicate Claude instruction targets and handling an existing instruction symlink. These tests were read, not run here.

These are useful design references, not proof that their external CLI flags or discovery paths are current. Verify the chosen harness versions through their supported documentation and local fixture tests before promising support. No Swamp code or skill content needs copying to implement the Effectory behavior.

## Required deliverable

Agent setup needs to make a fresh Effectory project understandable and maintainable by a selected harness, with a usable path for an existing project. The command shape and whether V1 invokes a harness or only prepares the project remain public choices; Codex and Claude Code are confirmed. None requires a dashboard, graphical workspace manager or browser server.

Keep the instruction entry point short: identify the installed host/SDK contract, point to discoverable skills and local definitions, and state the project's verification commands. Rich authoring guidance belongs in versioned references. Avoid duplicating the entire SDK manual into every tool's always-loaded rules.

The skill content must cover actual Effectory authoring behavior:

1. Discover existing tasks, workflows and schemas; use the installed SDK rather than guessed APIs from historical proposals.
2. Define typed tasks, declared errors and replay policy; compose durable workflow nodes without treating arbitrary Effects as persisted graph steps.
3. Choose application versus task Layers deliberately; understand attempt acquisition, cleanup, retries, cancellation and restart.
4. Use injected tags, vault services, ArtifactStorage, ArtifactReader, report History and checks through their implemented interfaces.
5. Test a task with ordinary Layer substitution, then verify durable behavior through a real run when needed. Handle background admission and observation as separate operations.
6. Inspect failures and uncertain manual work before retrying; preserve request keys and avoid guessing that a disconnected CLI means nothing ran.
7. Respect the supported upgrade/retention boundaries and extension contracts without requiring additional providers for a first application.

## Setup and upgrade ownership

Before implementation, specify these behaviors together rather than adding an overwrite flag after conflicts appear:

- Which project-local files/sections Effectory owns, and where its installed asset version and content digests are recorded.
- How repeated setup avoids duplicate instructions, conflicting discovery targets and unnecessary writes.
- How it preserves user content in shared files and recognizes user edits to a previously managed asset.
- How an interrupted multi-file update is resumed or diagnosed without falsely marking the whole bundle installed.
- How removed/renamed skills are retired without deleting unrelated files, and how multiple configured harnesses share assets where appropriate.
- How symlinks and paths outside the project are handled explicitly. A repository file must not silently authorize writes to global harness configuration or modify trust/permission settings.
- How packaged/compiled Effectory carries its skill assets offline, and how version mismatches are reported alongside host/SDK checks.

Project setup should not need a running daemon, acquire application/provider Layers, read secrets, install a new provider, or execute an authored task. Harness launch, if selected, must use owned Effect process primitives and an argument array, with an explicit distinction between preparing files and running an agent.

## Evidence required before shipping

- A clean project and an existing project with user-written instructions both enroll correctly under the approved command contract.
- Two setup runs are idempotent; upgrade preserves unrelated bytes; user-edited managed content yields an actionable conflict; interruption at each write boundary can be repaired.
- All advertised harness discovery paths are verified, with separate evidence for setup-only and actual launch/resume if supported. Do not install or authenticate a user's harness for a mechanical test.
- Runnable examples in the shipped skill content typecheck and exercise the real SDK. A fresh-project authoring check reaches a tested task/workflow and an observed successful run.
- Instructions survive host/SDK asset upgrades without teaching APIs absent from that build. The runtime upgrade policy and agent asset update are reported distinctly.

This research does not expand V1 into an agent host, model proxy, UI, multi-workspace manager or third-party provider catalog.

## Proposed contract and prototype evidence

The [CLI-only setup proposal](agent-setup-api-draft.md) now spells out project-local setup/status/remove, discovery files, ownership, conflict handling and interrupted-update recovery. It remains unapproved. Its [draft authoring skill](agent-setup-draft/effectory-build/SKILL.md) is stored under documentation and has not been installed into either harness's discovery directory. Official discovery sources are linked in the proposal.

The skill's application and test were checked in `/tmp/effectory-agent-setup-probe` against the real workspace SDK and Effect 4.0.5. Strict typecheck passed with one nonblocking Effect suggestion; two tests passed with three assertions. The CLI first refused a run without daemon metadata; after explicit daemon startup it returned Succeeded and `Hello, Ada`. The daemon was stopped afterward. This tests the example, not the proposed setup command, package-registry installation or a real agent session. No production code changed and the full suite was not rerun for these documentation changes.

The [composition reference](agent-setup-draft/effectory-build/references/composition.md) adds an independently typechecked application and task tests for a task-local Layer reading `Tag.value()`, scoped client acquisition/release, inherited publication tags, `ArtifactStorage`/`ArtifactReader`, and passing fixture collections between tests. Both code fences were extracted again after formatting and checked in `/tmp/effectory-agent-composition-probe`: strict typecheck passed, and two tests passed with seven assertions. The client is explicitly an in-memory stand-in; no third-party connection was used. The tests verify each invocation's tags and cleanup, not workflow admission or retry policy. The skill frontmatter validator also passed; that is not evidence of authenticated Codex/Claude discovery.

A subsequent `daemon-proof.ts` in that scratch directory exercised the exact formatted application through the CLI. `daemon-proof.log` records successful workflow results for platform/7 and infra/9, one artifact with versions 1 and 2 and distinct inherited tags, a same-key replay returning the original run after graceful stop/start, and a new task run reading version 1's original value. Both daemon processes exited 0 and the disposable repository was removed. The source SHA-256 is `3445d492eba30b4e5c9605f818861d6436638582577063fae324eed276f852c0`; the probe SHA-256 is `45d167ff281dc8b6906f3cb5cfb6a531b00da46cc0d878792e09809ea7871c4b`. This is completed-run persistence and exact-read evidence, not an interrupted-run or storage-retry proof.

The [vault/report reference](agent-setup-draft/effectory-build/references/vaults-and-reports.md) likewise had its formatted TypeScript fences extracted and checked in `/tmp/effectory-agent-vault-report-probe`. Strict typecheck and three tests with eight assertions passed. They exercise memory-vault substitution, a missing-secret tagged failure, report fixtures for success and cancellation, and the guard against returning a synthetic secret. An initial assertion incorrectly expected the error code in `Cause.pretty`; the corrected test reads the typed `code` field and separately checks that diagnostic text excludes the canary. This changes only the example assertion, not runtime sanitation. Those task tests used no local vault/key or report admission. The recovery runbook in the runtime reference was checked against the current CLI and manual-recovery contract but was not executed as an incident exercise. Recovery exercises and authenticated harness authoring remain unproved.

A separate vault/report `daemon-proof.ts` subsequently ran the exact application with a synthetic local-vault value, an input file and key directory outside its disposable repository, and real CLI report commands. It used the current describe token for put, observed successful source and report runs, then gracefully restarted and verified put/submission replay, unchanged retained report content, and a new successful secret read/report. Both daemons exited 0. All 12 files in the stopped repository were scanned without finding the synthetic plaintext; no deliberate leak was injected in this daemon example. The repository, input file and keys were then removed. `daemon-proof.log` records the replies. Source SHA-256: `cb579c5f67415f38f2e4c6b5c067ab13736ba79b96c80f5c0f8975b530c8bb12`; probe SHA-256: `bc8f2dc3d5af5915e62c87da30d422af5abd58acca91fb980a8d48010457bede`. This is local-provider/report evidence, not remote-provider, rotation, interrupted execution or general sanitation certification. No real credential was used.

The [Checks reference](agent-setup-draft/effectory-build/references/checks.md) closes the content gap around recorded assertions and task thresholds. Its two formatted TypeScript fences were extracted to `/tmp/effectory-agent-checks-probe` and checked against the workspace SDK: strict typecheck passed, and three tests passed with six assertions. They cover all-pass checks, a low-severity failure retained as Failed under a higher threshold, and the default threshold's typed AssertionFailed. The draft also explains lazy predicates, declared evaluator errors, replay responsibility, acquisition/handler lifetime and JUnit's separate consumer policy. The commands were checked against current CLI source/tests; no additional daemon/JUnit run or authenticated agent evaluation was performed for this example.

The exact installed composition and vault/report applications subsequently passed [process-kill recovery exercises](agent-example-interruption-evidence.md) using the certified binary. The new proof preserves accepted IDs, results, publication counts, report identities and the vault receipt across SIGKILL; it does not evaluate actual harness discovery or model authoring.
