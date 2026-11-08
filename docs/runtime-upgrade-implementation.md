# Runtime-upgrade implementation and verification

The [contract](runtime-upgrade-api-draft.md) is user-approved and implemented. Offline planning, inspection, accepted apply/resume, format fences and archived-revision startup are complete. The final Darwin ARM64 executable passed actual predecessor/target replay, rollback, incompatible-history and offline-writer proofs for both storage-1 and storage-2 predecessors, targeting storage 3. Required typecheck, formatting/lint and the full suite passed: **748 tests, zero failures, 6,317 assertions across 169 files** (1,419.95 seconds). All 457 selected source/configuration/example/script/test files remained unchanged. Only the exact [documented transitions](runtime-upgrades.md) are certified; Linux component evidence does not enable a Linux upgrade edge.

The sections below preserve historical checkpoints. Earlier incomplete or failed results are superseded by the final verification section, not relabelled as successful.

## Implemented foundation

- Daemon preflight now precedes credentials, extension recovery, retirement recovery, catalog loading and engine construction. Legacy revision manifests still require their exact build; no legacy ABI is silently mapped to a new execution contract.
- Retained bundle/manifest integrity is checked without importing application code or deleting incomplete revision directories.
- Offline storage inspection holds repository ownership and captures the database and sidecars into a private, restricted temporary directory. It hashes the captured bytes, rechecks the source, recovers a second copy, validates database integrity and queries that copy read-only. The source is never opened with SQLite.
- Transition inspection additionally checks the present WAL's header, frame checksums, salts and final commit, and checks recovered page count/size against that commit. It refuses ambiguous tails. This is conservative admission, not a repair algorithm or proof that missing historical transactions never existed.
- Same-build startup uses SQLite's ordinary recovery on the private copy, including legal stale tails from WAL reuse. That startup view must never authorize a transition or be described as certification of complete acknowledged history.
- Pending outbox work is scanned beyond the runner's first page using left joins, so orphaned intents cannot disappear. Recovery holds, authorization receipts, gate obligations, extension operations/activation, retirement plans and binary installation record shapes are inspected without calling their recovery routines.

The inspection input cap is 32 GiB across a database and its sidecars. Raw and recovered copies need additional temporary disk space. Journal scanners use 200-row pages and one-million-row/256 MiB decoded budgets per scanner, with cooperative yields between pages. Database integrity checking remains synchronous. These are current implementation bounds, not a finished large-store latency or peak-memory guarantee.

## Earlier foundation verification

Focused tests use real SQLite, including a killed writer with committed WAL data, corrupted/truncated tails, WAL reuse and callback failure cleanup. Real recovery-store records exercise held, authorized, consumed and gated states. Maintenance tests create real journals and inject unsupported formats and orphaned identities. Process tests launch the CLI daemon and assert refusal before credentials/readiness, unchanged source bytes and preservation of incomplete revision directories. Existing daemon restart tests passed with this gate.

The required full check chain completed with typecheck and lint passing, then **602 tests passed and one timed out** across 149 files (5,401 assertions, 1,710.14 seconds). All 386 captured source/config/fixture files remained unchanged during that run. The failure was the existing 250,000-event subtree-history fixture exceeding its 30-second timeout; it does not call the startup gate.

Afterward, that fixture was changed to seed the same events in one SQL statement instead of doing a JavaScript decode and counter query per event. The dataset, paging assertions and timeout remain unchanged. Its three tests passed in 20.80 seconds, and typecheck and lint passed again. Post-run hashing confirmed that this fixture was the only source/config/test change. At that checkpoint, the complete suite had not been rerun after the fixture-only fix. The later complete verification below includes that fixture and the scoped-ownership work.

Evidence is under `/tmp/effectory-upgrade-baseline/`: `preflight-source-manifest.json`, `preflight-stability.json`, `preflight-full-tests.log`, `history-fixture-tests.log`, `post-fixture-typecheck.log`, `post-fixture-check.log` and `post-fixture-stability.json`. The earlier 559-test wake-status result is separate and does not verify this code.

## Remaining before the contract is complete

- Publish only the concrete platform/build transition that passes the final executable proof matrix.
- Fold in and verify the child-report completion race found during full-suite verification.
- Rebuild and repeat real old/new-host checks after the final source changes; retain executable digests and a source manifest.
- Finish the required full checks against that unchanged snapshot. Earlier passing checkpoints do not cover subsequent changes.

Linux component checks remain distinct from a supported Linux upgrade edge. No predecessor Linux executable has been retained for this transition, so no such edge is claimed.

## Scoped revision ownership

The catalog now uses Effect's `RcMap` for lazy acquisition, shared scoped borrowers and release after the last borrower. Retained bundles and manifests stay on disk. Startup verifies them without building their Layers; only the active revision is loaded. A successful activation acquires the new active pin before releasing the previous one. Existing borrowers of the old revision keep it alive. Candidate preparation is scoped too: failed validation/publication releases its resources, and a candidate cannot activate after its caller's Scope closes.

Application construction restores the catalog's host Context and supplies a fresh Layer memo map. This prevents RcMap's initiating-caller Context merge from capturing invocation tags or other per-attempt services. The vault build marker stays inside that isolated construction.

Scoped borrowing covers each native Activity entry as well as leaf and graph execution, Runner submission and wait settlement, each scheduler tick, discovery/describe/plan, extension inventory and the entire vault provider operation. Native execution releases its borrow on completion or suspension; a later replay reacquires the same retained revision. Active revision ownership is independent of those borrows. No bundle pruning or module unloading is claimed.

Production integration tests verify concurrent borrowers, activation while an old revision is used, last-borrower release, later reacquisition, failed Layer acquisition and manifest publication, candidate expiration, caller-tag isolation, and historical vault reads finishing or being interrupted. A real host/engine test changes the active application while a task runs, holds its cleanup open, and checks that the old application closes only after cleanup and native execution finish. The result and pinned revision remain unchanged.

The focused catalog, extension, task-Layer restart and vault CLI group passed **13 tests / 119 assertions** across seven files in 81.20 seconds. Typecheck and lint also passed. These are same-build ownership tests, not old/new upgrade certification. Evidence: `/tmp/effectory-upgrade-baseline/scoped-catalog-focused.log`, `scoped-catalog-typecheck-3.log`, and `scoped-catalog-check-3.log`. The earlier primitive probe remains supporting evidence, not a substitute for the implementation tests.

### Shutdown correction

A separate real-host shutdown probe found that a leaf workflow can stop awaiting its Activity before that Activity's finalizer finishes. Borrowing only in the leaf and graph therefore released an inactive application between `cleanup` and `cleaned`. The Activity now acquires its own scoped borrow outside permit queues, resolves its task from that borrowed registry, and holds it through cleanup. Secret sanitation encloses the entry Scope, and mixed cleanup defects are preserved afterward. Run completion also waits for tracked invocation work, including this cleanup.

The regression is in `revision-execution-lifetime.test.ts`: graceful host shutdown interrupts a still-running handler after activation switches to another revision. Its task cleanup finishes before the old application releases, and each application releases once. Fourteen focused tests covering this regression, completion, task finalization/stop ownership, wake status and vault encoding passed (131 assertions). Typecheck and lint passed after the correction.

The first full-suite run for scoped ownership was deliberately interrupted after this separate probe exposed the bug. It is not a passing full-suite result. The 398 captured source/config/fixture files were unchanged during that incomplete run; see `scoped-catalog-interrupted-stability.json`. The fresh complete verification below covers the correction.

## Complete verification of this implementation checkpoint

The required chain passed after the Activity ownership correction: **typecheck, formatting/lint, and 610 tests with zero failures**, across 151 files (5,430 assertions, 1,601.83 seconds). All 398 captured source/config/asset/fixture files remained unchanged; no files were added during verification. The large child-history fixture that timed out in the earlier foundation run passed in this run.

Evidence under `/tmp/effectory-upgrade-baseline/`: `catalog-owned-activity-typecheck.log`, `catalog-owned-activity-check.log`, `catalog-owned-activity-full-tests.log`, `catalog-owned-activity-source-manifest.json`, and `catalog-owned-activity-stability.json`.

This checkpoint completes the startup-inspection foundation and scoped revision resource implementation. It **does not complete the runtime-upgrade contract**: offline commands, versioned execution/storage contracts, certified distinct-build transitions, archived native-history access, migration intents and recovery-copy rollback remain outstanding. No transition is advertised as supported on the strength of these same-build tests.

## Compatibility admission and archived-result reader

Startup and Catalog now share a pure execution-compatibility policy. Metadata can describe a legacy build identity or a versioned execution contract, but matching a contract label or package version alone does not grant admission. Release certifications must identify the exact predecessor build, Effect version and contract, its retained executable digest, and the target contract/Effect version. At this checkpoint the production certification list was empty and new revision publication still used the legacy manifest. The executor section below records the subsequent storage transition and downgrade fences; legacy manifests and bundles remain unchanged.

`Catalog.assertExecutable` checks retained metadata without acquiring a Layer. Report retry calls it inside its transaction **after accepted-receipt lookup and before creating a generation**. A refusal does not reserve the request key. Retrying an already accepted operation still returns its receipt when the revision can no longer execute. Tests verify this ordering, authorization before metadata access, and that checking an inactive revision does not reacquire its application services.

`run outputs` and summaries now read native results through Effect's `MessageStorage` lookup APIs rather than `WorkflowEngine.poll`. The adapter uses the pinned run-RPC codec, checks stored payload lengths before materialization, and holds one SQL snapshot through the check and decode. It does not register workflows, dispatch messages, run migrations or import retained application code. `nativeHistoryLayer` supplies only the storage implementation on a read-only private copy.

A fresh-process integration test produces real success, domain-failure and defect outcomes, replaces the application files with import traps, and reads the same outcomes using the private-copy boundary. No application code runs, and source database/WAL/SHM bytes remain unchanged. Malformed JSON, unsupported result encoding and oversized replies fail without exposing stored text. Existing authorization and output-page bounds remain in the host query paths. This is evidence for the **current installed storage format**, not a certified reader for another Effect version. At this checkpoint startup still refused incompatible retained revisions; the complete archived-data startup path was added in the later executor work.

Focused evidence in `/tmp/effectory-upgrade-baseline/`: `report-retry-tests.log` (37 tests / 620 assertions), `compatibility-tests.log` (15 / 86), `native-history-integration.log` (32 / 124), and `native-history-storage.log` (1 / 14). These groups overlap with the final suite and should not be added together as a suite total.

## Bounded inspection and affected-work inventory

Outbox inspection now rejects nonpositive pending IDs and unknown delivery flags, including NULL, without silently skipping them. Flag-domain checks use the validated pending index and do not scan delivered history. A missing or partial pending index refuses explicitly.

Shared journal scans measure projected value sizes in SQL before materializing JavaScript rows. Pages shrink below 200 rows when needed; a single row above 8 MiB refuses with `LimitExceeded`. Prepared statements are finalized within the synchronous page transaction, with Effect yields only between pages. The existing one-million-row / 256 MiB total budget remains. Dense-page, oversized-row and interruption tests verify progress and release of read transactions. These bounds are not a claim that every native SQLite integrity operation has a bounded execution time.

The plan inventory counts unfinished runs, all four unsettled report states, unmaterialized report sources, unfinished bulk cancellations and pending schedule slots by pinned revision. Counts are complete within the scan budget; each revision carries at most 20 examples, explicitly marked when truncated. It charges all visited headers, including settled rows, and reads no input/result payloads. This avoids hiding unbounded SQL work behind a filtered `LIMIT`. It complements the recovery/outbox/maintenance inspectors; it is not yet the integrated CLI plan or a complete native-history invariant certificate.

## Verified recovery-copy component

The internal recovery-copy implementation creates a new, private destination **outside** the repository. It copies and rehashes in 1 MiB chunks, yields between chunks, re-inventories the source, and independently verifies the copied files. It preserves regular files, owner execution bits, empty directories and WAL bytes. It does not open runtime databases or execute application code.

Limits are 32 GiB per file, 128 GiB total, 50,000 entries and 16 MiB of manifest metadata. Directory iteration is incremental. The existing builtin backup limits remain unchanged. Dependencies, Git metadata, daemon bookkeeping, SQLite SHM, ownership files and upgrade records are excluded; dependency manifests/lockfiles, runtime databases/WALs, bundles, blobs and repository credentials are included. External vault keys remain external.

The image's repository lease is held through the caller's Scope, including the eventual migration. Ownership files are excluded from content hashes, so they receive separate validation **before SQLite opens them**: the state directory must be real and ownership files/sidecars must be single-link regular files. A scratch probe found that the first implementation followed an ownership-file symlink and changed an unrelated file's permissions. That was corrected, with regressions for the owner, WAL, SHM, journal, a hard link and a substituted state directory. The fixed probe refuses and leaves the unrelated file unchanged.

Files and directories are flushed before the manifest is published; the incomplete-copy marker is removed last and its directory is flushed. Failure leaves an incomplete image, never an automatically usable rollback copy. The implementation does not overwrite or recursively delete an existing destination. The manifest is bound to the plan ID and independently checked against a digest supplied by the caller. Apply still needs to bind that evidence to its own durable intent and planned source identity.

Tests cover a crash-left WAL value, a file larger than the builtin backup's 128 MiB per-file limit, source changes during copying, content/manifest/permission tampering and four actual SIGKILL barriers: creation, entry copying, verification and manifest publication. Every interrupted image is refused; OS leases are released on process death. Opening a disposable completed copy with SQLite sees the WAL commit. This does **not** yet prove restoration and replay under the original host, full-volume/resource-pressure behavior, partial-fence recovery or cross-platform durability.

Evidence: `recovery-copy-guard-tests.log` (18 tests / 56 assertions), `copy-owner-probe-fixed.log`, and the repository regression tests. The earlier full component run was deliberately interrupted when the ownership-file probe found the side effect; `upgrade-components-interrupted-stability.json` records exit 130 and unchanged captured source. The fresh full check chain passed: typecheck, formatting/lint and **653 tests, zero failures, 5,634 assertions across 156 files** (1,548.31 seconds). All 411 captured source/config/fixture files remained unchanged, with no additions or omissions; `upgrade-components-guarded-stability.json` records that audit. This checkpoint precedes the subsequent transition-entry guards and native reply-header correction, which require their own verification.

### Original-host restoration evidence

A separate process probe now uses the saved **actual predecessor executable** (SHA-256 `a17138f58bb9f1514d12e4bbcb54fa610067f993bd87f14caca0edf5cc55f13f`) to create a run, complete a manual task and pause for approval. With that daemon stopped, the real recovery-copy component captures and verifies the repository. The probe restores the image into a fresh temporary destination and starts the same predecessor there.

The restored run keeps its run ID, pinned revision, completed task output, approval ID and submission request-key receipt. Approving it finishes the workflow; the completed manual task's audit file still has exactly one execution. No manifest or host-ABI override is used. The probe cleans up its processes and temporary repositories. Its script, result and log hashes are recorded in `runtime-upgrade-probe-results.json`.

This establishes stopped-copy restoration and replay for that concrete predecessor and fixture. It does not exercise migration, a new host, pending schedules/reports, external vault-key recovery or rollback after new external actions. It therefore does not certify an upgrade edge or complete the apply/rollback proof gate.

### Linux component checks

The same source snapshot's focused component checks passed in Linux ARM64 using `oven/bun:1.4.3`: **57 tests, zero failures, 275 assertions across seven files** (27.34 seconds). The container had 4 GiB of memory and two CPUs. Coverage includes recovery-copy SIGKILL/lease/substitution cases, WAL capture, bounded SQL pages, outbox/work inventory, compatibility policy and application-free native-result reads. The log and image/source identities are recorded in `runtime-upgrade-probe-results.json`.

This is cross-platform component evidence. It is not an actual predecessor/target executable upgrade on Linux and does not certify such an edge.

## Normal-writer transition guard

A file-only guard now checks `.effectory/upgrades/active.json` before normal daemon preflight, extension preparation/recovery, run-reclamation recovery or commands, offline vault operations, and snapshot copying. A present intent always refuses these paths with `RevisionUnavailable`; neither an unknown phase nor a record claiming completion lets normal writers acknowledge it. Only the future apply path may finish the transition and remove the active record. Bounded routing metadata provides the accepted plan ID and required target build without exposing other record contents. Damaged, oversized or substituted files/directories also refuse.

Real CLI regression cases cover daemon startup, run-reclamation plan/compact, vault reset/key import/key export, extension restore and backup. They keep runtime database/file hashes unchanged, create no vault database or snapshot, and do not load application code. A direct extension-recovery call is covered too. The ownership SQLite file remains separate bookkeeping, as with existing offline commands.

This protects hosts containing the new guard. It does **not** fence the actual predecessor, which never reads this record. Credentials, vault-storage and extension-lock format fences, partial-fence abort/resume and the durable apply producer are still required. The guard does not make `upgrade plan|apply|inspect` available by itself.

## Native reply-header correction

A separate corruption probe found that Effect's general reply decoder treats an unknown native reply kind as a Chunk. The task-result reader then returned `None`, hiding the fact that a stored reply was unsupported. The reader now checks kind, sequence and SQL storage types before materializing reply fields. Unknown kinds, invalid exit sequences and oversized corrupt header fields fail with generic `RevisionUnavailable`, without leaking their contents. This also prevents a corrupt header from bypassing the payload byte bound.

The failed-before probe and corrected probe are `native-history-kind-probe.log` and `native-history-kind-fixed-probe.log`. The durable regression extends `native-history.test.ts`. The first focused run after these changes passed 15 tests with 165 assertions. Final typecheck and formatting/lint passed, followed by **30 focused tests, zero failures, 276 assertions across seven files** (58.01 seconds), including affected normal backup, extension-bootstrap, run-reclamation and vault paths. All 414 captured source/config/fixture files remained unchanged during that check. The earlier 653-test full-suite checkpoint predates these changes; these totals overlap and must not be added together.

## Durable acceptance and progress journal

The internal upgrade journal now persists bounded, schema-checked plans, a small active acceptance pointer, ordered progress checkpoints and terminal receipts under repository ownership. Acceptance precedes progress-file publication. If the process dies in between, the active pointer and immutable plan reconstruct the original acceptance. Accepted retries resolve before expiry and source-freshness checks; an unfinished transition requires its accepting build. A terminal receipt remains byte-stable and readable by a later host.

The active pointer remains until a terminal receipt is durable. Repeated cleanup removes only its own pointer, never a later transition. Accepted history lives outside the temporary `.effectory/upgrades` tree so subsequent recovery copies retain earlier receipts. Each record is bounded; planning does not enumerate every older plan or impose a lifetime count that would eventually prevent further planning. Prepare-file substitution, malformed history and use after the repository lease closes fail without advancing progress.

The regression suite kills a real subprocess at four boundaries: acceptance before history publication, history publication, terminal receipt publication, and active-pointer cleanup. These are journal tests; their migration names are fixtures and perform no storage migration. This module is not yet connected to the CLI or a transition executor.

## Detecting old writes during partial fencing

A bounded vault identity reader now hashes schema and every stored row, including ciphertext, counters, absence tokens, tombstones and mutation receipts, from a private recovered database. It excludes the format-version field and physical SQLite/WAL layout so an owned format fence does not look like a competing semantic write. It preserves SQL value types and exact bytes, including NUL text, blobs and integers beyond JavaScript's safe integer range. Unknown columns/schema objects and oversized content refuse instead of being silently omitted. No key or decrypted secret is read.

A separate probe used the actual saved predecessor executable to reset a format-1 fixture. The new identity reader detected the change. Stamping the fixture's version to 2 left the identity unchanged; the predecessor then refused reset with exit 3, and the identity remained unchanged. The probe used the real identity reader but installed the version fence directly, so it proves neither the complete fencing protocol nor an upgrade edge. Its evidence is `vault-identity-old-writer-results.json` under the existing scratch evidence directory, with hashes retained in the evidence document.

The executor still needs to combine this check with credentials and extension-lock fences, detect writes across every crash window, and abort by reversing only owned format fields. Restoring a stale full copy automatically after an intervening old writer remains forbidden.

The new journal, vault identity, normal-writer guard and storage-inspection checks also passed on Linux ARM64: **26 tests, zero failures, 163 assertions across four files** (8.41 seconds), in `oven/bun:1.4.3` with 2 GiB memory and one CPU. This is component portability evidence, not an old/new Linux executable transition.

Final verification for this component checkpoint passed `bun run typecheck`, `bun run check`, and the full `bun test`: **671 tests, zero failures, 5,803 assertions across 160 files** (1482.58 seconds). The 412 selected source/configuration/fixture files in the captured manifest remained unchanged, with no additions or removals in that selection. Evidence log and manifest hashes are recorded in `runtime-upgrade-probe-results.json`. These totals include earlier regressions and are not additive with prior checkpoints. At that checkpoint offline command integration, restartable format fences/migrations, archived-code startup, and actual old/new transition certification remained outstanding; subsequent sections record that work.

## Offline plan and inspect command integration

`upgrade plan`, `upgrade inspect PLAN_ID` and the refusal/receipt paths of `upgrade apply PLAN_ID` are now connected to the CLI. Bare `upgrade` still performs the original dependency-pin update; its help distinguishes that operation from runtime transitions. These commands acquire offline ownership and never contact or launch the daemon. Ownership-file substitution is checked before SQLite opens the separate lease database.

Planning reuses the bounded recovery-copy file inventory to bind all captured repository state and dependency manifests/lockfiles. It hashes before and after inspection, loads no application code, and reads recovered private database copies. Stored plans include exact aggregate counts, per-revision counts and up to 20 examples per revision, with explicit truncation. The 15-minute plan lifetime starts after inspection finishes. A failed or oversized plan leaves no preview record; the 2 MiB record bound is checked before creating its control directories.

Apply returns accepted terminal receipts before freshness checks. For unaccepted plans it checks target build, expiry and current repository identity. Changing dependency pins with bare `upgrade` makes the saved runtime plan stale. A stored `Ready` label is insufficient: the independent storage certification policy must match the predecessor, source/target formats, target execution contract, Effect version, platform and architecture. At this command-layer checkpoint the production list was empty, so every transition was reported `Unsupported` and apply refused without creating a recovery copy, accepting a transition or changing runtime data. The migration executor was implemented in the subsequent stage below. These checkpoint results establish command integration and refusal behavior only.

A probe used the actual saved predecessor executable and a newly compiled target CLI (target build `da951f21e79ce74861f7ceafb21b7752aa182eb2ded15974fb03e90219684779`, binary SHA-256 `06261153f48065039b6a1b1fdb9f49a4b1609509cba94f6f77e7e52d1e0739a7`). The predecessor completed a manual task and paused at an approval. With it stopped, the target planned and inspected the repository, then refused apply with exit 5. The captured repository fingerprint was unchanged. The predecessor restarted, retained the completed output, pending approval and submission receipt, and finished successfully; the manual task's audit still showed one execution. No ABI override or manifest relabeling was used. This verifies offline assessment/refusal and predecessor resumability, not migration or target-host replay.

Focused command/journal regressions passed **14 tests with 98 assertions**, and the earlier command/journal/copy run passed 28 tests with 141 assertions; these overlap. Typecheck and formatting/lint pass. That command-layer full suite subsequently passed: **679 tests, zero failures, 5,870 assertions across 162 files**, in 1,363.19 seconds. All 427 selected source/configuration/fixture files remained unchanged, with no additions or omissions (`commands-stability.json`). The earlier 671-test checkpoint predates this command integration.

## Restartable format fences and apply executor

The accepted executor now independently verifies and pins the recovery image, repeats source inspection before acceptance, and compares source state around each format fence. The first storage transition changes only the credentials envelope, vault format version and extension-lock envelope before publishing storage format 2. It does not rewrite native results, run rows, revision manifests or bundle bytes. New revisions use manifest format 3 with the separate execution contract.

The format-2 marker requires a completed receipt bound to the plan, accepting build, platform, architecture, execution contract and Effect version. Normal credential/lock readers and vault writes preserve their envelopes/version. A new vault gets an owned empty sentinel until its first normal operation; that operation replaces the sentinel with the real tables atomically. Vault opening remains lazy.

If a predecessor changes source state between partial fences, apply records `Aborting` and reverses only its own format fields. It never restores the old recovery image over the changed source. A probe using the actual predecessor reset a vault after only the credentials fence: the change was detected, abort preserved the deletion, and the vault remained uninitialized. Abort restores credentials last. Kill/restart tests cover fence installation, SQLite version commits, staging hard links, migration checkpoints, publication, terminal cleanup and each abort stage.

A verified complete image left before acceptance can be reused. Incomplete or occupied destinations are never overwritten. Accepted retries resume the same intent; completed receipts return before copy-existence or freshness checks. A different accepting build or platform cannot resume unfinished work.

## Actual candidate executable evidence

The first candidate is a separate source copy with an explicit **test candidate** edge, not an enabled shipping policy. Its build is `89d58ab5d129d8a910e9b91a381985b8498e9ccbed969520d7b808205a737353`, executable SHA-256 `887bfa9c4db9fe0c6c7707e07981f8df10a4948e10ce26d9b4ab95564375ed22`. The actual predecessor remains build `9f1797ddc28f42ceb77fa8dac1c8806da9207d00a568a792874216237b965f97`, executable SHA-256 `a17138f58bb9f1514d12e4bbcb54fa610067f993bd87f14caca0edf5cc55f13f`. Both are Darwin ARM64 executables with Effect 4.0.5. No application manifest or ABI override was used.

- A completed manual activity and pending approval survived `plan`, `apply`, repeated apply and new-host execution. IDs, pinned revision, submission receipt and completed result remained unchanged. Restoring the independently verified pre-upgrade copy under the actual predecessor also finished successfully without repeating the manual activity.
- A broader fixture preserved a durable sleep, retry backoff, manual hold/token, report obligation and report run, consumer artifact pins, schedule generation/digest/watermark, and encrypted vault data. After restart, retry attempts were exactly 1 and 2; the manual task re-entered only after authorization, with its original attempt identity and key; the report completed once; a due scheduled occurrence ran. Existing attempt deadlines remain absolute across downtime: the first fixture's default 30-second report attempt correctly timed out, so the continuation fixture explicitly uses five minutes.
- The predecessor refused daemon startup, run-reclamation plan/inspect, vault reset/key import and extension restore on the actually migrated store. No logical data or non-SHM source bytes changed. SQLite may change shared-memory bookkeeping before refusal. Removing the external vault key produced a typed `KeyMissing` failure without replacing the key; restoring that same key restored decryption.
- A deliberately incompatible **test-only** contract refused migration while an approval was open. After the predecessor settled it, migration completed, the new host ran new work and read historical run/output/summary data without importing a trapped archived bundle. Historical task description refused with exit 5. That fixture does not certify or ship a v2 execution contract.

Scripts, logs and result records are under `/tmp/effectory-upgrade-certification/`. These candidate results must be repeated on the final build after any production source correction. They are not a substitute for that final certification.

## Child-report completion gap found in verification

The unchanged-source full run found an intermittent report failure. A separate repeated file run also observed a child domain failure temporarily described as Cancelled. Effect persists a deferred completion request before its reply becomes visible to `deferredResult`; terminal parent status therefore does not prove a missing child reply means cancellation.

The candidate fix checks the existing request through Effect's `MessageStorage` lookup API. A durable request with no visible reply remains pending; only actual absence permits the cancellation fallback. A deterministic regression hides the reply while retaining the real stored request: it fails before the fix and passes after. Twelve repeated workflow-report suites passed with the candidate fix. The change is private observation logic, with no new stored format or public status. It subsequently passed the final full-suite and executable checks below.

## Final executable candidate and verification

The final source includes the pending-deferred correction and the concrete Darwin ARM64 release edge. Required typecheck and formatting/lint passed. Focused checks passed **35 tests, zero failures, 224 assertions across five files** (16.94 seconds). The prior unchanged-source full suite finished with **708 passes and the one child-report race failure** across 166 files (6,024 assertions, 1,462.20 seconds); all 418 selected files were unchanged. It is recorded as a failed checkpoint, not a passing release check.

The rebuilt target is build `677f3350bff79f245d1fe4f76ef98610767981875529cf5948949bbefd507cdc`, executable SHA-256 `02c99046b503871a62a6b50c579ad83ba8e2ade44ae3ad78b80ce72029a058d0`. The durable [executable proof script](../scripts/verify-runtime-upgrade.ts) passed all four cases against this actual binary and the retained predecessor. Unlike the earlier probe, the lifecycle case additionally queried real reclamation plans while the consumer and reporter were pending: both protections remained and no candidate was collectible. The deliberately incompatible fixture was rebuilt from the same final implementation, with only its test contract/certification selection changed.

Focused Linux ARM64 checks passed **70 tests, zero failures, 350 assertions across nine files** (54.64 seconds), in `oven/bun:1.4.3` with 3 GiB memory and two CPUs. They include format fences, crash recovery, the executor, archived startup and the child-report correction. They do not enable a Linux executable transition.

The [certification record](runtime-upgrade-certification.json) retains executable/result/log digests and the 450-file source/configuration/example/script manifest. The final full suite passed **709 tests, zero failures, 6,035 assertions across 166 files** in 1,221.02 seconds. The final comparison found zero changed, added or missing files in that 450-file selection, and all three proof executables retained their recorded hashes. See [operator guidance](runtime-upgrades.md) for offline commands, supported scope and recovery-copy rollback.

## Following the format-2 predecessor

The subsequent transition keeps the approved command surface and now targets repository storage 3. A format-2-to-format-2 candidate passed replay but failed the mandatory real predecessor-writer test: the retained `677f…` binary's `run reclaim plan` returned exit 0 and changed `state.sqlite`. The candidate was rejected, and its interrupted/failed check logs remain separate from final verification.

The corrected executor derives the prior owner and exact runtime marker from the verified recovery image. Credentials and extension envelopes transfer to the new owner. Abort restores the old bytes when unchanged, or retains changed logical values under that prior owner. A populated vault stays at database version 2. An empty sentinel transfers by staged atomic replacement: SIGKILL testing rejected an initial in-place SQLite update because its hot rollback journal could not be inspected safely. The replacement survives death before staging commit, after commit and after installation, including the reverse transfer on abort.

Storage 3 makes the actual format-2 predecessor's normal readers/writers reject the repository marker. Current offline vault, run-reclamation and extension entry points additionally require the recorded owner build/platform before opening storage; understanding a supported schema is not sufficient permission. Old completed format-2 receipts remain readable and byte-stable, and their exact migration list stays distinct from the new format-3 list. Native execution data, revision IDs, bundle bytes, accepted receipts and encrypted vault contents are not rewritten.

The final runtime build is `fe46ad3fa836f61192ee29d76695082ced3d571857716442a22031e45eef79a2`. Its release executable SHA-256 is `a69d21b724f053b90453e29d9dd408523c4cfc40b76974bdebcc4ff302a286bf`. The runtime source stayed unchanged during the final checks. Packaged agent guidance was refreshed before the final isolated suite and release proofs to describe certified transitions and the offline command sequence instead of requiring an exact ABI match unconditionally.

Both exact predecessor/source-format combinations passed the four real-executable cases: legacy `9f…` storage 1 and `677f…` storage 2, each to storage 3 on Darwin ARM64. The format-2 matrix first creates a real format-2 repository with the legacy executable and intermediate executable; pending work from both revisions survives the next upgrade and verified recovery-copy rollback. A source-driven checkpoint asserts the exact target ABI, tests actual predecessor offline writers during partial transfer, and resumes with the compiled target. Separate component workers supply deterministic SIGKILL coverage. The incompatible fixture verifies refusal before pending work settles, archived-data reads afterward, and explicit rejection of operations needing the incompatible code. It is not a shipping contract.

Corrected Linux ARM64 component verification passed **64 tests, zero failures, 432 assertions across five files** (215.89 seconds). This covers migration, ownership, writer refusal and process-death recovery; it does not certify a Linux executable transition. Final isolated verification passed typecheck, formatting/lint and **748 tests, zero failures, 6,317 assertions across 169 files** (1,419.95 seconds). All 457 captured files remained unchanged, with no additions or removals; the four proof executables retained their recorded hashes. The [current certificate](runtime-upgrade-format2-certification.json) records both exact transitions, the source manifest, log digests and earlier rejected/interrupted checkpoints. The embedded agent guide now describes certified compatibility and offline upgrade commands; its regenerated assets passed focused checks before the final build and isolated suite.
