# Runtime upgrade and retained revision policy

Status: approved by the user and implemented. The four concrete Darwin ARM64 transitions from storage 1, 2 and 3 to storage 3 passed real predecessor/target, offline-writer and rollback proofs, plus the full required checks. See [supported transition and operator commands](runtime-upgrades.md) and [certification evidence](runtime-http-disconnect-certification.json); other transitions remain unsupported. This is part of the [runtime V1 plan](runtime-v1-plan.md); [current evidence](runtime-upgrade-research.md) establishes the existing failure and the limits of the probes.

The [implementation record](runtime-upgrade-implementation.md) preserves the component checkpoints, findings and final transition/lifecycle verification.

## Proposed compatibility contract

Keep the source/build fingerprint for provenance and integrity. Introduce a separately versioned execution compatibility contract, maintained by Effectory releases and backed by replay tests. Two different host builds may execute the same retained application only when the new host explicitly supports its contract and stored data formats.

This is not permission to resume arbitrary old JavaScript with a newer SDK. Compatibility covers host-shared SDK services, the Effect engine, native message/result encoding, deterministic workflow/activity identities, error encoding, deadlines, recovery admission and ownership. An incompatible change advances the contract; a version label alone is not proof. An Effect dependency update needs its own compatibility evidence even if the application API looks unchanged.

Existing revision IDs and bundle bytes stay immutable. New manifests record their build provenance and execution contract. For legacy manifests that contain only a source ABI, accept either the exact matching build or an explicitly certified legacy-ABI mapping shipped by the host. Never assume every build named `0.1.0` is compatible and never offer a force flag that rewrites manifests or skips validation.

Storage has a separate supported-format range and ordered migrations, including the native Effect database. Check these before constructing the engine, loading application Layers, dispatching outbox work or running the scheduler. A release must explicitly state which predecessor formats it can read, write and upgrade. Unsupported storage fails closed with an actionable message before mutation.

The [startup-ordering counterexamples](runtime-upgrade-research.md#probe-8-refusal-occurs-after-recovery-mutations) show that ABI refusal currently happens after orphan cleanup, and after pending retirement recovery can migrate a schema or complete history deletion. Put the gate before those mutations; merely checking inside Catalog is too late.

That gate must also inspect durable work formats before readiness or admission and before calling mutation-capable recovery routines. Page through all pending outbox rows and the separate recovery/extension/retirement/install journals; do not rely on the runner's first 200 joined rows or a schema error after startup. Unsupported/orphaned work stays untouched and is reported with the required compatible host/recovery path. The current host preserves an unknown outbox kind but still reports Ready and accepts runs while reconciliation retries, as the [real-daemon probe](runtime-upgrade-research.md#probe-4-unknown-durable-work-and-readiness) demonstrates. No new readiness state is proposed here; the upgrade gate must prevent execution startup on unsupported state.

## Compatible upgrades

A compatible upgrade preserves all accepted run identities, pinned revisions, request-key receipts, completed activity results, pending waits/timers, recovery holds and authorizations, report obligations, schedule occurrences and artifact protection. Stopping and restarting the host still follows the existing replay policy: an interrupted manual task may require operator recovery; compatibility never implies automatic re-execution permission.

The host can execute retained compatible bundles without rebuilding them from current application source. Current source may be compiled as a new revision for future submissions. It must not replace the revision of an accepted run. Changing only the host build must not reset schedule generations, watermarks or pending occurrence request keys.

## Breaking upgrades

V1 does not promise to translate arbitrary in-flight execution between incompatible interpreters. The recommended policy is to refuse a breaking transition until affected work has settled under a compatible old host.

Affected work includes every nonterminal run (including NeedsAttention), pending report obligations and continuations, unsettled recovery work, dispatch/notification intents and pending scheduled admissions tied to the old definition. The preview must enumerate categories and counts with bounded pagination. Merely stopping the daemon or seeing zero active handler fibers is not sufficient.

The operator can finish or deliberately cancel work using the compatible old host and reassess. A timed-out/cancelled source can itself create report work, which also has to settle. No implicit cancellation, synthetic successful outcome, report dropping or submission-key reset is allowed. Pending filesystem/extension/retirement recovery must complete with a host that understands its format before transition; the new host must not acknowledge unknown work.

After a breaking transition, completed data remains inspectable without executing incompatible revision code. Preserve stored run/events/logs/checks/report content, artifact metadata/content, receipts and compact retired-run identity according to existing retention rules. Operations that require an incompatible registry—such as historical describe/plan, vault-provider access or report regeneration—fail RevisionUnavailable with the needed compatibility information. Report retry must refuse before admitting a new generation. Do not silently use today's application in place of the source's revision.

The preview must disclose loss of executable historical operations. Code-independent inspection is a required deliverable, not a claim that every current inspection path already avoids Catalog or engine decoding. Unsupported native history formats still require a verified migration/read adapter before transition is allowed.

The inspection implementation must separate storage initialization/migration from query access as well as separate application loading from history access. Current `hostStoreLayer` can migrate a predecessor schema merely on construction; current `engineLayer` also constructs the native runner/storage stack. Neither is a read-only inspection boundary. Stored run/report records can use the existing validated host queries; task outputs and summaries additionally require a certified native result reader. Preserve authorization and paging limits in both paths. The [application-free inspection probe](runtime-upgrade-research.md#probe-3-history-without-retained-application-code) establishes feasibility on the installed engine only.

Read-only SQL is not sufficient to promise unchanged repository files. The [storage-only inspection probe](runtime-upgrade-research.md#probe-6-native-result-inspection-and-sqlite-wal) read native results without a runner, but ordinary read-only access created a missing SQLite shared-memory file. Immutable access left file bytes unchanged while silently ignoring a committed WAL update. Never use immutable mode on an arbitrary source repository or remove its WAL to make inspection work. Under offline ownership, a consistent private copy including the WAL can be recovered and checkpointed without migrating application schemas; inspection can then use that copy. The implementation must verify copy consistency, bound temporary storage, protect and clean up the copy, and preserve source bytes on every failure. This is an internal candidate mechanism, not a new command or a claim that the copy protocol is already implemented.

Preserve an unmodified recovery copy and manifest before checkpointing a separate inspection copy. A faithful copy proves fidelity to the captured bytes, not that those bytes contain all acknowledged transactions. The [damaged-WAL probe](runtime-upgrade-research.md#probe-7-recovered-integrity-versus-committed-wal-history) returned stale data with `integrity_check = ok`; successful open/checkpoint/integrity checks cannot alone certify complete history. Establish the required history invariants before permitting a transition and refuse unverified corruption/uncertainty rather than reporting recovery as complete. The precise validation mechanism remains an implementation proof gate, not a solved guarantee.

## Operator surface to implement after approval

Proposed additional subcommands:

```sh
effectory upgrade plan
effectory upgrade apply PLAN_ID
effectory upgrade inspect PLAN_ID
```

Keep bare `effectory upgrade` as the existing dependency-pin operation, with clearer output that it does not migrate runtime state. The new subcommands run offline under repository ownership, never stop/start a daemon automatically and use existing `--repository` and `--json` conventions. An active owner is Conflict; an unsupported execution/storage transition is RevisionUnavailable. Both retain the existing exit code 5. Invalid arguments remain exit 2; unavailable storage remains exit 3.

`plan` inspects state without executing application code or migrating databases. It writes only a bounded plan record on successful planning. Its output identifies source/target compatibility, executable/archived revisions, blocking work, required migrations and recovery/backup prerequisites. Do not describe it as a completely read-only command if it persists this record. A source dependency/lockfile fingerprint and repository state identity bind the plan; apply rechecks both, including any new report retry or schedule state. Large scans must yield between bounded reads and have explicit limits in the implementation contract.

`apply` validates the plan before writes, requires an independently verified stopped-repository recovery copy, and records a durable transition intent before migration. It does not claim SQLite rollback makes filesystem, multiple databases and package files atomic. Every step must be restartable, with a fail-closed startup gate until the exact transition completes. Repeating an accepted plan resumes its intent or returns the stored receipt before freshness/expiry checks. `inspect` reports durable progress and the last completed step without acquiring application services. A stale unaccepted plan must be regenerated.

The existing backup's 1 GiB total and 128 MiB file limits remain real constraints. A verified offline copy is necessary for larger repositories. The detailed proof/manifest accepted for either recovery-copy path must be specified and tested before implementing apply; this proposal does not invent a guarantee that every existing backup fits. The external vault key remains external and must be recoverable independently.

Rollback in V1 is restoring that pre-upgrade copy and using its compatible host. There is no promised reverse migration of a repository that accepted new writes. Restoring a snapshot also restores its older deduplication state; operators must account for external actions performed afterward. An older unsupported writer must refuse an upgraded store, including old hosts that do not understand the new compatibility marker. This requires a proven downgrade fence; documentation alone is insufficient. Certification covers the daemon and every affected offline writer: run reclamation, vault reset/key import, extension restore and recovery. The [compiled-baseline probe](runtime-upgrade-research.md#probe-9-compiled-baseline-and-the-offline-writer-fence) shows that the existing incomplete-copy marker blocks daemon startup but not offline vault reset. Do not repurpose it or assume a new marker protects against a predecessor that never checks it.

Publish supported transition edges between concrete predecessor builds/formats and the target contract. Preserve a known predecessor executable plus its digest with the transition evidence. If an edge lacks a proven fence, migration or history reader, `plan` reports it as unsupported and `apply` refuses it; the release must not advertise that path as compatible. A broad version range or equal package version does not establish an edge. This is a shipping gate for each claimed path, not permission to silently drop the approved requirement for compatible upgrades.

## Revision lifecycle

Separate retained code/metadata from live application resources. A compatible revision acquires its application Layer when needed; the active revision and all in-flight users hold it. Application services must not be closed while a run, report, provider operation or catalog operation is using them. Retiring a loaded revision closes its Scope once after references drain, not merely when one handler finishes. Historical inspection should use stored data where possible rather than reacquiring external services.

Do not automatically delete archived bundles in this upgrade slice. Physical revision pruning remains a separate previewed lifecycle operation with explicit dependencies and approval. Deleting bundles, unloading Layers and retiring run history are different actions. Keeping metadata must not require holding a database connection or provider Layer forever, and removing a Context does not unload a JavaScript module.

## Approved decisions

1. Use explicit tested execution/storage compatibility instead of exact source-hash equality as the sole upgrade rule, preserving pending runs across compatible builds.
2. Refuse breaking upgrades while affected work remains; afterward retain data inspection but explicitly refuse execution-dependent operations for incompatible historical revisions.
3. Add offline `upgrade plan|apply|inspect`, preserve bare upgrade's project-pin behavior, and support rollback through a verified recovery copy rather than reverse migrations.

The precise bounded plan/receipt schemas, recovery-copy validation and revision eviction rules need to be completed against these choices before code ships. This is a policy/command proposal, not a claim those internal mechanisms have already been proved.

## Implementation proof gates

- Actual distinct builds: compatible patch upgrade of a sleeping/retrying/waiting workflow, completed manual activity reuse, uncertain manual recovery, report continuation and schedule catch-up without identity changes.
- Incompatible builds: refusal with open work, actionable inventory, no unwanted storage changes, and old-host recovery. No bypass by changing package versions or manifest labels.
- History-only incompatibility: start new compatible work and read retained data without loading archived code; code-dependent operations refuse before mutations.
- Inspection files: checkpointed stores and crash-left WALs, missing/present shared-memory files, interrupted/private-copy recovery, failed copies and full temporary storage. Preserve committed results and source file bytes, including WAL/SHM; never substitute an immutable view that omits committed state. Verify authorization and bounded paging separately from native decoding.
- Storage: explicit forward migrations and old-writer refusal across daemon and affected offline entry points (including an actual predecessor executable); native Effect migrations are tested through supported APIs. Crash each migration/publication boundary and recover the same transition exactly once.
- Unsupported durable work: unknown kinds at the start and beyond the first outbox page, orphan rows, and unsupported recovery-journal versions refuse before readiness, admission or recovery writes. Preserve original bytes and demonstrate recovery with the compatible build. A generic reconciliation retry warning is not a passing result.
- Backup/restore: verified small and large repository recovery copies, pending-work refusal, missing external vault key behavior and rollback with the original host.
- Catalog ownership: concurrent users, failed Layer acquisition, provider operations, shutdown, retries and revision eviction release resources exactly once after their users finish.
- CLI: lost apply response, repeated/expired/stale plan, inspect during interrupted work, correct error codes, no implicit daemon stop or run cancellation.
- Full required checks plus a source-state manifest. Existing single-build tests and the controlled-ABI probes are not substitutes for these gates.
