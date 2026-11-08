# Vault research: persistence boundaries

Status: source analysis and scratch probes on 2026-11-05. This supplies evidence for [vault API research](vault-research.md), not an implementation or an approved security contract.

## Existing write paths

| Path | Actual source | Consequence for the vault design |
| --- | --- | --- |
| Run submission input and labels | `host-store.ts`, `submitRun`, inserts `inputJson` and `tagsJson` and the admission fingerprint | Resolving a credential in the CLI and sending it as workflow input persists it before a task starts. A vault handle/reference must remain distinct from the loaded value. Tags are metadata, not secret storage. |
| Per-task durable input | `interpreter.ts`, `invokeTask`, input encoding; graph task node's captured input Activity | Supplying a secret as an ordinary graph reference is not a transient handoff. Task-side lookup avoids this path. |
| Success and declared failure | `Task.make` checks encoded success/error, then `interpreter.ts` encodes again into `Activity.make` success or `ExecutionFailure.detail` | A guard only inside Task.make cannot by itself prove that the later encoding is safe: arbitrary user codecs can run again. Enforce a guarantee at the final encoded write boundary, or constrain the supported contract and state it. |
| Logs | `task-logger.ts`, `message`, `Logger.make`, `store.telemetry` | JSON normalization and size checks are present; secret-value registration and scrubbing are absent. The logger receives the task error and log message separately. |
| Progress | `interpreter.ts`, `taskContext.progress`, `store.telemetry` | A display-only change would be too late: progress is already persisted. The eventual guard must operate before telemetry storage. |
| JSON artifacts | `task.ts`, `contextFor`, `storageFor`; `lake.ts` publication | The schema may encode to plaintext before lake publication. Both the legacy context adapter and yielded ArtifactStorage reach this path. |
| Binary artifacts | `task.ts`, `storageFor`; `lake-binary.ts` | Redacted inspection is irrelevant to bytes. Any promised value-based prevention must account for a match across stream chunks, or explicitly exclude binary payloads. Never mutate bytes silently: digest and retry identity depend on them. |
| Graph computed values, branches, child workflows and final result | `interpreter.ts`, node/result encoding and durable Activity calls | Protecting only leaf logging does not establish that every durable result is secret-free. A successful secret-bearing leaf result must be rejected or represented safely before later graph operations can consume it. |
| Runtime errors | `execution-boundary.ts`, `hostFailure`; interpreter's TaskRuntimeError mapping | TaskRuntimeError messages are copied into durable host failures. Provider errors must not embed raw response bodies, credential contents or a caught exception string by default. |
| Definitions and revision bundles | `application-bundle.ts`, `revisions.ts`, retained manifests/bundles | Reading a secret at module initialization or embedding a literal in a definition is outside a lazy task lookup's protection. A pure named definition must not load a value. |
| Backup | `backup.ts`, `excluded`, file-copy manifest | A repository-local encryption key follows the normal backup unless explicitly excluded. The copied key/ciphertext pair remains privileged data. An external-key model changes portability and recovery requirements. |

These rows are source facts about distinct boundaries, not a claim that any proposed redactor covers them. Trusted application code can explicitly unwrap and transform a secret, use arbitrary filesystem/network APIs, or bypass managed loggers. A library API cannot make that code a sandbox.

## Additional scratch probe

Using installed Effect 4.0.5, actual SDK boundary.encode, and a fixed dummy canary:

- `Schema.Struct({ secret: Schema.RedactedFromValue(Schema.String) })` encodes the wrapped canary to a plaintext JSON property.
- `Schema.Struct({ secret: Schema.Redacted(Schema.String) })` is rejected by the current JSON boundary instead.
- Invalid integer decodes through `Schema.RedactedFromValue(Schema.Int)`, `Schema.Redacted(Schema.Int)` and `Config.schema(Schema.Redacted(Schema.Int), "TOKEN")` all fail; `Cause.pretty` did not contain the canary in these three probes.

The last result is narrow: it does not prove every custom Schema check, provider failure, formatted cause or persisted error is safe. No production code changed, no live credentials were accessed, and no proposed Vault API was typechecked by these probes.

## Design implications to resolve

Prefer task-side lazy loading over secret-bearing graph input/result values. Keep live provider clients separate from loaded credentials. State precisely whether a supported path supplies redacted inspection, rejects secret-bearing persistence, scrubs known values, or stores an opaque reference; these are different guarantees.

If a managed persistence guard is selected, it needs invocation ownership through the final success/error encoding, not merely through the author's handler. Normal completion, failed Layer acquisition, finalization, retries, retained service captures and concurrent invocations all need evidence. A skipped/completed durable activity does not reacquire its Layer on replay, so no design may assume replay reloads all prior secrets into an in-memory redaction registry.

Do not put raw credentials or unkeyed secret hashes in idempotency receipts. Define mutation retry semantics together with encrypted local storage; a receipt must not become a second secret store by accident.

## Mutation-receipt feasibility

The existing extension journal is not a safe template to copy unchanged for secret writes: `extension-journal.ts` computes its fingerprint with `canonical(encode(ExtensionChange, request))` and stores both that string and `requestJson`. This is appropriate for extension coordinates, but applying the same pattern to a secret-bearing request would retain the secret twice.

A separate scratch probe used only a generated in-memory key, fixed dummy strings, Node-compatible crypto and a Bun in-memory SQLite database. It encrypted the value with AES-256-GCM, authenticated an identity tuple as associated data, and used a keyed HMAC for the mutation comparison. Both ciphertext and receipt were changed in one SQLite transaction. The probe established:

- the synthetic value round-tripped;
- inspected ciphertext/receipt rows contained no plaintext canary;
- retrying the same payload produced the same receipt comparison value, while a changed payload did not;
- trying to decrypt under a different vault identity was rejected;
- a failed receipt insert rolled back the candidate ciphertext update.

This is feasibility evidence, not an encryption-format decision or a security review. The sketch reused one ephemeral key; a production design must specify separate encryption/MAC key purposes, key storage and derivation, envelope validation, nonce management, constant-time comparisons where needed, key loss/replacement, rotation and receipt retention. An in-memory transaction test proves neither filesystem durability nor recovery after process death. It used no files or actual secrets.

The remaining design question is how local atomic writes and remote provider writes differ. A remote provider cannot join the host's SQLite receipt transaction. A provider API must state its idempotency support or expose uncertain completion; local transactional evidence cannot justify an exactly-once promise for extension backends.

## Matching-cost and scheduling feasibility

The current default JSON boundary is 1,048,576 bytes, 100,000 values and depth 64 (`core/src/json-budget.ts`). Lake JSON publication also uses a 1 MiB cap. Telemetry uses a smaller 8 KiB payload cap in host-store, while taskLogger limits individual message normalization to 2048 bytes. These limits must be checked before an additional scan; the scanner must not become an unbounded pre-validation pass.

A macOS/Bun 1.4.3 scratch benchmark scanned approximately 1 MiB of ASCII text against 256 synthetic strings using ordinary `String.includes`, with five samples per case:

| Case | Tracked bytes | Median / maximum milliseconds |
| --- | --: | --: |
| Short absent values | 3,840 | 19.499 / 19.978 |
| Long absent values | 1,048,320 | 20.397 / 21.986 |
| Long absent values sharing the payload's repeated prefix | 1,048,320 | 21.978 / 23.079 |
| Match only at the final registered value | 3,840 | 26.326 / 26.328 |

These are measurements of a simple stand-in, not a worst-case bound or production performance claim. They exclude JSON encoding, Unicode/escaped variants, decoded-value traversal and concurrent load. There is no need to invent a trie or regex matching language merely to establish feasibility, but doing the entire scan synchronously can monopolize the daemon for tens of milliseconds.

A second probe used actual Effect fibers with the same 256-value scan. Without cooperative yields, a sibling Effect fiber made zero turns during the scan (36.407 ms total including setup). Yielding with `Effect.yieldNow` after each eight comparisons allowed 15 sibling turns during the scan (37.861 ms total). This supports an internal cooperative scan at async persistence boundaries. It does not make the existing synchronous Logger callback asynchronous, and it does not establish a time bound for any individual comparison.

If the guard yields, it must scan an owned serialization and persist that same representation (or its private decoded copy). Scanning a mutable object and returning it for later serialization would allow a concurrent producer to change it after the guard, just as producer-owned binary buffers can change after hashing. This is an implementation obligation to carry into the contract resolution; no production scanner has been written.
