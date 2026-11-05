# Architecture and boundaries

The consumer-facing entry point and loading contract are defined in [Customer applications and the edge runner](edge-runtime.md). The initial application needs one `effectory.ts`, not a separate config file and bootstrap.

## Ownership

The CLI uses the schema-defined RPC client. RPC handlers call application services. Embedded library users call those same services directly. The engine runs task implementations against service Layers; the lake stores their results. Only the daemon owns repository execution and writable runtime state by default. An embedded runtime must acquire the same exclusive repository lease before using that storage, or use an isolated store.

Proposed package boundaries:

| Package | Responsibility |
| --- | --- |
| `@effectory/core` | Specs, identifiers, errors, schema codecs, service contracts |
| `@effectory/runtime` | Registry compilation, RunService, workflow interpreter, engine adapter |
| `@effectory/lake` | Artifact publication, catalog, query AST, retention |
| `@effectory/extensions` | Manifest/lockfile, GitHub source, verification, activation |
| `@effectory/rpc` | Shared procedure definitions, client and handler adapters |
| `@effectory/platform-bun` | SQLite, filesystem, processes, crypto and daemon hosting |
| `@effectory/cli` | Argument parsing, RPC calls, human/JSON rendering |

Core must not import Bun or CLI modules. Task packages depend on core and Effect; application code chooses providers. There is no global mutable task registry.

## Layer construction

Compilation validates all specs, handlers, references and selected overrides before acquiring runtime resources. It produces a registry revision, including extension digests and configuration identity. The scoped runtime then acquires storage, the engine, workers and the RPC listener. `Layer.provide` supplies requirements; `Layer.mergeAll` composes independent services. Dependency types must stay visible until the final platform Layer satisfies them.

Use stable `Context.Service` identifiers for infrastructure contracts: `RunStore`, `ArtifactStore`, `Catalog`, `SecretStore`, `Executor`, `Clock`, `ExtensionSource`, `Authorization` and `RunEvents`. Keep policy declarations separate from I/O implementations. A fake provider can implement the same contract in tests. Registration Layers alone are not a duplicate-detection mechanism; the spec compiler owns that validation.

## Schema boundaries

Every boundary has a schema, a version and size limits: CLI JSON, RPC requests, responses and typed errors, extension manifests, config, graph definitions, queued inputs, task successes/errors, events, artifact metadata and query plans. Decode unknown input before use, and encode output before publishing it. Reject unexpected fields in control records to catch misspelled settings.

Use branded identifiers for run, task, workflow, artifact and repository IDs. Tagged error unions distinguish invalid input, missing definitions, conflict, unauthorized access, unavailable storage and execution failure. Defects become a sanitized internal-error response with a correlation ID; stack traces stay in protected diagnostics. Schema encode/decode service requirements must be satisfied explicitly. Boundary schemas should normally require no services.

JSON Schema export helps discovery, but it is not a serialization format for arbitrary Effect Schema transformations or executable handlers. Persist schema identity/version and encoded JSON, and retain the pinned codec implementation. A changed decoder requires migration or a new schema version.

## Repository layout

Proposed tracked files: `effectory.ts` (the default-exported Application), task/workflow modules, `effectory.extensions.json`, and `effectory.lock.json`. Proposed runtime state: `.effectory/state.sqlite`, `blobs/`, `extensions/<digest>/`, and private daemon connection metadata. Never store credentials in the tracked configuration.

The SQLite database is authoritative for submissions, events, artifact metadata, and activation records. Blobs hold immutable bytes. Backups must capture a consistent database snapshot plus referenced blobs and extension bundles. A metadata index may be rebuilt; the authoritative run journal cannot be reconstructed just by scanning blobs.

## Effect source basis

The pinned [Rpc](../vendor/effect/packages/effect/src/rpc/Rpc.ts) describes payload, success, errors, middleware and annotations. [RpcGroup](../vendor/effect/packages/effect/src/rpc/RpcGroup.ts) composes definitions and derives typed handler Layers. [Workflow](../vendor/effect/packages/effect/src/workflow/Workflow.ts) and [Activity](../vendor/effect/packages/effect/src/workflow/Activity.ts) already supply execution contracts and recorded activity results. Build adapters around these, retaining domain-specific registry, lake and run lifecycle contracts. The workflow/RPC APIs are marked unstable upstream; pin Effect and test upgrades.
