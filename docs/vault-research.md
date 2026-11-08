# Vaults and secrets — research brief

Status: research and API design; **not user-approved and not implemented**. This follows the completed live-console slice. No proposed names or behavior below are an accepted public contract.

## Outcome to design

A customer should be able to provision a named vault, put a credential into it without committing the value or passing it in a command-line argument, and read it from an ordinary Effect task. The same task should work with an encrypted local vault, an extension-supplied provider, and a test Layer. A resumed or retried task must read current credentials without serializing those credentials into durable workflow inputs or results.

The user's design constraints remain: specs, implementation as a second argument where appropriate, Effect Schema boundaries, ordinary Context/Layer/Scope ownership, and no capability added to the task context when DI can supply it. Public APIs require Claude Effect and consumer review before presentation, then explicit user approval before implementation.

## Source evidence

- Swamp's [vault design](../vendor/swamp/design/primitives/vaults.md) describes named local and extension providers, get/put/list and optional delete, annotations, refresh hooks, presence checks and access scoping. The actual base interface is [vault_provider.ts](../vendor/swamp/src/domain/vaults/vault_provider.ts). Local encrypted storage and key-source configuration live in [local_encryption_vault_provider.ts](../vendor/swamp/src/domain/vaults/local_encryption_vault_provider.ts).
- The vault design's Workflow Integration section (around lines 1360–1388) states that each delivered read is fresh, each attempt receives fresh values, and skipped steps do not read. It does not cache values across a run. The Secret Handoff section states that values are not put into the process environment automatically.
- Swamp's vault feature also includes managed redaction and sensitive outputs. Its Security Considerations section (around lines 1441–1506) describes per-operation authorization and workflow vault allow-lists, and redaction of resolved values from logs and artifacts. A lookup-only implementation would not establish parity with these parts.
- Effectory currently has no vault service, schema, registry entry, RPC or CLI group. [Application](../packages/core/src/application.ts) captures revision services and wraps task execution; [Task](../packages/core/src/task.ts) supplies Tag.Values and ArtifactStorage per invocation, including task-local Layer acquisition, with an isolated memo map. [The ownership audit](runtime-ownership-audit.md) records the actual lifetimes and restart behavior.
- [task-logger.ts](../packages/platform-bun/src/task-logger.ts) stores bounded JSON log payloads. It has no secret registry or value-based redactor. [execution-boundary.ts](../packages/platform-bun/src/execution-boundary.ts), task success/error encoding, durable activity results and lake publication are separate persistence boundaries. A logging-only mask would not cover them.
- [Backup](../packages/platform-bun/src/backup.ts) copies the repository offline, including ordinary `.effectory` files other than its explicit exclusions. A new local vault key under that tree would therefore be copied with its ciphertext unless the contract changes. Encryption with a colocated key does not protect against someone reading the entire repository or backup.
- Extension facades already export additional public contracts through `.exports`; extension task/implementation service requirements are accumulated by Application. An extension-provider design must show the installed consumer path, not just a standalone factory.

## Effect primitives and a probe

Pinned Effect 4.0.5 provides `Redacted`, `Config.Redacted`, `Config.schema`, `ConfigProvider.make`, `Schema.Redacted`, and `Schema.RedactedFromValue`. Use them instead of inventing a redacted container, custom codec combinators or ambient async-local lookup.

`ConfigProvider` is read-oriented and hierarchical; it has no put/delete/administration contract. Its default Context.Reference reads the process environment. A vault read must select its provider explicitly; silently falling back to environment variables would repeat the rejected tags design. Consider Config as a deliberate adapter, not automatically the primary vault API.

A scratch probe on 2026-11-05 used the installed Effect and the actual SDK `boundary.encode` with a fixed non-secret test value. Results:

| Schema/path | Result |
| --- | --- |
| `JSON.stringify(Redacted.make(value))` | `"<redacted>"` |
| `Config.Redacted("API_KEY").parse(explicitProvider)` | Produces a real Redacted value |
| `boundary.encode(Schema.Redacted(Schema.String), value)` | Rejected by the JSON boundary |
| `boundary.encode(Schema.RedactedFromValue(Schema.String), value)` | Encodes the plaintext string |
| The same with `{ disallowEncode: true }` | Rejects encoding |
| `boundary.encode(Schema.toCodecJson(Schema.Redacted(Schema.String)), value)` | Encodes the plaintext string |
| The same with `{ disallowJsonEncode: true }` on Redacted | Rejects encoding |

This proves that redacted inspection does not imply safe durable serialization. It does not test a vault implementation, inference for an invented API, or redaction of an explicitly unwrapped string. No real credentials were used and no production source was changed.

## Candidate authoring direction for critique

Prefer a named spec with an Effect-backed provider, ordinary yielded reads, and explicit registration. Two candidate spellings need evaluation before a contract is selected:

```ts
// Illustrative only: none of these Vault APIs exists.
const Credentials = Vault.make({ id: "credentials" }, localProvider);
const token = yield * Credentials.get("github-token");
// token: Redacted<string>; the caller explicitly unwraps it at an I/O boundary.

// Alternative: keep one yielded service and pass an explicit definition.
const storage = yield * VaultStorage;
const token = yield * storage.get(Credentials, "github-token");
```

The second-argument provider should be built from ordinary Effect Layers or Effects. It must not hide dependencies or cause secret reads when a pure spec is constructed. `Application.make({ vaults: [...] })` is a candidate registration point, not a settled choice. Compare whether a spec/implementation split is necessary for extension contracts, as with Task.contract/implementation, or whether normal service injection can express the entire selection without another registry abstraction.

Do not make a concrete secret value part of a spec. Resolve provider bootstrap credentials through ordinary Effect Config or operator-owned services. A vault may use the environment explicitly to authenticate its provider; a missing requested secret must never silently read an environment variable of the same name.

## Decisions the contract must settle

1. **Consumer surface and types.** Named definition reads versus a yielded storage service; string values wrapped in Redacted versus typed secret definitions; missing values as typed NotFound or Option; task error mapping that fits Task.make without repetitive boilerplate. Show a complete compiling task, test substitution and installed-extension use.
2. **Provisioning and lifetime.** Which Layer owns provider clients, how provider requirements reach Application, whether default service provision occurs inside Task.execute, and how task-local overrides interact with captured revision services. Provider clients may live for a revision; credentials returned from a get must not be eagerly cached there. Define reads during task-local acquisition and finalization and what happens if code retains the service beyond its invocation.
3. **Local encrypted storage.** Key generation or external key source, authenticated encryption, atomic replacement, restrictive paths/permissions, missing/corrupt key behavior, and backup/restore. Pick an explicit supported model; do not silently generate a replacement key when ciphertext already exists. State what encryption does and does not protect.
4. **Administration.** Named vault discovery, secret key listing, put and delete, a deliberate raw reveal/get path if needed, stdin/file input rather than a `--value` argument, payload limits, capability checks, RPC Schema boundaries and typed errors. Distinguish operator mutation from task-side writes. Idempotency must not persist plaintext in request receipts or unkeyed hashes of low-entropy secret values.
5. **Durability.** Persist identifiers and provider selection, not loaded values. Old runs use their pinned provider code but current backend values. Restart, retry and rotation tests must prove this; completed durable activities must not be recomputed merely to obtain a fresh credential. Never suggest a task should return a credential to feed a graph edge.
6. **Redaction and boundaries.** Decide which managed paths are actually protected and how, including logs, progress, errors, activity results and artifacts. Ordinary Redacted inspection is not value-based scrubbing. Explicitly unwrapped or transformed values, raw console output, HTTP clients and binary artifacts require an honest contract. Avoid silently rewriting successful typed results or binary content and thereby breaking schemas/digests. Secret-bearing schemas, opaque references, output rejection and bounded registered-value scrubbing have different tradeoffs; compare them before choosing.
7. **Access.** Current runtime is a trusted, single-owner local process; extensions are privileged. Define any task/workflow allow-list as a contract guard, not an in-process security sandbox. Do not claim multi-user authorization or remote isolation that the host does not have.
8. **Scope versus parity.** Local encrypted storage, task consumption, interchangeable extension providers and practical CLI administration make this a useful slice. Inventory any omitted Swamp behavior explicitly: annotations, refresh hooks, migration, field-level sensitive outputs, remote workers or team grants. Choose omissions based on the consumer contract, not merely on ease of passing tests.

## Required evidence before implementation approval

- Type-check the exact proposed consumer signatures, including service preservation, generic helpers, provider dependencies, test Layers and installed-extension contracts. Label any stand-ins as feasibility evidence only.
- Probe Redacted/config codecs and chosen persistence rules against pinned Effect, including invalid provider output and error paths without leaking a test canary.
- Trace every persistence and telemetry path affected by the promise, including old-run restart and concurrent task Layers. If a promise cannot be made, narrow that promise visibly rather than hide the gap.
- Specify crash points for local put/delete/key creation and receipt retries, plus backup/restore and no-secret-in-bundle/SQLite/event evidence.
- Use temporary fixture values only. Do not access real vault accounts, environment credentials, user keys or live secret stores for design probes.

No implementation is authorized by this brief. The next output is a reviewed public contract and its user decisions.
