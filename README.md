# Effectory

Effectory is a software factory that runs typed Effect workflows locally with SQLite persistence, inspectable outputs, and durable approvals.

## Setup

Install Bun 1.4.3 or later and Node 24.11.1 or later:

```sh
bun install --frozen-lockfile
bun run effectory init
```

The CLI uses the current directory by default. Pass `--workspace <path>` to select another directory. `init` creates or validates `.effectory/workspace.json` without overwriting an incompatible marker; new workspaces also receive an isolated package manifest and TypeScript config. Existing files are preserved. `start` performs the same initialization. Dependencies must be installed before running offline.

## Upgrading from Factory

The command is now `effectory`, packages use `@effectory/*`, and workspace and user data use `.effectory/` and `~/.effectory/`. Environment variables use the `EFFECTORY_` prefix.

Stop all old runners before moving existing data. Rename each workspace's `.factory/` directory to `.effectory/` and `~/.factory/` to `~/.effectory/`, preserving their contents; if both destinations already exist, reconcile them before moving anything. In this checkout, the tracked automation files and marker have already moved, so move any remaining ignored `.factory/state/` into `.effectory/state/`. Update automation imports and paths, environment variables, and scripts to the new names. Complete unfinished workflows with the previous build before upgrading: the rename changes task revisions, local SQLite table names, and durable activity identifiers.

The CLI is named `effectory`, workspaces live under `.effectory/`, and automations import `@effectory/sdk`. The rename changes workspace paths and durable identifiers; finish existing runs with the previous build before switching.

## Install a GitHub release

GitHub Releases distribute the CLI without npm publishing or a source checkout. This repository is private, so authenticate with `gh auth login`, then download the shell installer:

```sh
gh release download v0.1.2 --repo cypress-io/effectory --pattern install.sh
sh install.sh
effectory --help
```

The installer requires Bun 1.4.3+, Node 24.11.1+, and `gh`, and supports macOS and Linux. It verifies the release archive and package checksums, installs versioned CLI data under `~/.local/share/effectory`, and exposes `~/.local/bin/effectory`. If that directory is outside your PATH, it prints the command to add it; shell profiles are never changed. `--bin-dir` and `--install-dir` select custom locations. Installing the same release again reuses its installation; previous releases remain available for running processes. The global command uses a workspace’s installed CLI when available, keeping the runtime and SDK on the same dependency graph.

To also prepare an existing repository's SDK and dependencies:

```sh
sh install.sh --workspace /absolute/path/to/other-repo
cd /absolute/path/to/other-repo
effectory workflow list
```

The host manifest and compiler configuration are preserved. Dependencies, Bun lockfile, compiler config, and vendored SDK/runtime/CLI tarballs live under `.effectory`. Commit those files to reproduce a workspace without GitHub authentication. `effectory init` alone creates configuration; the installer's `--workspace` option also installs its dependencies. Stop the runner and finish pending runs before upgrading. Dependency installation needs the public npm registry or a populated Bun cache.

For workspace-only installation, download `effectory-v0.1.2.tar.gz`, extract it, then run `bun effectory-v0.1.2/install.ts /path/to/repo`. Both the downloaded bundle and shell installer can be removed after installation.

## Dogfood in another repository

From this checkout, package and install the current SDK, runtime, and CLI into another repo:

```sh
bun run dogfood /absolute/path/to/other-repo
```

This initializes `.effectory`, packs versioned tarballs into `.effectory/vendor/`, pins direct and transitive Effectory dependencies to those tarballs, and installs with Bun. Nothing is published. Re-run the command to install a newer local build; stop the target runner first. `bun run pack` separately writes distributable tarballs to this checkout's `dist/`.

New workspaces keep their own `package.json`, `bun.lock`, `tsconfig.json`, and `node_modules` under `.effectory`. The host repository can use another package manager or language. Its package manifest, lockfile, and TypeScript configuration are not used for Effectory task revisions. Existing workspaces without `.effectory/package.json` retain their root dependency layout; the dogfood installer targets new isolated workspaces.

Author `.effectory/automations/<name>/index.ts` using `@effectory/sdk` and `effect` as in [the authoring guide](docs/authoring.md). Then run the installed CLI from the **target repository root**:

```sh
.effectory/node_modules/.bin/effectory workflow list
# In another terminal, also at the target repository root:
.effectory/node_modules/.bin/effectory workflow list
```

When invoking from `.effectory` itself, pass `--workspace ..`. No starter automation is generated. Commit `.effectory/workspace.json`, `package.json`, `bun.lock`, `tsconfig.json`, automations, and the vendored tarballs if teammates should reproduce this build. Ignore `.effectory/node_modules/` and `.effectory/state/` in the target repo.

## Durable tasks

The CLI loads the workflows explicitly listed in root `effectory.run.ts` and runs native Effect workflows with SQLite persistence. Each command opens and closes its local runtime automatically. Start the supplied demos' loopback fixture in another terminal:

```sh
bun -e 'Bun.serve({ hostname: "127.0.0.1", port: 4311, async fetch(r) { const p = new URL(r.url).pathname; if (p === "/slow") await Bun.sleep(1500); return new Response("fixture", { status: p === "/unhealthy" ? 503 : 200 }); } })'
```

In another terminal:

```sh
bun run effectory workflow list
bun run effectory workflow describe health-check
bun run effectory workflow run health-check --input .effectory/automations/health-check/inputs.json --request-key demo-1
bun run effectory run list
bun run effectory run inspect <run-id>
bun run effectory artifact list --run <run-id>
```

`workflow list` and `workflow describe` print readable text: the registered workflows, or one workflow's description and input fields with their types, whether each is required, and their limits. Pass `--json` for machine-readable output. `workflow run` blocks until success, failure, cancellation, or a durable approval pause, then prints the run record. Failed and cancelled executions exit nonzero. An explicit request key lets a caller retry the same submission; changed payload or task revision with the same key is refused. Omit the flag to generate a new key. The input's `requestId` is workflow data; Effectory admission uses the separate request key.

Ctrl+C or SIGTERM requests cancellation and waits for cooperative interruption. Use `effectory run cancel <run-id>` from another terminal to cancel explicitly. After a crash, use `effectory run resume <run-id>` to recover committed activities and continue unfinished work. No background process keeps executing after the owning CLI exits. Optional `effectory serve` hosting remains available for long-lived integrations; local commands do not require it.

### Review an approved action

For a small example that needs no external services, run `bun run effectory workflow run approval-demo --input .effectory/automations/approval-demo/inputs.json`. It publishes a prepared message, pauses for approval, and publishes its completed message only after explicit resume. See the [approval and pause walkthrough](.effectory/automations/approval-demo/README.md) for the commands.

```sh
bun run effectory workflow run approved-health-check --input .effectory/automations/approved-health-check/inputs.json --request-key approved-demo-1
bun run effectory approval list
bun run effectory approval inspect <approval-id>
bun run effectory approval approve <approval-id>
bun run effectory run resume <run-id>
# Or:
bun run effectory approval reject <approval-id> --reason "Revise the plan"
```

Interactive approval prints the exact review and asks for confirmation. Noninteractive callers must pass both `--digest <reviewed-digest>` and `--revision <reviewed-revision>` from the inspection. Approval records the decision without executing downstream work. `run resume` continues the approved workflow and blocks until its next outcome or approval pause. Resuming an undecided gate is refused. Rejection marks the run failed; cancellation prevents a later decision from authorizing its action. The demo publishes the approved report under `.effectory/state/approved-health-check/` through an idempotent file action.

Approvals assume trusted local code and the local OS user. They do not establish human-versus-agent separation for processes with identical privileges. The first version has indefinite waits, with no expiry or escalation.

### Authoring and recovery limits

Automation authors import `Task` and `Automation` from `@effectory/sdk`. `Task.make` creates a named, durable step whose result is recorded, and Tasks may nest; `Automation.define` registers a runnable workflow that composes Tasks, with explicit schemas and an idempotency key. Services such as `Process` and `Agent` are configured once as layers in `effectory.run.ts` and can only be called inside Tasks. `Automation.publish` records schema-encoded outputs, and `Automation.approve` suspends for review and fails on rejection. These APIs use native Effect Workflow and Activity underneath. See [the authoring guide](docs/authoring.md) and the demos for examples.

`@effectory/activities` provides the `Process` service for installed executables with literal arguments, explicit environment and stdin, bounded output, timeouts, and scoped process cleanup, and the `Agent` service for Claude Code and Codex calls with schema-enforced structured output. See [running processes](docs/authoring.md#run-a-process) and [running coding agents](docs/authoring.md#run-coding-agents).

Root `effectory.run.ts` registers every runnable definition alongside its service layers. The examples live under `.effectory/automations/`, but filenames and directories do not determine registration. `@effectory/sdk` in `packages/sdk` owns authoring and shared contracts. `@effectory/runtime` in `packages/runtime` owns discovery, execution, SQLite storage, and the control transport. `@effectory/cli` in `packages/cli` is a thin terminal interface over runtime. Native Workflow manifests and `defineTask` remain supported as a lower-level escape hatch.

Small JSON artifacts, run records, and approval records live in `~/.effectory/workspaces/<workspace-hash>/runtime.sqlite`. The hash is SHA-256 of the canonical workspace path, so each workspace has isolated history and symlinks share the same database. On startup, an existing `.effectory/state/runtime.sqlite` is migrated with its WAL contents after checking that its runner has stopped. Migration refuses to overwrite an existing user database. The control socket and local action outputs remain in `.effectory/state/`. Run results use the workflow success schema's JSON wire representation, so native BigInt and Date results become strings and Void becomes null. An unreadable native outcome or an oversized result is recorded as `inspectionError`; it does not prevent other runs or runner startup, and it is not presented as a fabricated workflow failure. Task revisions fingerprint the supported transitive TypeScript source graph, installed SDK source bytes, package metadata, lockfile, patches, and relevant compiler configuration. Isolated projects use the metadata and configuration under `.effectory` and keep authored imports within that directory. Imports are deliberately bounded: explicit relative `.ts` files within the workspace, supported Effect packages, and permitted builtins. Dynamic imports, `import.meta`, source symlinks, resolver aliases, and untracked executable preloads are refused. Discovery uses the installed TypeScript parser locally and does not install packages. Other installed dependency bytes are assumed to match the lockfile. The v2 revision format changes existing task digests; finish pending work with the previous runtime before upgrading.

Use a new CLI invocation after source changes; restart any optional long-lived runner. If unfinished work needs an earlier revision, restore that source and lockfile before restarting; Effectory does not archive historical executable bundles.

Activity persistence does not make external actions exactly once. The demos use read-only HTTP checks and a reconcilable local file write. Unsafe remote mutations, arbitrary step reruns, general artifact queries, retention/GC, schedules, secrets, a UI, and remote workers remain later work. The Unix socket and process-identity ownership implementation target macOS and Linux.

See the [architecture and acceptance criteria](docs/automation-platform.md), [first automation walkthrough](docs/first-automation.md), and [Swamp comparison research](docs/research/swamp-effect-workflows.md).

## Build and publish releases

`bun run release:pack v0.1.2` validates that the tag matches the SDK, runtime, and CLI versions, then writes the individual tarballs, `effectory-v0.1.2.tar.gz`, `install.sh`, and `SHA256SUMS` to `dist/`. The bundle contains a standalone installer and a manifest of package checksums.

Pushing a `v*` tag runs `.github/workflows/release.yml`: verify the project, pack the tagged commit, and publish a GitHub prerelease with the assets. The workflow uses GitHub's repository token and does not publish to npm. For a new version, update the three package versions, their internal dependency pins, the CLI's reported version, and the workspace initialization defaults before tagging. Each release uses a new version/tag; do not replace assets of an installed release.

## Development and verification

```sh
bun dev --help
bun run typecheck
bun run test
bun run verify
bun run docs:dev
```

`bun dev` and `bun run effectory` both run `packages/cli/src/main.ts`. Verification checks the SDK, runtime, CLI, process recovery tests, and documentation site. Effect and platform packages remain pinned to 4.0.5.

## Documentation site

The Astro/Starlight site lives in `packages/docs`. Run `bun run docs:dev` and edit `packages/docs/src/content/docs/`. The same pages generate `/llms.txt`, `/llms-full.txt`, and `/llms-small.txt` for AI assistants.

## Workflow services

Root `effectory.run.ts` exports `Effectory.make({ workflows, services })` from `@effectory/sdk`, explicitly listing workflows and supplying native Effect layers. Automations can require application-defined services, and a configured `ArtifactStore` replaces both artifact publishing and inspection. SQLite remains the default and continues to hold workflow state. See [runtime service configuration](docs/authoring.md#configure-runtime-services) for composition, backend contracts, and revision behavior.
