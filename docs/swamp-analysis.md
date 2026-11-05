# Swamp analysis and parity scope

## What Swamp does

Swamp is automation infrastructure driven by people and external coding agents. A behavior type declares methods, schemas and outputs; a definition configures one instance. Workflow jobs connect method calls with dependencies and conditions. Executions produce versioned artifacts and run records. Vaults resolve secrets, extensions supply integrations, and serve exposes the application to remote clients.

This account comes from the pinned [architecture](../vendor/swamp/design/architecture.md) and spot checks of the source below. It is a source review, not a claim that we ran Swamp's integration suite. Large upstream design documents include evolving features; listed targets do not promise compatibility with every flag or format.

## Feature mapping

| Swamp capability | Source evidence | Effectory counterpart | Delivery |
| --- | --- | --- | --- |
| Behavior types, configured definitions, methods and output schemas | [model.ts](../vendor/swamp/src/domain/models/model.ts), [behaviors](../vendor/swamp/design/primitives/behaviors.md) | `Task.make`, `TaskGroup.make`, schema-validated configuration and task handlers | Core |
| DAG jobs/steps, dependencies, bounded fan-out, conditions, nested workflows | [execution_service.ts](../vendor/swamp/src/domain/workflows/execution_service.ts), [workflows](../vendor/swamp/design/primitives/workflows.md) | `Workflow.make`, typed graph steps, Effect-backed interpreter | Core; nesting follows basic DAG |
| Approval, signals, suspension, resume, retry | [workflows](../vendor/swamp/design/primitives/workflows.md) | Persisted waits and decisions, durable timers, explicit retry policy | Core durability |
| Detached server runs, attach/cancel, capacity limits | [active_run_registry.ts](../vendor/swamp/src/serve/active_run_registry.ts) | Durable submission plus daemon-scoped execution, replayable event stream | Core |
| Versioned resources/files, tags, provenance, lifetimes | [data](../vendor/swamp/design/primitives/data.md), [data_writer.ts](../vendor/swamp/src/domain/models/data_writer.ts) | `Artifact.make`, immutable blob versions and catalog | Core |
| Metadata/content filters and projections | [data_query_service.ts](../vendor/swamp/src/domain/data/data_query_service.ts), [catalog_store.ts](../vendor/swamp/src/infrastructure/persistence/catalog_store.ts) | Schema-defined query AST, indexed SQLite metadata/JSON querying | Core |
| Extension manifests, dependency locking, bundles, providers, workflows | [extension_manifest.ts](../vendor/swamp/src/domain/extensions/extension_manifest.ts), [extension_loader.ts](../vendor/swamp/src/domain/extensions/extension_loader.ts) | GitHub release bundles, lockfile, `Extension.make`, provider Layers | Core |
| Vaults, sensitive output handling and redaction | [vaults](../vendor/swamp/design/primitives/vaults.md) | `SecretRef`, `SecretStore`, redacted diagnostics and explicit secret outputs | Core boundary; integrations later |
| Server authentication, grants, audit | [serve](../vendor/swamp/design/primitives/serve.md), [access-control](../vendor/swamp/design/enablers/access-control.md) | Local authenticated RPC, operation policy and audit records | Local core; team grants later |
| Cron scheduling | [schedule_catch_up.ts](../vendor/swamp/src/domain/workflows/schedule_catch_up.ts) | `WorkflowSchedule.make`, durable occurrence admission, pause/resume and schedule inspection | Implemented bounded scheduling; [remaining gaps](scheduling-api-draft.md#explicit-scope-and-parity-gaps) |
| Webhook triggers, workers and remote placement | [remote-execution](../vendor/swamp/design/enablers/remote-execution.md), [serve](../vendor/swamp/design/primitives/serve.md) | Trigger and Executor providers submitting through RunService | Later |
| Alternate datastores, synchronization and shared coordination | [datastores](../vendor/swamp/design/enablers/datastores.md) | BlobStore/Catalog providers; explicit transactional capabilities | Local core; remote later |
| Post-run reports | [report_types.ts](../vendor/swamp/src/domain/reports/report_types.ts) | Reporting tasks reading lake/run views and emitting artifacts | Later |
| Workspaces, dashboard, agent skills and launch UX | [surfaces](../vendor/swamp/design/README.md#surfaces) | CLI discovery and schema export first; optional agent/UI adapters | Later |
| Account gate, telemetry, updates and registry publication | [operations](../vendor/swamp/design/operations.md), [auth-gate](../vendor/swamp/design/surfaces/auth-gate.md) | No account dependency; explicit extension update commands | Not initial parity |

## How it is assembled

Swamp compiles a Deno CLI. Its CLI commands and server handlers consume shared `libswamp` async-generator use cases, with domain services and infrastructure adapters below them. The useful pattern to retain is a single application layer with machine-readable progress events, not command handlers calling other CLI commands. See [libswamp](../vendor/swamp/contributing/libswamp.md).

Schemas in the inspected Swamp model and manifest code use Zod. Workflow files and definitions use YAML, and expressions use CEL. Effectory will use Effect Schema and TypeScript specifications first. A future YAML/CEL importer must be an adapter to an explicit versioned graph format, not implicit evaluation of arbitrary strings throughout the runtime.

Swamp's catalog is a derived SQLite index beside artifact files. Queries use SQL prefilters followed by CEL evaluation, with lazy content loading. Its query service handles access filtering, historical/latest selection, and bounded results. Effectory should retain these semantics while starting with a smaller, fully specified query language. Arbitrary SQL is not the public boundary.

The server's active-run registry is an in-memory coordination structure with caps, cancellation controllers and completion promises. Persisted run records, claims and continuation services supply other lifecycle guarantees. An in-memory registry alone must not be mistaken for crash durability in Effectory.

Extension distribution is a substantial subsystem: manifests, versions, dependencies, bundled runtime code, installation transactions and collisions. Effectory's GitHub-first approach replaces the registry transport; it still needs integrity checks, lock resolution, activation and rollback semantics.

## Intentional differences

Effectory is a reusable library with a daemon adapter. Pure specs and service requirements remain usable without the CLI. Task errors and outputs retain their Effect Schema types. GitHub installation is explicit; a missing task never silently downloads and executes code. New workflows use typed task references, not Swamp's model-name normalization or CEL spelling rules.

Compatibility means covering these capabilities. Existing Swamp extensions, YAML definitions, databases and on-disk layouts will not run unchanged. Any migration tool is a separate deliverable with its own compatibility tests.
