# Run-history retention research

Status: **research evidence; no implementation approved**, 2026-11-06. A [separate offline reclamation proposal](run-history-retention-api-draft.md) now records the public decisions. This is a remaining Swamp-parity candidate after Checks/JUnit. No production code is changed by this research.

## Evidence from the pinned sources

Swamp distinguishes workflow-run retention from snapshot, output, data, audit and bookkeeping retention (`vendor/swamp/src/domain/retention/retention_policy.ts:25`). Its collectors process runs before associated snapshots and outputs (`vendor/swamp/src/libswamp/retention/collectors.ts:73`). Run collection is bounded and additionally cleans wait records and snapshots (`vendor/swamp/src/domain/data/run_lifecycle_service.ts:193`).

Its run repository excludes unfinished runs and preserves completed runs needed by unfinished or unreadable parent/child runs (`vendor/swamp/src/infrastructure/persistence/yaml_workflow_run_repository.ts:1271`). These are source observations, not execution tests of Swamp. Effectory's child workflows share their host run, so its exact dependency shape differs.

Effectory currently retains host runs and native workflow results indefinitely. Artifact reclamation deliberately does not remove them. Checks add bounded per-run diagnostics, but neither the number of runs nor total history size is bounded. The current backup size caps therefore remain relevant even after artifact reclamation.

## Effect primitive worth using

Pinned Effect 4.0.5 exposes `MessageStorage.clearAddress` (`node_modules/effect/src/cluster/MessageStorage.ts:200`). `SqlMessageStorage` deletes an address's messages and replies in one storage transaction (`node_modules/effect/src/cluster/SqlMessageStorage.ts:762`). Prefer this capability over duplicating native message-table SQL.

This is not a complete workflow-deletion API. `WorkflowEngine` has execute, poll, interrupt and resume but no general forget operation. `ClusterWorkflowEngine` maps execution identities to `Workflow/<name>` addresses, and uses a distinct `Workflow/-/DurableClock` entity for clocks. The current interrupt path attempts clock cleanup (`ClusterWorkflowEngine.ts:528`); ordinary successful completion must not be assumed to remove clock addresses. A future implementation must enumerate the root and task execution identities, prove quiescence, account for controllers and clocks, and handle in-memory entities/cached replies. Clearing one address alone is not evidence of safe run retirement.

A scoped collector can own its fibers with ordinary Effect Scope and Layer. Scope finalizers cannot make durable multi-connection deletion atomic, and process death can occur between host tombstoning and native cleanup. A durable cleanup intent with restart recovery would still be needed.

## Contracts that must be decided first

1. **Submission deduplication.** The host run is also the receipt for `(principal, namespace, requestKey)`. Deleting it must not allow a delayed retry to execute the external task again. A retained receipt/tombstone or a separately approved finite idempotency horizon is necessary. The response to a retry whose detailed history is gone needs an explicit contract.
2. **Report regeneration.** Reports can be retried long after source completion and `Report.History` polls native task outcomes. The current contract retains those outcomes while retry remains possible. Either retirement refuses such sources, retires the report family together, or deliberately ends regeneration rights. “No pending reports” alone is insufficient.
3. **Artifact provenance.** Lake versions retain producer run ids. Reader protection distinguishes missing consumer runs conservatively. Run deletion must preserve artifact access and keep missing-record protection from stranding pins forever; artifact content should not be deleted implicitly.
4. **Schedules and history links.** Schedule summaries and history currently call host `getRun` for the last/active run. A reclaimed run cannot silently break `schedule get` or history inspection. Immutable retained summary facts or explicit reclaimed-link behavior are needed.
5. **Live observers and cursors.** Retiring a terminal run can race a watch replay, JUnit export, report inspection or history cursor. The API must state whether existing readers are protected or receive a typed expiry. Partial pages must not silently masquerade as complete history.
6. **Revision resources.** Application Layers for retained revisions live until daemon shutdown. Deleting the last run does not by itself unload a revision, and deleting a revision could break a queued report. Runtime Layer retirement and durable history deletion should have separate, explicit eligibility rules.
7. **Physical space.** SQLite row deletion normally creates reusable database pages; it does not promise immediate file shrinkage. WAL/checkpoint and offline compaction must be described separately from logical reclaimed bytes. Reclamation itself needs space to write its journal.

## Required next evidence

Before proposing a public command, build a scratch proof using the actual engine and message-storage service: finish root/child/retry executions, clear their exact addresses, restart, verify no replay, and verify an unrelated unfinished execution still resumes. Probe retained in-memory entities and pending clocks. Map every host/lake/report foreign key and receipt dependency, and specify a crash-safe retirement ordering. Test idempotent submission after retirement before claiming space recovery is safe.

This research itself selects no retention contract. The subsequent proposal recommends offline maintenance and permanent compact deduplication records; those choices remain unapproved.

## First engine probe

A scratch program outside the checkout used the real Effectory `engineLayer`, repository ownership Layer, pinned SQL cluster engine, native Workflow/Activity and public `MessageStorage.clearAddress`. One completed Activity returned 1. Clearing its workflow address made `poll` return None. After closing and rebuilding the engine, submitting the same workflow identity executed its body again and returned 2 (two total calls).

This is a real-engine cleanup/deduplication probe, **not a run-retention implementation test**. It confirms that native deletion alone discards execution deduplication. It does not establish safe live-entity retirement, child/clock cleanup, report preservation or crash ordering. Script and captured JSON: `/tmp/effectory-checks-research/retirement-probe/probe.ts` and `result.log`.

## Storage-only cleanup probe

A second scratch probe completed a native parent and child with durable-clock work, then left an unrelated parent suspended on a timer. It closed the engine before constructing a storage-only `SqlMessageStorage` Layer under exclusive repository ownership. Clearing the completed parent/child and both clock addresses left zero messages at all four addresses. Rebuilding the engine returned None for the removed parent and completed the unrelated parent without replaying the deleted child. The final Activity call count was two: one for each distinct family.

Script and result: `/tmp/effectory-checks-research/retirement-probe/offline.ts` and `offline.log`. These are scoped engine restarts in one process, not process-kill or full Effectory retirement tests. The evidence supports proposing offline ownership; it does not justify live in-memory entity deletion.

## Storage dependency audit

The [storage audit](run-history-retention-storage-audit.md) enumerates 50 initialized tables and 11 triggers. A scratch dependency probe confirms that deleting events leaves derived report-path rows, and deleting a terminal producer changes its artifact from unprotected to conservatively protected. The proposal now includes explicit path cleanup, consistent compact-record lookup across all protection paths, recovery before the whole host Layer builds, and a durable filesystem marker for non-mutating backup refusal. These are design corrections; no retention commands are implemented.
