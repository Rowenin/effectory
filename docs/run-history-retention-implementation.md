# Completed run-history reclamation implementation

The user approved the offline contract on 2026-11-06. Implementation and final repository verification are complete. No independent review is claimed.

The implementation uses repository ownership and storage-only scoped Effects. It does not construct the WorkflowEngine or application catalog for maintenance. A durable exact-family manifest precedes compact records and payload removal; native cleanup uses the pinned Effect `MessageStorage.clearAddress` for root/leaf execution and clock addresses. Startup recovery precedes construction of the entire owned host Layer.

Compact principal/admission-lane/key/fingerprint records block retired submissions before revision loading and inside admission. Minimal wait/report target mappings preserve explicit mutation refusals without their former payloads. A history epoch invalidates cursors. Schedule summaries and all three artifact-protection paths consult retained terminal facts. An explicit private column migration also makes the preceding host's admission-format guard fail before it can ignore tombstones.

## Durable and process evidence

Committed tests use synthetic repositories, not the user's repository state:

- `run-reclamation.test.ts`: whole report families, unchanged artifact reads, submission and mutation refusals, foreign principals, changed generations, unfinished work, cursor epochs, schedule summaries, unrelated consumer pins, unknown-producer protection, strict records, plan expiry and identity, 100-family selection, full-database rollback and a 10,000-generation family drained in 256-row batches.
- `run-reclamation-daemon.test.ts`: actual CLI/daemon root and child workflows, task retries, durable timer, checks, JSON/bytes artifacts and all report scopes. A retained approval workflow survives cleanup plus backup/restore and resumes normally; the retired key remains refused and its bytes still download correctly.
- That process test also sends SIGKILL at eight points: marker, intent commit, event deletion, host deletion, before/after native clear, before/after receipt. Backup refusal leaves the database, WAL, SHM and marker contents unchanged. Startup or repeat apply finishes the original manifest exactly once.
- The compaction test fills a scratch database with 256 MiB, deletes half, kills the maintenance subprocess after it enters compaction, checks SQLite integrity and retained history, then successfully retries to shrink the file.
- `run-reclamation-manual.test.ts`: kills an actual manual task, authorizes its recovery, finishes and retires it, restarts, and verifies the original authorization receipt now gives retired Conflict.

The full-database test uses SQLite `max_page_count` and fills a scratch table to SQLITE_FULL. The intent transaction rolls back all compact inserts, keeps every source row, and succeeds after space is freed. This is an actual SQLite allocation failure, not a physical-volume ENOSPC test.

A frozen copy of the pre-column-migration `createStore` refuses a current database with RevisionUnavailable before admission. Scratch script/log: `/tmp/effectory-run-retirement-legacy-store/check.ts`, `/tmp/retirement-old-host.log`. This tests the earlier entrypoint itself, not a released old executable. Existing retained-revision ABI refusal is unchanged.

Earlier storage probes and table/trigger inventory are design evidence and remain separately identified in the [storage audit](run-history-retention-storage-audit.md). They are not counted as implementation tests.

## Limits

No automatic run cleanup, revision pruning or migration of old host ABIs is implemented. Compact deduplication records and completed apply receipts remain indefinitely. The 100-family plan cap does not cap total scan work; large families use bounded batches but may hold a single intent transaction while compact facts are committed. SQLite needs writable space even for deletion. Artifact retention and run-history reclamation have separate lifetimes.

The process tests run on macOS with Bun 1.4.3 and Effect 4.0.5. They do not claim Linux execution for this slice. The SQLite page-cap proof does not claim a physical-volume-full test; SQLite journal recovery remains the underlying durability mechanism.

## Final verification

On 2026-11-06, `bun run typecheck`, `bun run check`, and the full `bun test` suite passed: **501 tests, zero failures, 4,224 assertions across 129 files**, in 958.83 seconds. The 355-file source/fixture/configuration manifest was unchanged throughout the full run. Documentation-only result recording followed it.

Logs: `/tmp/retirement-final-typecheck-v2.log`, `/tmp/retirement-final-check-v2.log`, `/tmp/effectory-retirement-verification/full-tests.log`. Frozen manifest and its verifier are in `/tmp/effectory-retirement-verification/`. The tests themselves are committed-source candidates in the worktree; no commit or deployment was made by this slice.
