# ArtifactReader implementation evidence

The user approved the complete reviewed contract on 2026-11-06. The implementation adds the six-method Effect service, query stream helper, durable first-access protection, pending-report protection, shared binary admission and fixture handoff. See the [usage guide](artifact-reads.md), [runnable application](../examples/artifact-reads/effectory.ts) and [approved contract](artifact-reads-api-draft.md).

## Implementation boundaries

`ArtifactReader` is provided inside each task invocation, including task-local Layers, extension tasks and report tasks. Reusable helpers retain the service requirement; task definitions exclude the runner-owned requirement. Reader errors stay explicit in the task's declared error schema. A task-local fake follows ordinary Layer precedence.

The core reader owns operation fibers and byte streams. It observes decoder children with `Fiber.await` and discards unsafe codec failure details. Invocation shutdown fails streams with `Closed`, interrupts owned work and waits for cleanup before releasing task-local Layers. The same private invocation owner wraps every binary publication before the existing writer permit; readers pulled by a publication reuse that owner.

The lake resolves and pins exact versions in an immediate SQLite transaction, with a bounded retry for competing connections. Pins are unique per consumer/version, survive process restart and stop protecting when the consumer becomes terminal. A small cleanup queue removes terminal pins in batches of 256. Missing consumer records retain protection conservatively. An indexed report-hold projection is maintained in the transaction that changes each report and backfilled during startup. Reclamation rechecks all three protection sources before tombstoning a version.

Query schemas are shared by core and runtime as the same objects. Production and the test harness use the same pure query evaluator; SQL candidate narrowing remains in the host. Fixtures own their content and preserve exported references, including legacy synthetic test aliases. `Report.test` forwards fixture collections to `Task.test`.

## Executed coverage

| Boundary | Repository evidence |
| --- | --- |
| Types and DI | `packages/core/test/artifact-reader-types.ts` checks exact JSON/reference inference, wrong kind/schema rejection, explicit errors, stream cursor ownership and application requirement removal. Core runtime tests check task-local replacement; the runner test acquires a reader in a task-local Layer. |
| Fixture and query behavior | `packages/core/test/artifact-reader.test.ts` reads own publications, threads fixture collections through producer/consumer tests, pages queries, preserves synthetic references, rejects identity collisions, checks mixed explicit/default timestamps and owns byte copies. |
| Decoder and stream ownership | The same core tests execute asynchronous and throwing codecs, interrupt a decoder whose finalizer contains a canary, reject captured handles after close and fail an escaped stream before task Layer cleanup. |
| Binary scheduling | `packages/core/test/binary-admission.test.ts` exercises FIFO handoff, first-waiter interruption, finite-read queueing, all-open-stream rejection, grant/cancel races and cleanup before slot reuse. Real lake tests complete saturated copy and read-then-publish fan-out; the harness completes eight-way copies with the four-writer bound. |
| Durable protection | `packages/platform-bun/test/artifact-reader.test.ts` covers plan→pin→apply, repeat reads, 1,024-pin enforcement, same-run/report-source exemptions, terminal cleanup, report status transitions and a competing SQLite connection's write lock. |
| Reader error/query contract | The lake tests distinguish wrong schema/digest/principal, corrupt content, reclaimed identities, malformed query/cursor and reclamation cursor expiry. Partial byte consumption and full integrity verification have separate assertions. |
| Actual execution | `artifact-reader-execution.test.ts` runs a producer, a consumer task-local Layer and an automatically admitted reporter through the real runner and storage. |
| Process recovery | `artifact-reader-daemon.test.ts` publishes through the CLI, pins before an approval, kills the daemon, restarts and verifies protection, then completes the consumer and reclaims the version. |
| Installed extensions | `artifact-reader-extension.test.ts` publishes and installs a fixture extension through the real archive/cache/trust/facade pipeline, typechecks its consumer, verifies root/subpath module identity and reads an application publication after daemon restart. GitHub itself is represented by the local `gh` fixture. |

`packages/platform-bun/test/artifact-reader-contract.test.ts` exercises a reporter reading 1,025 source versions, report-transition rollback, migration from a database without the hold projection, regeneration after reclamation, overlapping protection categories, consumer-ID truncation and `Report.test` fixture queries. It executes the documented graph through the real runner and distinguishes native binary permission failures from missing/corrupt content. The permission check is skipped for root, which bypasses ordinary file permission restrictions.

## Verification results

Verification on 2026-11-06: `bun run typecheck`, `bun run check` and the final full `bun test` suite passed: **383 tests across 98 files, 2,902 assertions, 559.22 seconds**. All 279 captured TypeScript/JSON source and test hashes stayed unchanged throughout the run.

The added contract test caught and now covers a binary adapter that erased transient native I/O errors. Open/liveness errors are preserved, transient storage errors become `ArtifactUnavailable`, and missing or corrupt content remains a permanent `ArtifactReadError`. The final suite includes that correction and the additional reporter, fixture and documented-example tests.

An earlier full run overlapped source edits and is not used as final verification evidence: cached modules disagreed with newer test assertions, and a daemon restart correctly refused a retained revision after its host source digest changed. The affected focused tests and the report CLI restart test passed against a stable tree afterward.

## Practical limits

These checks run on the local macOS/Bun environment. The new reader slice has not been executed on Linux. Deterministic transaction rollback and real daemon restart are covered; this is not exhaustive power-loss injection at every SQLite/filesystem instruction.

First access, rather than submission or discovery, starts protection. Query results can be reclaimed before a read. Settled report obligations release their source hold; a later regeneration can receive `Reclaimed`. There is no force-release command for a missing consumer run record, no automatic artifact collector and no run-history pruning.

Long binary reads can delay publishers, and queue time consumes attempt timeouts. The harness exercises local limits and writer ordering but does not simulate competition among independent runs. Caller-retained byte arrays, socket buffers and arbitrary application dependency cycles are outside the admission bound.

This host source change uses the existing ABI fence: restarting on a new build is not a migration of incompatible retained bundles. Host-ABI migration remains a separate roadmap gap.
