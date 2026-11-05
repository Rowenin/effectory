# Effectory design

The bounded v0 implementation is now available. Start with the [runnable README](../README.md), [implementation status](implementation-status.md), and [release checklist](release-checklist.md). Earlier design notes are grounded in the [pinned sources](../vendor/README.md); examples labelled “proposed” remain design context, not executable quick starts.

The selected direction is [graph authoring with Effect-based construction](authoring-runtime.md): `Task.make(spec, handler)` and `Workflow.make(spec, constructionEffect)`. The runtime and graph types are implemented in `packages/`; the README and exported schemas describe the current surface.

[Pausing and input](pausing-and-input.md) proposes approval, input and signal primitives, grounded in Swamp's implementation. [CLI commands and server RPCs](cli-server-api.md) define the current control-plane proposal. The broader [library/MCP draft](control-plane-api.md) is retained as exploration. The [edge runner proposal](edge-runtime.md) continues to describe application loading; its older constructor syntax is superseded.

The [five alternatives](authoring-api-options.md) and [Claude review](authoring-api-review-claude.md) record the design exploration.

The [implementation roadmap](implementation-roadmap.md) is the entry point for the five subsequent planning passes: [graph composition](graph-composition.md), [task implementation](task-implementation.md), [extension composition](extension-composition.md), [durability and recovery](durability-and-recovery.md), and bounded first-release delivery. These refine the earlier notes as proposals; they do not establish accepted syntax or tested runtime guarantees.

[Using extension tasks](extension-task-consumption.md) fills in the consumer path: GitHub installation, typed imports, composing with local tasks and application selection.

## Reading order

1. [Swamp analysis](swamp-analysis.md): observed features, code paths, parity scope.
2. [Architecture](architecture.md): ownership, packages, Layers, schema boundaries.
3. [Specification API](spec-api.md): `Thing.make()`, implementations, composition.
4. [CLI commands and server RPCs](cli-server-api.md): public methods and Swamp coverage; [daemon and RPC](daemon-rpc.md): transport and process lifecycle.
5. [Execution](execution.md): background work, replay, cancellation and recovery.
6. [Extensions](extensions.md): GitHub installation and explicit override contracts.
7. [Data lake](data-lake.md): immutable data, schema versions, queries and retention.
8. [Implementation roadmap](implementation-roadmap.md): milestones, scope and proof gates; [earlier delivery plan](delivery-plan.md) records the initial sequence and observed scaffold checks.

## Design commitments

- The library owns semantics. CLI and RPC call the same services.
- Specifications describe contracts; handlers and infrastructure are Layers.
- Effect Schema defines every external and persisted boundary.
- A durable submission survives a disconnected CLI and a restarted daemon.
- Extensions can add tasks and replace selected providers explicitly.
- Lake data is versioned, inspectable and queryable through the same API locally and remotely.

The selected starting point is one Bun daemon per repository, SQLite persistence, local blob storage, and Effect 4.0.5. These are the current implementation choices. Distributed execution and Swamp file compatibility are later work. GitHub is the initial extension distribution source, without a hosted registry requirement.

Current executable evidence: [implementation status](implementation-status.md). Operational recovery: [offline backup and restore](backup-restore.md). Earlier design documents remain useful context but may contain deliberately deferred capabilities; runtime schemas and the current README define the implemented v0 surface.
