# Artifact reader implementation sequence

Status: implemented and verified, 2026-11-06. Typecheck, formatting/lint and the stable full suite pass: 383 tests, 2,902 assertions. The user approved the complete reviewed reader proposal and retention/scheduling amendments.

## Existing integration points

- `packages/core/src/report-state.ts` binds host History implementations to runtime objects through a private WeakMap. `task.ts` looks up that binding on the original runtime object, then provides the service inside `definition().execute`. Use that private binding pattern for the reader; no additional public Task.RuntimeContext field is needed merely to connect the host. A binding lookup on the copied runtimeSnapshot would miss the original key.
- `task.ts` already excludes Tag.Values, ArtifactStorage and History from task/implementation requirements, including requirements introduced by task-local Layers. Add the approved reader to every matching exclusion. Keep declared reader errors explicit; taskLayer already preserves declared domain errors.
- `publication-lifetime.ts` owns detached operation children, supplies a fresh Layer MemoMap, and closes before successful or failed task-local Layer acquisition releases resources. Readers need that same shutdown boundary, but cannot blindly reuse its Fiber.join path for author decoding: the approved design direction observes a codec child's Exit through Fiber.await and sanitizes it, including interruption/finalizer defects.
- `interpreter.ts` builds one task runtime per attempt and fences its publications through the attempt's active state. Its private reader binding and bytes publication closure must share one admission owner. Supplying the service outside task.execute would give captured application services the wrong override precedence.
- `lake-binary.ts` currently takes its four-writer semaphore before consuming the source. Under the reviewed proposal, the shared invocation reservation must precede this call, and remain held while its source pulls the invocation's reader. Do not create a second pool independently in either bridge. This scheduling amendment is approved.
- `Task.test` builds its publisher and synthetic references locally. Its shared artifact store must feed both the default reader and publisher. `Report.test` returns Task.test's result, so forwarding artifacts also returns the new collection without a parallel recorder.

These integration constraints were applied to the implementation. The public method signatures remain in the approved proposal; executed checks are recorded in [implementation evidence](artifact-reads-implementation.md).

## Implementation sequence

1. **Core schemas and pure query logic.** Move the existing query schemas without changing their runtime identities or wire grammar. Isolate Effect-only schema definitions from the convenience stream helper so the reader and fixture code do not create a value-import cycle. Extract validation, predicate evaluation, ordering and projection from the current lake adapter; retain its latest-before-filter, null/missing, limits and error mappings. The already implemented SQL candidate narrowing stays a host concern.
2. **Private ownership and binary admission.** Implement the reviewed admission policy and read-operation shutdown path before adding I/O. Test grant/cancel/close races, shared publication/read ownership, and partial Layer acquisition cleanup. Keep the caller's interruption distinct from a closed stream and a sanitized codec failure. The exact concurrency behavior must match the approved final proposal, not an earlier review suggestion.
3. **Persistent acquisition and protection.** Add version dependencies keyed by consumer run and exact version, with immediate transactions and bounded contention retries. Preserve same-run/report-source exemptions. Add the private indexed report-source projection or another proven equivalent, with atomic backfill and status/retry maintenance. Reclamation must re-check current protection at apply time. Do not change byte receipts or POSIX download behavior.
4. **Host reader operations.** Implement metadata/latest resolution and synchronous verified JSON reads first, then owned byte streams and verified whole-byte reads, and finally paged queries/stream helper. Resolve authorization and pinning before exposing metadata/content. Put author decoding outside transactions and binary permits. Bind the resulting service and ownership into every attempt, including reports and extension implementations.
5. **Harness and API proof.** Add the approved fixture constructor and Task.test/Report.test handoff against the same pure query semantics. Preserve exact exported synthetic references, allocate aliases after seeds, own content copies and enforce the agreed identity/timestamp rules. Compile and execute the proposed authoring examples and negative type cases against the real SDK. Hand-written fakes remain ordinary Layers with their own limitations.
6. **Operator metadata and distribution.** Add only the approved optional reclamation/version protection fields. Regenerate host module loaders, verify installed-extension imports and canonical module identities, document rebuild/upgrade behavior, and update the public lake/authoring examples. The existing CLI read/download surface remains separate from task consumption.
7. **Integration verification.** Run the proof matrix below and required typecheck, formatting/lint and full suite. Update implementation status only with actual results. Continue the larger parity inventory after the approved slice is complete.

## Evidence that must come from the implementation

| Boundary | Required proof |
| --- | --- |
| Effect types and Layers | Exact inferred JSON/ref types, explicit read errors/retry tags, no leaked runner requirement, task-local fake precedence, application fake overridden, partial acquisition cleanup |
| Codec trust boundary | Throwing/async decoder, malicious issue text, interrupted finalizer defect, caller cancellation, no unsafe cause/log persistence |
| Stream lifetime | EOF integrity versus early stop, typed Closed on invocation shutdown, prompt cancellation of queued operations, no descriptor or fiber left after Layer release |
| Binary ordering | Real createBinaryStorage copy and read-then-publish scenarios under saturation; no read/write pool inversion; the approved local queue and overload behavior |
| Persistent pinning | Engine/host connection contention, retries outside transactions, repeat reads, cap/exemptions, plan→pin→apply race, wait/retry/process restart, terminal release |
| Report protection | Armed-before-materialization hold, all unsettled/settled statuses, retry after a reclaimed gap, bounded cancellation, more than 1,024 source publications, projection migration/rollback/crash recovery |
| Query semantics | Shared evaluator, latest before filtering across schema changes, pinned snapshots, cursor identity/expiry, broad-budget failures, indexed source/tag narrowing |
| Fixtures | Read own publication, exact producer→consumer handoff, threaded producers, seeded alias allocation, mixed timestamps, independent copies, Report.test source query |
| Distribution | Installed extension definition/service resolution, application bundling, actual daemon restart, ABI/old-runtime refusal |

The scratch scale evidence in [artifact-reads-evidence.md](artifact-reads-evidence.md) supports a source-indexed protection lookup. It does not replace the migration, crash and actual reclamation proofs above. The pre-reader baseline was 356 passing tests. Reader type, ownership, persistent-store, daemon-restart and installed-extension tests now exist; the final stable full run passes 383 tests with 2,902 assertions. See the evidence document for exact results and limits.
