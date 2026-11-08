# Revision reclamation implementation

The user approved the [full contract](revision-retirement-api-draft.md) on 2026-11-08. Implementation is in progress. The approved CLI commands are wired and pass the full repository checks; executable certification remains outstanding. No new executable upgrade edge is certified.

## Implemented foundation

- `revision-reclaim-record.ts` defines the approved selector, preview, protection, receipt and inspection shapes using Effect Schema.
- `revision-reclaim-inventory.ts` inventories retained bundles under repository ownership without importing application code, opening SQLite or removing incomplete preparations. It validates content-addressed identity, manifest format, exact bundle-directory membership, regular files, sizes and digests. Reads use no-follow descriptors and detect substitution or changes while reading. External hard links are permitted; byte counts remain logical bytes.
- Six focused tests passed (21 assertions). They cover archived incompatible manifests, an import-throwing bundle that is never executed, preserved incomplete preparation, external hard links, unexpected files, symlink substitution, changed content, future manifest formats, all 128 retained revisions and refusal above the limit.
- Typecheck passed. These focused results do not replace the final full suite or executable transition proofs.

## Dependency and deletion implementation

- `revision-reclaim-dependencies.ts` protects every retained run regardless of status or principal, nonremoved schedules (including paused/idle definitions), removed schedules with pending slots, and the scheduler pointer. Report source/group/generation/run relationships, invocation and attempt ownership, wait states, recovery journals, pending outbox intents, and extension base/activation ownership are validated before a usable dependency result is returned. A pending run-family deletion is refused before its partially deleted owner rows are inspected.
- `inspection-budget.ts` shares the one-million-header / 256 MiB limit across the separate scans and captures a deterministic dependency digest. Repeated visits count again. Protection counts remain complete while examples are capped at 20 total per revision. Existing upgrade inspections retain their own behavior when no shared budget is passed.
- Private-copy tests kill a real writer with committed WAL left behind. Both successful dependency inspection and refusal of an orphaned intent leave source SQLite/WAL/SHM hashes unchanged and release the private copies.
- `revision-reclaim-journal.ts` persists immutable previews, durable acceptance, ordered per-revision progress and completed receipts. Preview storage is capped at 32 live plans. Accepted retries precede expiry/freshness checks; completing the journal does not delete a recreated bundle. The offline command wrapper now exposes the approved plan/apply/inspect path.
- Acceptance uses a format-2 `RevisionReclaim` routing record at the existing `.effectory/upgrades/active.json` maintenance gate. Current readers print the exact reclamation resume command; the predecessor's format-1 routing decoder refuses it. This decoder test is **not** the required real old-executable writer proof. The accepting host must explicitly resume deletion; normal startup does not do so.
- `revision-reclaim-executor.ts` verifies accepted files, renames them into plan-owned quarantine, syncs directory changes, removes only the verified bundle and manifest, and records each boundary. It preserves external hard links and writes a per-revision deletion locator for later historical diagnostics. Unexpected files, symlinks, changed content, foreign repository identity and foreign accepting hosts refuse. The command wrapper and historical catalog lookup now use these records.
- Sixteen real SIGKILL tests cover acceptance, rename, each unlink, directory removal, journal boundaries, receipt publication and gate release. These run the internal implementation in Bun subprocesses against two selected bundles and one protected bundle. They prove internal recovery, not the final CLI/old-host/upgrade matrix. Additional tests cover corruption refusal, external links and completed replay after recreation.

Verification logs for this stage are under `/tmp/effectory-reclaim-*`. The final executor-stage checks passed typecheck, repository check and **132 focused tests (713 assertions across 12 files)**. Those tests include resuming an offline copy of an interrupted deletion independently from the original repository. A full frozen-source suite and executable certification are still required before shipping.

## Offline command integration

- `revision-reclaim-assessment.ts` binds the preview to the owner/storage/platform, active pointer, inert bundle inventory, source package manifests and lockfiles (including nested real directories), and the complete dependency digest. Source traversal shares the header budget with database scans and never imports application code. Plan completion starts the 15-minute expiry window.
- `revision-reclaim-commands.ts` takes offline ownership and independently reconstructs the entire preview before acceptance. Candidate byte changes and altered candidate/protection lists refuse before intent publication. Accepted and completed requests use the journal first; inspection never resumes work.
- `revision reclaim plan|apply|inspect` is available through the CLI with explicit selectors. A real CLI round trip passes without starting a daemon or evaluating import-throwing source/bundles.
- Catalog lookup checks a bounded deletion locator and its completed receipt only when no verified retained revision exists. A recreated revision takes priority. The transaction-safe synchronous execution check remains free of file I/O.
- The maintenance audit added gate checks before project scaffolding and dependency-pin writes. Sequential real CLI checks reach the deletion gate for daemon startup, init, bare/runtime upgrade, new revision plans, run compaction, extension restore, vault reset and backup. They preserve the gate and source database; only explicit apply resumes.
- The real-daemon lifecycle proof fills all 128 slots, confirms a new source cannot start, removes 127 unused candidates, starts the new source, retires a completed family, then deletes that family's now-unused revision. The old submission key still conflicts. Historical describe names the reclamation receipt; recreating the same revision restores lookup and a repeated apply preserves that bundle.

The integrated stage passed typecheck, repository check, and **141 focused tests (816 assertions across 15 files)**, including the command and real-daemon lifecycle checks. Logs are `/tmp/effectory-reclaim-cli-final-typecheck.log`, `/tmp/effectory-reclaim-cli-final-check.log` and `/tmp/effectory-reclaim-cli-focused.log`. These results are implementation evidence, not executable transition certification. The subsequent full repository verification is recorded below.

## Remaining implementation and proof gates

Command-level recovery now passes all 16 SIGKILL boundaries through real assessment/admission and CLI resume, including independent recovery of an offline copy. An injected filesystem disappearance fails with the resume hint and succeeds after repair. The command test file passed 28 tests and 194 assertions. This is not a real disk-full proof.

Removed-schedule history remains readable after bundle reclamation; re-adding the schedule produces a new generation. Completed extension requests replay their original receipt without fetching or recreating the deleted bundle. The real-daemon tests passed 14 and 7 assertions respectively.

Still outstanding: real predecessor offline-writer refusal during pending reclamation, final executable upgrade/rollback certification, and disk-full recovery evidence. The earlier full suite of 822 passing tests applies to checkpoint `bb93a74`, before this command integration.

The prepared certification candidates add the preserved `c26a3010…` predecessor for storage formats 1 and 3 and revalidate the four existing predecessor/storage edges against the final target. Their intended evidence file is `docs/revision-reclamation-certification.json`. That file has not been produced. Candidate registrations were removed from the runtime registry before committing this checkpoint; the existing historical registrations are unchanged. A scratch executable under `/tmp/effectory-reclaim-certification/bin/` was built with those candidates and must not be released as certified.

Preserve `/tmp/effectory-http-disconnect/release2-bin/effectory-darwin-arm64` as the real predecessor: build `c26a3010cee6c4d7dac060b8a4b70388d5c856e5263ad764533db6a5ce9f7357`, SHA-256 `0d1ae6d32526f4deb52fa9733d3420112decc9a311de004d6aa305e01ec3f485`. Its existing certificate remains historical evidence, not certification of the new source.

The Codex empty-override amendment was explicitly deferred in the same user response. Do not change its current placement behavior as part of this implementation.

## Main checkpoint verification

Before committing the command integration, `bun run typecheck`, `bun run check` and the full `bun test` suite passed: **853 tests, zero failures, 7,070 assertions across 180 files** (1,040.64 seconds). All 710 tracked/unignored files matched the captured manifest throughout verification; only this result note was added afterward. Logs and the manifest are under `/tmp/effectory-main-push-final/`. This verifies the source checkpoint, not the outstanding executable upgrade certification or a new release.
