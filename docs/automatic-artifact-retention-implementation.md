# Automatic artifact retention — implementation evidence

Status: user-approved, implemented and **fully verified**, 2026-11-06. The [operator guide](automatic-artifact-retention.md) and [approved contract](automatic-artifact-retention-api-draft.md) describe the public behavior. Earlier stand-in probes are labelled separately in [research](automatic-artifact-retention-research.md).

## Implementation

- `lake-automatic-store.ts` persists the default-off setting, generation, sweep checkpoint/history and diagnostics. An identity projection records stable enumeration order and a mutation epoch; triggers update it on publications and retention mutations. Startup backfills the projection before collection. The setting is ordinary SQLite state included in existing offline snapshots.
- `lake-automatic-scan.ts` visits a fixed identity horizon and seeks retained versions newest-first, at most 128 per synchronous immediate transaction. It carries the kept rank across batches, rechecks identity epochs, restarts changed identities once and defers a repeatedly changing identity to another sweep. It does not use OFFSET or a full-history rank/count query.
- Each batch rechecks the setting generation and repository lease alongside captured policy and protections. The continuation, tombstones, receipt and unlink intents commit together. Disable invalidates the continuation and generation; an old disable/enable cycle cannot revive stale work.
- `lake-reclamation.ts` shares `commitReclamation`, receipt lookup and unlink mechanics with manual apply. New manual/automatic receipts carry their origin; old receipts remain readable. No receipt is created for a no-op automatic scan. Cleanup checks retained digest references immediately before unlink, preserving the existing binary installation/open-reader rules.
- `lake-protection.ts` adds an existence-only worker check for producer, consumer and report protection. It avoids enumerating/counting all consumers while deciding whether to retain a version.
- `lake-automatic.ts` handles bounded SQLite-busy retry, a rotating queue of four cleanup jobs per maintenance iteration, status and settings. Unrelated progress cannot hide an unresolved job failure. If persisting an error itself fails, a host-local fallback keeps the diagnostic visible until its operation succeeds.
- `automatic-retention.ts` supplies the host-owned Effect Layer/fiber, using the shared Lake. Active slices pause 20 ms; idle polling sleeps one second. Completed sweeps wait one minute before starting another. These are private maintenance constants, not a real-time deadline. Scope closure interrupts/awaits the worker before the dependent Lake closes.
- Runtime schemas/RPCs, control-plane capability, CLI commands and the doctor warning implement the approved surface. No author service, application option, task field or new workflow execution is introduced.

## Real implementation tests

`packages/platform-bun/test/automatic-retention.test.ts` exercises:

- Default-off behavior, idempotent settings, stale generation refusal after disable/enable, Automatic receipts, cleanup while disabled, and no idle receipt growth.
- Age OR count, nonmonotonic timestamps, captured policy changes, newest/single-version protection and equivalence to manual eligibility at the tested observation point.
- Reader pins through Waiting, conservative retention for a missing consumer, later release, and all 1,024 externally pinned versions surviving until consumer completion.
- Both root-run and workflow-invocation report obligations through WaitingSource, Queued, Running and NeedsAttention, then collection after settlement.
- Metadata rollback covering checkpoint, tombstones, receipt and unlink intent. Cleanup errors remaining visible through unrelated work; a new identical publication preventing unlink of shared content.
- A hot identity restarting/deferred without starving another; huge count policies without OFFSET; a manual delete invalidating a saved rank.
- Actual second-connection SQLite contention, bounded retry without a retained read transaction, and closure of the real maintenance Layer stopping further storage access.
- In-memory diagnostic fallback when SQLite cannot store its own error.
- SIGKILL of a subprocess running the real collector before commit, after commit, and after unlink. The test intercepts real SQLite statement calls solely to place the kill; it does not replace the collector or engine. Before-commit work rolls back; committed work recovers with the same single receipt. Temporary fixture scripts live outside the checkout.

The 200,000-version real-lake test seeds metadata through the real tables and triggers after a real publication. It protects the newer 100,000 versions with a NeedsAttention producer and reclaims the older 100,000. It checks a persisted 128-row checkpoint, reopens through a new lake connection, finishes in another 1,562 work steps, and verifies the indexed query plan has no temporary sort. Initial measured traversal was roughly 13 seconds, with the slowest observed batch 82–124 ms depending on the run. This includes the real protections/receipt writes and is not comparable to the simplified model's timings or a production latency promise.

`packages/platform-bun/test/automatic-retention-cli.test.ts` runs the actual daemon and CLI. It verifies the opt-in, waits for an injected cleanup failure, checks doctor/status, kills/restarts the daemon, verifies the same receipt and cleanup recovery, backs up/restores offline at another path, and verifies that enabled state survives restore. It then disables and shuts down normally.

`packages/cli/test/reclamation.test.ts` proves an older daemon is refused before the mutation path executes and recognizes the new capability.

A separate real-daemon foreground probe seeded 50,000 versions in a temporary repository, enabled the collector through the CLI, and issued eight `daemon status` commands while collection was active. All eight completed and storage observations confirmed continuing sweep progress. The longest end-to-end command took 1,690 ms, including a fresh CLI process, RPC connection and concurrent full-suite machine load. This establishes concurrent foreground completion, not an isolated RPC latency benchmark or a service-level bound. The probe stopped its daemon normally and removed its repository. Its script/log are `/tmp/effectory-auto-retention-research/foreground.ts` and `foreground.log`; it changed no checkout source.

Existing lake retention, reader, binary and report tests remain part of full verification. They cover manual receipts/expiry, shared digests, POSIX content behavior, rollback, storage failure and the reader/report lifecycle. Their results prove those shared mechanisms, not an arbitrary claim about every possible automatic-collector interleaving.

## Verification record

The repository-required sequence passed: `bun run typecheck && bun run check && bun test`. The full suite completed with **460 passing tests, zero failures, 3,776 assertions across 118 files**, in 791.45 seconds. Logs are `/tmp/automatic-retention-final-typecheck.log`, `/tmp/automatic-retention-final-check.log` and `/tmp/automatic-retention-final-tests.log`.

The complete source/test/example manifest was captured before final checks in `/tmp/automatic-retention-final-manifest.json` (322 files). A fresh enumeration and hash comparison after the suite found no added, removed or changed source/test/example files. Only documentation was updated while verification ran; its final formatting/lint check is recorded separately.

Before final verification, the three real SIGKILL cases passed (26 assertions); the focused correction tests for contention/Scope and diagnostic persistence passed (10 assertions). An earlier focused run caught a missing test import, which was fixed before final verification. No independent delegate review, Linux run, compiled-binary run, commit or publication is claimed for this slice.

## Remaining limits

The newest kept version and single-version identities are not collected by policy. There is no whole-entry lifetime, repository age selection automation, orphan inventory sweep, run/report result pruning, revision retirement or total byte quota. Those remain parity work. Protected or continuously rewritten identities can defer collection indefinitely; other identities continue to progress. One 128-row batch and synchronous filesystem calls can still take time under load; the worker does not promise a hard latency bound.

Existing source-ABI compatibility rules still apply to daemon upgrades and retained revisions. This feature does not migrate old execution journals across host builds. Backup remains an offline, non-mutating copy; restoring an enabled repository preserves that setting. Metadata and receipts remain retained, so content reclamation does not cap SQLite growth.
