---
title: Getting started
description: Run Effectory locally without an account or hosted backend.
---

## Requirements

Install Bun 1.4.3 or later and Node 24.11.1 or later. Install dependencies from the repository root:

```sh
bun install --frozen-lockfile
```

Installation needs package access or a populated cache. Once installed, the runtime has no required internet connection.

## Install a GitHub release

Install the CLI without a source checkout. Because the repository is private, authenticate with `gh auth login`, then download and run the shell installer:

```sh
gh release download v0.1.2 --repo cypress-io/effectory --pattern install.sh
sh install.sh
effectory --help
```

Bun 1.4.3+, Node 24.11.1+, and `gh` must already be installed. The script supports macOS and Linux, verifies checksums, and installs `effectory` under `~/.local/bin`. It prints PATH instructions when needed and never edits shell profiles. `--bin-dir` and `--install-dir` choose custom locations.

Add `--workspace /absolute/path/to/other-repo` when running the installer to also install SDK dependencies under that repo's `.effectory` directory. The host package manifest is preserved. Then run `effectory serve` from the target repo root. `effectory init` alone creates configuration without installing dependencies.

Commit the generated Effectory manifests, lockfile, compiler config, and vendored tarballs to share the workspace build without GitHub credentials. Stop the runner and finish pending runs before installing another release. For workspace-only installation, the `effectory-v0.1.2.tar.gz` asset still contains `install.ts`.

## Use another repository

From an Effectory source checkout, run `bun run dogfood /absolute/path/to/other-repo`. This packages and installs local SDK, runtime, and CLI tarballs under the target's `.effectory` directory without publishing or changing the host package manifest. New workspaces have their own `.effectory/package.json`, `bun.lock`, `tsconfig.json`, and `node_modules`.

Author an automation at `.effectory/automations/<name>/index.ts`, then run `.effectory/node_modules/.bin/effectory serve` from the target repository root. Use the same executable for `task list`, submissions, inspections, and approvals. When running from `.effectory`, pass `--workspace ..`. Stop the runner before rerunning the dogfood installer to update a build.

Keep `.effectory/node_modules/` and `.effectory/state/` out of version control. Commit the Effectory manifests, lockfile, compiler config, automations, and `.effectory/vendor/` tarballs to share a reproducible local build. Existing root dependency workspaces continue to work; the installer targets new isolated workspaces.

## Initialize a workspace

```sh
bun run effectory start
```

`start` creates or validates `.effectory/workspace.json` in the current directory. New workspaces also get a separate `.effectory/package.json` and `tsconfig.json`; initialization preserves existing files and does not install dependencies. It preserves existing definitions and history. It does not require Git or login. Use `--workspace <path>` to initialize another directory. `effectory init` performs the same initialization.

## Run an automation

The CLI starts and closes its local runtime automatically. Start the demo fixture in another terminal:

```sh
bun -e 'Bun.serve({ hostname: "127.0.0.1", port: 4311, async fetch(r) { const p = new URL(r.url).pathname; if (p === "/slow") await Bun.sleep(1500); return new Response("fixture", { status: p === "/unhealthy" ? 503 : 200 }); } })'
```

Keep both processes running. In a third terminal at the repository root, submit and inspect a task:

```sh
bun run effectory workflow describe health-check
bun run effectory workflow run health-check --input .effectory/automations/health-check/inputs.json --request-key demo-1
bun run effectory run list
bun run effectory run inspect <run-id>
bun run effectory artifact list --run <run-id>
```

Use a new request key for a new measurement; retry the same key only for the same accepted inputs and revision. Omitting the flag generates a new key. The task input's `requestId` remains workflow data; Effectory admission uses the request key. `workflow run` blocks until success, failure, cancellation, or a durable approval pause and prints the run record. Failure and cancellation exit nonzero. After a crash, use `effectory run resume <run-id>` to recover unfinished work. Ctrl+C and SIGTERM request cancellation. Explicit `effectory run cancel <run-id>` requests cancellation instead.

## Approve a local action

```sh
bun run effectory workflow run approved-health-check --input .effectory/automations/approved-health-check/inputs.json --request-key approved-demo-1
bun run effectory approval list
bun run effectory approval inspect <approval-id>
bun run effectory approval approve <approval-id>
bun run effectory run resume <run-id>
```

Interactive approval displays the plan and asks for confirmation. Noninteractive callers must supply both `--digest` and `--revision` from the reviewed request. Approval records the decision without executing downstream work. Explicit `run resume` continues approved work and refuses undecided gates. Use `approval reject <approval-id> --reason "Revise the plan"` to reject. The approved demo writes a report to a run-specific file without overwriting conflicting data.

Approvals assume a trusted local user and trusted task code; they do not separate an agent from a human sharing the same OS privileges. Secrets and timed approval expiry remain outside this MVP. Restore the original source/lockfile if a runner refuses to activate a changed task required by an unfinished run.

## Next steps

- [Write your first automation](/guides/first-automation/) using the SDK.
- [Read the architecture](/guides/architecture/) to understand persistence and recovery.
- [Maintain these docs](/guides/documentation/) with Astro.
- Give an AI assistant [the complete docs as text](/llms-full.txt).
