---
title: Architecture
description: The offline Effect runtime and its local persistence boundaries.
---

## Local execution

`packages/cli` is the Effectory CLI, a thin adapter over `@effectory/runtime`. Root scripts run its entrypoint directly. `@effectory/sdk` provides the typed Task and Automation authoring API, plus shared artifact and approval contracts.

Automation code lives under `.effectory/automations/`, with reusable code in `.effectory/automations/shared/`. Generated history lives in `~/.effectory/workspaces/<workspace-hash>/runtime.sqlite`, isolated by canonical workspace path. The socket and local action outputs live in ignored `.effectory/state/`. `.effectory/workspace.json` is the versioned workspace marker. An operation can explicitly call an external API, while the runtime itself has no mandatory network dependency.

## Effect primitives

Operations are Effect programs with Schema contracts. Services and Layers select filesystem, HTTP, process, secret, and storage capabilities. Workflows compose typed operations directly in TypeScript, with bounded concurrency and scoped resources.

Native Effect Workflow and Activity now run through ClusterWorkflowEngine, SingleRunner, and a file-backed Bun SQLite adapter. `packages/runtime` handles admission, task fingerprints, run/artifact inspection, approvals, and a private Unix socket. One CLI runtime owns each workspace at a time. Local commands open and close sessions automatically; task execution blocks until completion or an approval pause. Inspection and approval sessions do not activate workflow execution. Approval records a decision, and explicit `run resume` releases it for downstream execution. Optional long-lived hosting remains available. Small JSON artifacts and application metadata share the SQLite database with engine persistence.

Approval requests and decisions are bound to the reviewed digest and task revision. DurableDeferred resumes accepted decisions; an outbox retries interrupted delivery. Queue, PubSub, Ref, and ordinary Deferred values only coordinate live work. The native engine owns execution without a second Domain saga journal. Cancellation does not imply undoing an already started external action.

## Automation directories

`.effectory/automations/health-check/index.ts` uses `Automation.define` from `@effectory/sdk` to declare its name, input/result/error schemas, idempotency key, and Effect implementation. Reusable operations use `Activity.define`; `Automation.publish` validates and records outputs, and `Automation.approve` suspends for review and fails on rejection. Native Workflow and Activity still supply execution semantics. The resulting manifest exposes its native Workflow and registration Layer. Root `effectory.run.ts` lists all runnable definitions. The examples live under `.effectory/automations/`, but registration is independent of directory layout. Task discovery validates a bounded static import graph and fingerprints source, lockfile, patches, and configuration. It executes trusted modules; it is not a sandbox. Dynamic imports, source symlinks, aliases, and `import.meta` are not supported in task code.

Unfinished executions require their original revision when the runner restarts. Changed code is refused rather than silently mixed with earlier outcomes. Dependencies are assumed to match the installed lockfile. The current socket and process-ownership implementation targets macOS and Linux.

## Documentation

`packages/docs` builds this static documentation site. The repository's `docs/automation-platform.md` records the offline design and roadmap, and `docs/authoring.md` explains the SDK and embedded runtime API.

## Runtime service configuration

Workspace-root `effectory.run.ts` exports `Effectory.make({ workflows, services })` from `@effectory/sdk`. `workflows` explicitly lists the named runnable definitions; unlisted definitions are not registered. `services` is an ordinary Effect layer: compose application services with `Layer.mergeAll`, and supply their dependencies with `Layer.provide`. Automations can require these services in `execute`. Layers share the runtime's scope and are released on shutdown or failed startup.

Providing the SDK's `ArtifactStore` service selects a custom backend for both artifact publishing and inspection. Its `publish`, `get`, and `list` operations return Effects; publication must atomically accept identical retries and reject conflicting content for the same run and name. SQLite remains the default. Runs, workflow results, approvals, and the workflow journal still use local SQLite; no hosted storage adapter or migration is included.

Configuration and its transitive source imports participate in every automation revision and follow the existing discovery restrictions. Changes require restarting the runner and cannot replace the revision of unfinished runs. Environment values and remote state are not fingerprinted. TypeScript checks the listed workflows' service requirements against the provided layers. Runtime loading does not typecheck code. All listed workflows share the root entry point's source fingerprint. Legacy workspaces without `effectory.run.ts` retain directory discovery and optional `effectory.config.ts`; both root files cannot coexist.
