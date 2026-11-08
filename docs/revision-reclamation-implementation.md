# Revision reclamation implementation

The user approved the [full contract](revision-retirement-api-draft.md) on 2026-11-08. Implementation is in progress. No CLI deletion command is exposed yet, and no new executable upgrade edge is certified.

## Implemented foundation

- `revision-reclaim-record.ts` defines the approved selector, preview, protection, receipt and inspection shapes using Effect Schema.
- `revision-reclaim-inventory.ts` inventories retained bundles under repository ownership without importing application code, opening SQLite or removing incomplete preparations. It validates content-addressed identity, manifest format, exact bundle-directory membership, regular files, sizes and digests. Reads use no-follow descriptors and detect substitution or changes while reading. External hard links are permitted; byte counts remain logical bytes.
- Six focused tests passed (21 assertions). They cover archived incompatible manifests, an import-throwing bundle that is never executed, preserved incomplete preparation, external hard links, unexpected files, symlink substitution, changed content, future manifest formats, all 128 retained revisions and refusal above the limit.
- Typecheck passed. These focused results do not replace the final full suite or executable transition proofs.

## Dependency and deletion implementation

- `revision-reclaim-dependencies.ts` protects every retained run regardless of status or principal, nonremoved schedules (including paused/idle definitions), removed schedules with pending slots, and the scheduler pointer. Report source/group/generation/run relationships, invocation and attempt ownership, wait states, recovery journals, pending outbox intents, and extension base/activation ownership are validated before a usable dependency result is returned. A pending run-family deletion is refused before its partially deleted owner rows are inspected.
- `inspection-budget.ts` shares the one-million-header / 256 MiB limit across the separate scans and captures a deterministic dependency digest. Repeated visits count again. Protection counts remain complete while examples are capped at 20 total per revision. Existing upgrade inspections retain their own behavior when no shared budget is passed.
- Private-copy tests kill a real writer with committed WAL left behind. Both successful dependency inspection and refusal of an orphaned intent leave source SQLite/WAL/SHM hashes unchanged and release the private copies.
- `revision-reclaim-journal.ts` persists immutable previews, durable acceptance, ordered per-revision progress and completed receipts. Preview storage is capped at 32 live plans. Accepted retries precede expiry/freshness checks; completing the journal does not delete a recreated bundle. No CLI currently exposes these methods.
- Acceptance uses a format-2 `RevisionReclaim` routing record at the existing `.effectory/upgrades/active.json` maintenance gate. Current readers print the exact reclamation resume command; the predecessor's format-1 routing decoder refuses it. This decoder test is **not** the required real old-executable writer proof. The accepting host must explicitly resume deletion; normal startup does not do so.
- `revision-reclaim-executor.ts` verifies accepted files, renames them into plan-owned quarantine, syncs directory changes, removes only the verified bundle and manifest, and records each boundary. It preserves external hard links and writes a per-revision deletion locator for later historical diagnostics. Unexpected files, symlinks, changed content, foreign repository identity and foreign accepting hosts refuse. The CLI, plan revalidation and historical lookup still need integration.
- Sixteen real SIGKILL tests cover acceptance, rename, each unlink, directory removal, journal boundaries, receipt publication and gate release. These run the internal implementation in Bun subprocesses against two selected bundles and one protected bundle. They prove internal recovery, not the final CLI/old-host/upgrade matrix. Additional tests cover corruption refusal, external links and completed replay after recreation.

Verification logs for this stage are under `/tmp/effectory-reclaim-*`. The final executor-stage checks passed typecheck, repository check and **132 focused tests (713 assertions across 12 files)**. Those tests include resuming an offline copy of an interrupted deletion independently from the original repository. A full frozen-source suite and executable certification are still required before shipping.

## Remaining implementation

1. Build the complete preview binding from repository identity, storage/owner/platform, active pointer, dependency inspection and candidate inventory. Independently recapture and compare it before accepting an unaccepted preview; never accept a caller-supplied Ready object.
2. Wire `revision reclaim plan|apply|inspect` to the inventory, shared dependency scan, journal and deletion executor. Inspect uses no application imports or mutation-capable recovery. Accepted resume must bypass fresh-preview eligibility and use only its accepting host.
3. Audit every startup/offline writer/backup/restore path against the shared maintenance gate. Add historical missing-revision diagnostics using the deletion locator, with a currently retained verified bundle taking priority.
4. Finish every contract proof, including real 128-slot exhaustion recovery, run-family reclamation followed by bundle deletion, removed schedule and extension receipt behavior, immutable preview revalidation, restored pending deletion, real old-writer refusal and the actual old/new executable upgrade/rollback matrix. Run the required full checks against frozen source.

Preserve `/tmp/effectory-http-disconnect/release2-bin/effectory-darwin-arm64` as the real predecessor: build `c26a3010cee6c4d7dac060b8a4b70388d5c856e5263ad764533db6a5ce9f7357`, SHA-256 `0d1ae6d32526f4deb52fa9733d3420112decc9a311de004d6aa305e01ec3f485`. Its existing certificate remains historical evidence, not certification of the new source.

The Codex empty-override amendment was explicitly deferred in the same user response. Do not change its current placement behavior as part of this implementation.
