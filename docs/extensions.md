# Extensions and workflow overrides

The focused [extension composition proposal](extension-composition.md) refines the author/host API, explicit selection and constrained workflow patches. Its separation of installed inventory from active application revisions clarifies the earlier lifecycle below. The older API example is exploratory; the focused proposal is also unimplemented and awaits design review.

## Distribution from GitHub

“Via gh” is interpreted as GitHub-hosted extensions, with the `gh` CLI used by the initial downloader for release metadata, authenticated downloads and private repositories. Keep it behind an `ExtensionSource` service so an HTTP adapter can replace it. Never shell-interpolate repository names or credentials; spawn `gh` with an argument array and inherit its authentication. Missing `gh` or expired authentication yields an actionable typed error.

The proposed source syntax is `github:owner/repo@tag`, optionally with a declared release asset name. Start with published ESM bundles plus a JSON manifest in a release archive. Source-only repositories require an explicit development build path later; installation never runs package lifecycle scripts. Effect and the Effectory extension SDK remain external peer dependencies supplied by the host; compatibility is checked before activation. Bundle other dependencies and retain the publisher's dependency inventory. Reject duplicate bundled Effect runtimes rather than relying on accidental service identity compatibility.

The [typed consumption refinement](extension-task-consumption.md) additionally requires a contract-only entry point and matching TypeScript declarations. Named exports generate a local `effectory.extensions.ts` facade so customers can pass extension task contracts directly to `graph.task`. Actual codecs and canonical shared dependencies must be retained; JSON Schema is insufficient for generating equivalent executable contracts.

A manifest contains `manifestVersion`, namespaced ID, semantic version, entrypoint, SDK compatibility, Effect compatibility, contributions, dependencies, requested capabilities and optional explicit replacements. Validate it with Effect Schema before importing code. Static metadata discovery must not evaluate the module.

The lockfile records repository, requested ref, resolved commit, release/asset identity, archive SHA-256, manifest digest, entrypoint, dependency graph and compatibility ranges. Tags are selectors, not immutable identities. Restoration uses the locked artifact and verifies its digest; if upstream replaced or removed it, fail rather than silently resolving a new release. A publisher checksum alone proves integrity only relative to that publisher; trust policy separately controls which repositories/digests may execute.

## Installation and activation

1. Resolve the explicit source and dependency closure. Reject incompatible versions, dependency cycles and ambiguous contribution IDs.
2. Download to staging, bound compressed and expanded sizes, verify integrity, and reject absolute paths, traversal, escaping symlinks and unexpected entries.
3. Validate manifest, runtime compatibility and requested replacement contracts. Inspect executable exports in a disposable validation process after trust policy permits evaluation; activation still treats code as privileged.
4. Move the verified bundle into immutable digest storage. Write a new lockfile candidate and registry revision. A failed stage leaves the old revision active.
5. Persist an activation intent referencing the lockfile digest; atomically replace the lockfile; commit the active registry pointer. Startup reconciles interrupted intents by digest before starting new runs. Filesystem and SQLite writes are not assumed to be one atomic transaction.
6. New runs use the new revision. Existing runs retain their original registry and bundles. Rollback changes only the default revision. Refuse deletion of bundles referenced by active/recoverable runs.

Updates are explicit and display changed commits, permissions and replacements. No auto-download occurs during task resolution. Cache verified archives so locked restores can operate offline. Installation and removal take the registry mutation lock and compare an expected revision to prevent lost updates.

## Extension API

Proposed shape, with previously declared specs and Layers supplied by the author:

```ts
const ExtensionSpec = Extension.make("example/greetings", {
  version: "1.0.0",
  tasks: GreetingTasks,
  workflows: [Welcome],
  artifacts: [Greeting],
});

const ExtensionLive = ExtensionSpec.toLayer({
  tasks: GreetingLive,
  workflows: Welcome.toLayer(),
});
```

An extension may contribute namespaced tasks, workflows, artifact types, configuration schemas, trigger adapters, reports and provider implementations. The host compiles these into a registry before constructing Layers. Avoid a module import that mutates a process-wide registry.

## Override contracts

| Slot | May change | Must preserve |
| --- | --- | --- |
| Task implementation | How a particular task is performed | Original input/success/error/output contract and replay policy |
| Executor | Local process or later remote placement | Cancellation, attempt identity, authenticated result and artifact protocol |
| Retry policy | Error classification, bounded backoff | Persisted attempt accounting and declared replay safety |
| Scheduler policy | Fairness, priorities and per-tenant limits | Dependency ordering, admission bounds and no double claim |
| SecretStore | Environment or external vault integration | Reference identity, redacted access and authorization |
| BlobStore / Catalog | Storage implementation | Atomic publication contract, query semantics, retention and consistency capabilities |
| ExtensionSource | GitHub or another source transport | Immutable resolution and digest verification |
| Trigger | Cron, webhook or external event | Validated submission with stable deduplication key |
| Observer / reporter | Telemetry or derived reports | No mutation of committed events or successful result state |

Replacement is opt-in in host configuration: target slot/task, provider ID, expected contract version and scope (runtime, workflow, or task where supported). Unspecified slots use defaults. Multiple selections for one slot are an error; load order is never precedence. A per-task SecretStore selection can be scoped through `Layer.provide`; repository-wide Catalog replacement cannot be safely changed for only one task. State-bearing provider changes require a migration and drain, not hot replacement.

Middleware has explicit order and typed scope. Suggested task chain is trace, policy validation, deadline, then execution; activity retry is owned by the engine around an individual attempt. Hooks receive sanitized immutable events. Observers are bounded and failures are diagnostic; policy/transform hooks are explicit execution steps whose failures fail the run. Do not create a generic hook that can rewrite the journal or bypass validation.

## Trust boundary

In-process JavaScript is privileged. A declared capability list documents intent and supports host policy; it is not a sandbox for arbitrary imports, filesystem access or network calls. Only trusted providers load in the daemon. A worker process improves crash and cancellation isolation but also needs OS enforcement before it can run untrusted code. Authoritative run state transitions, schema validation and access checks are host invariants, not replaceable lifecycle hooks.

Store secret references in config and runs, resolve them only for execution, and use Effect redacted values in diagnostics. Do not serialize plaintext secrets in inputs, events, errors or artifacts. Sensitive outputs require an explicit secret sink. Redaction cannot detect every transformed secret; extensions must obey the contract and contract tests must exercise failures as well as successes.
