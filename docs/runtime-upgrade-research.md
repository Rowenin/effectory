# Runtime upgrade compatibility evidence

Date: 2026-11-07. Research for the user's runtime/V1 priority. The [runtime-upgrade contract](runtime-upgrade-api-draft.md) is now user-approved and implementation is in progress. The probes below remain research evidence, not certification of the full transition. UI and provider work remain deferred.

The [machine-readable result record](runtime-upgrade-probe-results.json) preserves observations and SHA-256 hashes of the scratch scripts/logs. The scripts remain outside the checkout; this is research evidence, not an installed regression suite.

## Source boundaries

| Boundary | Current implementation | Consequence |
| --- | --- | --- |
| Build identity and execution compatibility | `host-runtime.ts:sourceAbi` hashes core/runtime/platform-bun TypeScript; binaries embed that hash | A source edit changes the acceptance boundary even if stored execution semantics do not change |
| Retained application identity | `revisions.ts` requires the current ABI, checks bundle digest, and derives revision identity from the recorded ABI and digest | Replacing an old manifest's ABI is not a migration; it also changes identity and does not establish safe replay |
| Catalog startup | Every retained revision is verified and its Layer built before startup succeeds | One incompatible retained revision blocks the whole catalog, including when its code is needed only for historical inspection |
| Project upgrade | `sdk.ts:upgradeProject` updates package pins and a project marker | It does not migrate execution state or make old bundles compatible |
| Host storage | `host-store.ts:createStore` creates/alters tables; run-history retirement deliberately renames a column older hosts require | Compatibility cannot be inferred from package version or from bundle compatibility alone |
| Native execution storage | `engine.ts` builds the installed Effect cluster engine; `SqlMessageStorage` runs its own migrations | Host-store migration is not a substitute for a supported Effect storage/replay transition |
| Vault storage | `vault-store.ts` opens lazily, checks `user_version` and uses an external root key | Startup and upgrade must not need vault credentials or acquire providers merely to inventory state |
| Repair and backup | Run reclamation and extension recovery precede host readiness; backup refuses certain pending markers and has bounded size | Upgrade admission must account for pending work, supported recovery ownership and backup limits |
| Historical reports | Report retry is currently admitted through HostStore; code lookup happens later | Archiving an incompatible revision needs an early retry refusal, not a queued report that can never execute |

The current native engine is Effect 4.0.5. Its migration code was read locally; no Effect dependency upgrade was performed.

## Probe 1: unchanged application, different ABI

Scratch files: `/tmp/effectory-runtime-upgrade-probe/{host.ts,probe.ts,results.log}`. The scripts use real `hostLayer`, `revisionCatalogLayer`, SQLite, engine, runner and scheduler on disposable repositories. Separate Bun processes substitute two 64-character ABI constants using Bun's define option. These simulate build identities; they are not two released binaries with different interpreter implementations.

Observed and asserted:

1. ABI A starts a fresh empty application and writes a retained manifest. A second A process starts successfully.
2. ABI B refuses that same repository with RevisionUnavailable before the host Layer becomes ready.
3. The real `upgradeProject` operation under B succeeds and changes project package metadata, but a subsequent B startup still refuses the retained revision.
4. To check one refusal-ordering case, the probe changes the disposable database's current `admissionLane` column back to the predecessor `admissionNamespace` name. B's refused startup leaves that column unchanged. This is a synthetic legacy-schema case, not a complete old database fixture.
5. A starts again successfully afterward.

This demonstrates the compatibility blocker and the limited role of project upgrade. It does not prove that every refused startup is non-mutating: other recovery markers, orphan directories and different schema combinations were not exercised. It does not prove downgrade compatibility across an actual schema migration.

## Probe 2: pending durable run and original-host recovery

Scratch files: `/tmp/effectory-runtime-upgrade-probe/{wait-host.ts,wait-probe.ts,wait-results.log}`. This uses the same controlled ABI substitution, the real retained application loader and real persistent engine. It does not use a mocked Catalog or the in-memory workflow engine.

The generated application has a manual task that appends one audit line and returns a string, followed by an approval. The driver:

1. Starts A, submits the workflow through Runner, and waits for Waiting plus an Open approval.
2. Kills that host process with SIGKILL and awaits exit.
3. Starts B, which fails catalog construction. Direct read-only SQL confirms that the run remains Waiting on the same revision and the approval remains Open.
4. Starts A, repeats the original submission key, approves the wait through Runner, and observes Succeeded.
5. Asserts identical run and revision identities and exactly one audit line from the completed manual task.

Observed run: `d1a34831-fd49-49e0-bc54-0904f3470a44`. Pinned revision: `ca6dd11e465d9f366f5e5b408aa37a23990b32c0a46b9d5375aeb505b730c51d`. Result: `done`; task executions: one. All child processes exited and were awaited. Disposable repositories were retained under `/tmp` for inspection; no user repository database, credentials or application was used.

The probe does not exercise HTTP/CLI daemon orchestration, compiled release binaries, an uncertain task interrupted inside its body, different Effect versions or actual schema migration. Those remain implementation gates.

## Probe 3: history without retained application code

Scratch files: `/tmp/effectory-upgrade-inspection-probe/{read.ts,probe.ts,results.log}`. This copied the completed repository from probe 2, removed `effectory.ts` and the retained `application.mjs` from the copy, and used separate Bun processes. It did not delete a user bundle or change production startup.

Observed and asserted:

1. The normal host using the original controlled ABI A refused with RevisionUnavailable before becoming ready. This isolates unavailable application code from an ABI mismatch.
2. A harness with `hostStoreLayer` and repository ownership, without Catalog, read the successful run/result, all eight events and its settled approval. The log page was empty as expected for this fixture.
3. A harness additionally using the installed `engineLayer`, without interpreter registration, Runner, scheduler or Catalog, read the completed task output `done` and a summary with one successful task. The original task audit stayed exactly one line. No task was re-executed.
4. Table-row hashes were unchanged after those three paths. This does **not** prove a read-only connection or absence of schema writes, SQLite locks, WAL/SHM changes or filesystem changes.
5. After renaming `admissionLane` to the predecessor `admissionNamespace` in the copy, the store-only read succeeded **and renamed the column back**. This is the constructor migration at `host-store.ts:createStore`, reached without a mutation RPC. It is a synthetic predecessor shape, not a certified old release fixture.

The first scratch assertion used the wrong output field name (`value` instead of the actual `result`) and failed after a successful native read. The corrected assertion and the explicit legacy-column assertions passed on fresh copies. All child processes exited and were awaited.

### Inspection dependency map

The following wider classification is source inspection, not additional probe coverage:

| Operation | Data dependency after services exist | Current startup barrier |
| --- | --- | --- |
| Run get/list/events/logs/waits/checks | Host tables and protocol schemas | ControlPlane construction still requires Runner, Catalog and other execution services |
| Report get/list/search | Host report/run tables; successful report content is stored run result | Same full-daemon dependency |
| Lake metadata/JSON/content | Lake tables and blobs, with current verification/ownership rules | Same full-daemon dependency; lake construction also performs initialization/recovery |
| Run outputs and summary | Host invocation facts plus native `leafExecution.poll` | Requires a compatible native message/result reader in addition to escaping Catalog startup |
| Describe/plan, vault-provider operations and report execution | Retained registry/provider code | Cannot truthfully substitute current application code for an incompatible revision |
| Cancel/recover | Durable mutation and continuation/engine ownership | A store-level receipt alone is not proof that stopped work has quiesced |

Consequences for the pending design:

- Keep storage compatibility checks ahead of constructor migrations. Merely moving existing `hostStoreLayer` into an inspection path is not enough to promise non-mutating access.
- Separate initialization/migration from existing query operations, preserving the same authorization, schema validation and paging limits. Do not create a second looser history decoder just to bypass startup failures.
- The installed native engine can read this current-format result without loading the application. That is not proof it can decode future/past Effect formats. Normal `engineLayer` still builds SingleRunner and SQL storage; it is not a proven offline/read-only inspection adapter.
- The installed `SqlMessageStorage` source exposes separate migration and storage Layers. Investigate those supported primitives when implementing the approved boundary; do not edit native engine tables or assume migration-free construction is write-free.
- Cancel of unavailable historical work remains unproved and must use a compatible execution host until its lifecycle is tested. This probe used a completed run and made no cancellation claim.

## Probe 4: unknown durable work and readiness

Scratch files: `/tmp/effectory-outbox-upgrade-probe/{probe.ts,results.log,stderr.log}`. The probe used the actual CLI and daemon on a copied disposable repository with the example application from the agent-authoring check. It inserted one synthetic `FutureOperation` row into `host_outbox` before startup, associated with an existing run. No real user's durable work was touched.

The current `Outbox` schema strictly allows Dispatch, Settle and Cancel. `HostStore.outbox()` decodes its whole selected page before returning it, so an unknown kind fails with an operation error. Consequently the old review concern that an unfamiliar kind would reach dispatch and be acknowledged is **not true of the current build**. Recovery continuation also uses its separate durable tables rather than a new outbox kind.

However, the real process showed a different gap:

1. `daemon start` succeeded with readiness Ready.
2. A new background workflow submission was accepted and remained Queued.
3. `daemon status` still returned Ready while the runner logged 40 reconciliation retries over startup, submission and observation. The unknown row remained `delivered = 0`.
4. Removing only the injected row in the fault-injection driver allowed the accepted run to finish as Succeeded with `Hello, Future`.
5. `daemon stop` exited 0 and removed its endpoint metadata. All command subprocesses were awaited.

This confirms preservation of unknown work, but also that schema rejection in the runner loop is not a startup compatibility gate. The cause is visible in source: `runnerLayer` catches tick errors and continues its background loop; SystemStatus maps readiness from drain state, not reconciliation health. Once outbox decoding fails, that tick does not reach dispatch, run reconciliation, report reconciliation, read-pin cleanup or its following recovery continuation. Expiry/check reconciliation precede the failing decode, and other services have separate loops; this is not a claim that the whole daemon becomes read-only or frozen.

The pending upgrade contract must validate supported durable work before readiness/admission, not rely on first use. Preflight must cover every pending row in bounded pages, including unsupported entries beyond the runner's first 200 and orphaned records hidden by its join. It must also classify the separate recovery/retirement/extension/install journals before invoking their mutation-capable recovery routines. Those cases are proof obligations, not tested by this one-row probe.

Do not delete unknown production intents to make a host run. Use the compatible host or a validated recovery copy. The deliberate deletion above isolated the injected fault; it is not a recovery command or a proposed migration.

## Probe 5: partial catalog startup and Scope ownership

Scratch files: `/tmp/effectory-revision-ownership-probe/{host.ts,probe.ts,results.log,layer-cause.ts,layer-cause.log}`. The seed process used the real catalog to prepare/activate three revisions. Each application provided a synthetic resource with Effect `acquireRelease`, recording a fresh ID at acquisition and the same ID at release. The driver chose the second retained revision in the catalog's actual directory order for failure/interruption, ensuring an earlier revision had already acquired a resource. Each restart ran in a fresh Bun subprocess with the installed host and Effect implementation.

| Case | Acquired/released callbacks | Result |
| --- | --- | --- |
| Normal catalog startup and scope close | 3 / 3 | Success |
| Invalid manifest for the second retained revision | 1 / 1 | RevisionUnavailable |
| Typed failure after the second revision acquires | 2 / 2 | RevisionUnavailable |
| Defect after the second revision acquires | 2 / 2 | Defect preserved |
| Fiber interruption after the second revision acquires and blocks | 2 / 2 | Interruption preserved |
| Acquisition failure plus a defect in that revision's finalizer | 2 / 2 | RevisionUnavailable; accompanying cleanup defect absent from final Cause |
| Successful acquisition followed by a cleanup defect | 3 / 3 | Defect preserved; other finalizers still run |

Every acquired ID had exactly one release callback before the observed catalog exit. After each case, the same process successfully acquired and released the repository ownership Layer again, checking that ownership was not left held until process death. All subprocesses exited and were awaited. The interruption probe waited for the acquisition marker before interrupting; it did not infer acquisition from a fixed delay.

This corroborates the existing `loadApplication` child-Scope rollback and parent catalog ownership. No resource-leak correction is warranted by these cases. Keep this primitive structure when implementing lazy acquisition/eviction; do not add a custom finalizer registry merely for revision tracking.

The stronger cleanup-cause assertion initially failed: it incorrectly expected the mixed failure to retain its defect. An isolated probe against the installed Effect showed the distinction: plain scoped effects, Layer building and Layer provision preserve both the acquisition failure and cleanup defect, but adding `Effect.mapError` to the failing Layer build removes the accompanying defect. `loadApplication` applies that mapping to sanitize failures as RevisionUnavailable. This is a diagnostic limitation, not a leaked Scope or a successful startup after failure. A future lifecycle error mapper must explicitly decide how to preserve cleanup classification while still sanitizing provider details; this research does not change the current public startup error contract.

Limits: callbacks were synthetic and synchronous, not actual third-party client/socket cleanup. This does not show that finalizers finish after SIGKILL, that stuck finalizers have bounded latency, that JavaScript dynamic-import side effects can be cancelled, or that future eviction reference counting is correct. Existing checked-in lifetime tests cover ordinary retained startup and failed manifest publication; these additional cases remain scratch research rather than durable regression tests. No repository test suite was rerun for this documentation-only update.

## Probe 6: native result inspection and SQLite WAL

Scratch files: `/tmp/effectory-readonly-native-probe/{read.ts,writer.ts,probe.ts,results-final.log}`. These use the installed Effect storage and codec implementations in fresh Bun subprocesses. The driver copies probe 2's completed repository, removes `effectory.ts` and the entire retained revision directory, and reads the native task result without constructing HostStore, Catalog, WorkflowEngine, SingleRunner, Runner or the scheduler.

The read path provides `SqlMessageStorage.layerStorage({})` with `ShardingConfig.layerDefaults`, `BunCrypto.layer` and a read-only `SqliteClient.layer`. It selects the stored invocation engine ID, looks up the native request through `MessageStorage.requestIdForPrimaryKey`, and decodes its stored WithExit reply through the installed RPC/Workflow result schemas and Effectory's `ExecutionFailure`. It does not run the storage migration Layer or hand-edit native tables. The placeholder shard ID is safe only for this lookup: the installed `Envelope.primaryKeyByAddress` uses entity type, entity ID, method and request ID, not shard routing. This is not a proposed public address format.

The installed package reports Effect 4.0.5, and the storage-only export exists in this installation. Its source has later `@since` annotations; package version alone is not proof that another installation has this API. The result record includes hashes of the installed implementation files used by the probe. No dependency was updated.

For the crash cases, a separate writer commits a marker change from `checkpoint-old` to `wal-new`, with automatic checkpointing disabled. The driver waits for its commit acknowledgement, sends SIGKILL, awaits exit and asserts the termination signal. It preserves the nonempty WAL and removes SHM only in the disposable fixture to model missing bookkeeping. Each reader receives its own independent copy.

| Fixture and access | Observed result | File-content changes after inspection |
| --- | --- | --- |
| Checkpointed database, no WAL/SHM, ordinary read-only | SELECT failed with SQLite unable-to-open error | None |
| Same fixture, immutable URI plus read-only | Native result `done`; marker `checkpoint-old`; UPDATE refused | None |
| Crash-left WAL, missing SHM, ordinary read-only | Native result `done`; committed marker `wal-new`; UPDATE refused | Created `state.sqlite-shm` |
| Same crash fixture, immutable URI plus read-only | Native result `done`; **stale marker `checkpoint-old`**; UPDATE refused | None |
| Private copy of crash fixture, recovered/checkpointed before immutable inspection | Native result `done`; committed marker `wal-new`; UPDATE refused | None during inspection; original crash fixture unchanged throughout copy recovery |

All five cases completed and all child processes were awaited. File-content checks compare relative path inventories, byte counts and SHA-256 hashes; they do not assert unchanged access times or absence of transient filesystem operations. The original task audit stayed exactly one line. The marker is a synthetic host-independent table: the native result was already checkpointed, so this demonstrates WAL visibility, not a newly completed task result surviving this particular crash.

This establishes a migration-free, application-free native read on the current installed format. It also disproves treating either `readonly: true` or `immutable=1` alone as a safe, complete inspection boundary. Recovering/checkpointing a private copy with SQLite retained the committed marker and left the source bytes unchanged. Such a copy would have to be captured under offline ownership and independently checked before use; the scratch copy is not a production copy/rollback protocol.

Limits: one successful native task result; no alternate Effect version, corrupt/partial WAL, concurrent source writer, cross-platform filesystem, authentication, pagination, disk-full handling or interruption during copying. Missing WAL and missing SHM have different meanings; never discard a production WAL. No supported-format migration, inspection command or compatibility policy was implemented, and no repository test suite was rerun for these research/doc changes.

## Probe 7: recovered integrity versus committed WAL history

Scratch files: `/tmp/effectory-wal-corruption-probe/{probe.ts,results-final.log}`. This is a small fault-injection follow-up to probe 6, using five separate copies of its crash-left store and Bun's bundled SQLite. It does not start a daemon, engine or application. The original fixture's file inventory and SHA-256 hashes are checked unchanged after every case.

The original WAL contains one committed marker update already acknowledged by probe 6's writer before SIGKILL. Each independent copy is opened with ordinary SQLite, queried for the marker, checked with `PRAGMA integrity_check`, then checkpointed and closed. The deliberately injected faults are confined to those copies.

| WAL presented to SQLite | Marker returned | Integrity check |
| --- | --- | --- |
| Intact committed frame | `wal-new` | `ok` |
| Last byte of that frame flipped | `checkpoint-old` | `ok` |
| That frame truncated by one byte | `checkpoint-old` | `ok` |
| Only its 32-byte header retained | `checkpoint-old` | `ok` |
| Intact frame followed by an incomplete synthetic tail | `wal-new` | `ok` |

All opens/checkpoints succeeded. Recovery changed the private copies, including their WAL files; the source stayed unchanged. The final result record includes the SQLite version and script digest. This reproduces a distinction that the previous intact-WAL probe could not establish: integrity of the recovered view does not prove that an acknowledged transaction was preserved. Nor is every incomplete tail evidence that a committed value was lost.

For the pending upgrade contract, copying every source byte faithfully and successfully recovering that copy are separate proof obligations. A copy manifest detects transfer damage relative to its captured source; it cannot certify that the source was undamaged before capture. Preserve the original copy and its manifest before recovery rather than replacing the only evidence with a checkpointed database. Do not use a successful open, a zero-busy checkpoint or `integrity_check = ok` alone to certify complete history. The implementation still needs a supported rule for diagnosing uncertain/corrupt input and refusing a transition that cannot establish its required history invariants; this experiment does not supply that rule or justify inventing a native WAL parser.

Limits: one synthetic marker transaction on the installed SQLite, not a new native Activity result; manually injected damage, not measured filesystem failure; no proof of identifying the cause of an invalid tail from an arbitrary repository. This is not a corruption repair procedure or evidence that the current runtime lost data during the intact crash/restart tests.

## Probe 8: refusal occurs after recovery mutations

Scratch files: `/tmp/effectory-runtime-upgrade-probe/refusal-order.ts`, `refusal-order.log` and `refusal-order-results.json`. Each of three fresh disposable repositories was initialized by the real host with controlled ABI A, then opened by the same implementation with controlled ABI B. Every B startup refused with RevisionUnavailable; every later A startup succeeded. These are startup-ordering counterexamples, not distinct release certification.

| Fixture before B startup | Mutation before refusal |
| --- | --- |
| Unretained validation directory without a manifest | Catalog deleted the directory and its synthetic file |
| Valid leftover retirement marker plus synthetic predecessor `admissionNamespace` column | Recovery migrated the column to `admissionLane` and removed the marker |
| Accepted retirement intent, apply subprocess killed with SIGKILL immediately after durable intent | Recovery deleted the selected completed run's history, stored its Complete receipt and removed the marker |

The third case uses a synthetic completed HostStore run, not a real native workflow result. The plan/apply path and SIGKILL worker are the actual implementation; the operation was already authorized in this disposable fixture. It demonstrates completion of accepted destructive work before compatibility refusal, not arbitrary deletion or corruption. All subprocesses were awaited. No user repository or production source was changed.

This narrows the earlier probe-1 result: absence of schema mutation in the marker-free case does not establish a general refusal-before-write guarantee. `ownedHostLayer` deliberately runs retirement recovery before constructing Catalog; Catalog itself deletes incomplete revision directories before validating retained manifests. The future compatibility gate must precede both, and the daemon's earlier extension-recovery call must be covered too. An exact ABI refusal alone is not a non-mutating downgrade fence. Current A reopened all three fixtures, but that does not prove that a genuinely older implementation could recover after future-format work.

## Probe 9: compiled baseline and the offline-writer fence

A current darwin-arm64 host was compiled with the real `scripts/build-binary.ts` into `/tmp/effectory-upgrade-baseline/effectory-darwin-arm64`. Its source ABI is `9f1797ddc28f42ceb77fa8dac1c8806da9207d00a568a792874216237b965f97`, version `0.1.0`, binary size 81,430,130 bytes and SHA-256 `a17138f58bb9f1514d12e4bbcb54fa610067f993bd87f14caca0edf5cc55f13f`. All 381 captured source/configuration/asset/test files match the passing wake-correction verification. This is a retained baseline executable for subsequent distinct-build tests, not a second release or evidence of cross-build compatibility.

`/tmp/effectory-upgrade-baseline/marker-probe.ts` creates a disposable repository, initializes one empty synthetic local vault using the real store under repository ownership, and writes the existing `effectory.snapshot-incomplete` marker. Random encryption keys exist only in the scratch directory; no real secret or user repository is used. It then calls the compiled executable for both operations:

| Operation | Result | Durable effect |
| --- | --- | --- |
| `daemon serve` | Exit 3, incomplete-copy error | No daemon starts |
| `vault reset synthetic --discard` | Exit 0, discarded receipt | The initialized vault identity is deleted |

Both subprocesses were awaited. The probe checks the vault identity before and after with SQLite. It does not test an actual future migration or propose resetting a real vault as a recovery remedy. The marker retains its existing incomplete-copy purpose; no production behavior was changed.

This disproves using that marker alone as a universal old-writer fence. Source inspection explains the result: `offlineVault` acquires `state.sqlite.owner` directly and opens the local store; it does not enter the daemon's marker or Catalog checks. Offline run reclamation, extension restore and backup likewise have their own entry paths. A gate only in daemon startup cannot establish compatibility admission for all operations.

The upgrade release matrix must certify every supported predecessor executable against the affected write paths, including vault reset/import, run reclamation and extension recovery/restore, in addition to daemon execution. A new marker unknown to a predecessor is not proof of refusal. If no safe predecessor fence is established, that transition remains unsupported; do not manufacture a guarantee by relabeling manifests, corrupting an ownership database or assuming an old binary understands new metadata. The baseline binary, source manifest and probe results are retained in `/tmp/effectory-upgrade-baseline`; their hashes are in the machine-readable evidence.

## Interpretation and next action

Keep exact stored identities and the safeguard against unproven replay. Separate build provenance from an explicitly supported execution/storage compatibility contract. Compatibility must cover Activity names, invocation addresses, result/error encodings, manual entry authorization, pending timers/waits, report work, and Layer/resource semantics—not just TypeScript or SQL shape.

The source ABI of the earlier controlled-ABI audit snapshot was `4d6236b8d28b46d608744f70c3869afb755f6084bfd0cdef7576ac051a0e38df`. Recording it is provenance only, not certification that it is compatible with a future host.

See the [proposed upgrade policy](runtime-upgrade-api-draft.md). The next implementation should include durable fixtures and actual distinct host builds; scratch results above must not be promoted to those stronger claims. No repository-wide checks were run for this research-only change.

## Probe 10: candidate format fences against the actual predecessor

Scratch files: `/tmp/effectory-upgrade-baseline/{fence-probe.ts,fence.log,fence-results.json}`. This uses the same compiled predecessor and SHA-256 recorded in probe 9. The disposable fixture has real HostStore state, a synthetic local vault with an external key, and no real credentials. Candidate fences wrap credentials in a versioned identity envelope, advance the vault database version, and advance the extension lock format. These are experimental file shapes, not implemented migrations or a finalized compatibility edge.

The predecessor refused daemon startup, run reclamation planning/inspection, offline vault reset/key import, and extension restore. Database/WAL content, run state, synthetic encrypted vault state, external keys and package files stayed unchanged. **Byte-for-byte refusal did not hold:** the old vault reset opened SQLite and changed `vaults.sqlite-shm` before rejecting the unsupported database version. No reset or key import took place. The other measured commands left captured bytes unchanged (excluding the ordinary ownership lock).

This is stronger than a marker-only fence, but does not certify an upgrade. Installing several fences has crash windows: before every affected entry point is fenced, an old offline writer may still reach its old-format store. Migration must not begin in that interval, and recovery must detect any intervening source changes before using the original plan/copy. Neither that state machine, interrupted fence installation, rollback, nor actual old/new-host execution was tested here. No production format was changed by the probe. All subprocesses were awaited; the disposable repository and synthetic external key directory were removed.

## Probe 11: partial fence installation and intervening writes

Scratch files: `/tmp/effectory-upgrade-baseline/{partial-fence-probe.ts,partial-fence.log,partial-fence-results.json}`. The same saved predecessor executable was run against a disposable synthetic vault after only the candidate credential envelope had been installed. Its daemon refused, but `vault reset synthetic --discard` succeeded. A logical comparison of the vault tables detected that write even after the vault format stamp was subsequently advanced. With both fences present, the predecessor refused the next reset.

The experiment then reversed only the candidate format fields and verified that the old reset remained intact. The captured pre-fence database still contained the deleted value: restoring it would undo the intervening operator action. A restartable transition must therefore distinguish its own format writes from intervening predecessor writes, before any semantic migration. Automatic abort must not restore an older data snapshot over those writes.

This is a real predecessor offline-write counterexample with a scratch whole-table comparison, not a production migration/intent implementation, bounded scanner, process-kill test or rollback certificate. All commands were awaited and the synthetic repository and external key directory were deleted.
