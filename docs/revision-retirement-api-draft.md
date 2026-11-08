# Retained application revision reclamation

Status: **approved by the user on 2026-11-08; implementation in progress**. This is the next lifecycle item in the [runtime V1 plan](runtime-v1-plan.md). It implements the approved upgrade contract's requirement for previewed bundle maintenance without treating a compatible upgrade as permission to delete code. The [research and actual daemon evidence](revision-retirement-research.md) establish the limit; they do not test the proposed deletion mechanism.

## Problem and recommended policy

The catalog retains at most 128 application revisions. A successfully prepared candidate consumes a slot even if it is never activated. In the actual release executable, a repository with one active revision and 127 never-activated candidates cannot start on a new source revision. Restoring its original source lets it start and execute again. Existing run-family reclamation and artifact retention do not remove bundle files.

Add explicit offline reclamation of **unreferenced application revisions**. Keep every revision used by a retained run, including completed source and report runs, and by live scheduling/administrative dependencies. Compact retired-run identities remain readable but do not keep executable code forever. No automatic bundle deletion, age policy or force option.

This recovers unused candidates immediately. Deployments that all have retained runs require the operator to use the existing run-family reclamation first. That existing operation deletes run/report history and ends regeneration; this proposal does not bypass it to make code collectible.

## Commands and operator behavior

```sh
effectory daemon stop
effectory revision reclaim plan --unreferenced
# or select one revision, with exactly the same protection rules:
effectory revision reclaim plan --revision REVISION_ID
effectory revision reclaim apply PLAN_ID
effectory revision reclaim inspect PLAN_ID
effectory daemon start
```

All commands accept existing `--repository` and `--json` options. They never start or stop a daemon themselves, import a bundle, acquire application/provider Layers, evaluate the current source, or invoke the workflow engine. Planning needs stopped repository ownership even though it performs no deletion.

- `plan` requires exactly one selector: `--unreferenced` or `--revision <64-character digest>`. There is no default deletion scope. It returns the selected candidates and all protected revisions, with counts, reasons and bounded examples. Selecting a protected revision returns a non-applicable preview explaining why; a never-retained revision returns NotFound. An empty unreferenced selection is also non-applicable, with no apply action.
- A preview states the retained slot count, candidate count, projected retained count, and logical file bytes selected. It never promises filesystem space freed: recovery copies or hard links may retain blocks elsewhere.
- There are at most 128 retained revisions, so a complete preview needs no public cursor. Candidates are ordered by revision ID, not filesystem timestamps. Every selected bundle and manifest is captured by exact digest and size.
- `apply` uses the plan ID as its idempotency key. Plans expire 15 minutes after planning completes. Before acceptance, changed dependencies or candidate bytes return Conflict without deleting anything. The complete selected set is checked again; apply never quietly skips a newly protected candidate and deletes the others.
- Acceptance records durable intent before moving or deleting any revision. An interrupted accepted operation resumes under the same plan ID and accepting host; expiry no longer applies. A completed retry returns the original receipt before current source/candidate checks. An accepted plan is not cancelled or automatically rolled back.
- `inspect` reads the saved preview, current phase, progress and completion receipt by plan ID. It can be used after an interrupted apply. An inspection command never resumes deletion. It takes offline ownership to avoid racing recovery and uses no application code.
- If all slots remain protected, the preview names the reasons and suggests the relevant existing maintenance operation. It does not suggest manually deleting revision directories. A revision pinned only by a completed family becomes eligible after that family is reclaimed, provided no other protection remains.
- Historical `task/workflow describe`, `--revision` submissions and vault-provider operations that explicitly name a deleted revision return RevisionUnavailable and point to the reclamation record. This applies even if the revision never ran. No retained run is deprived of these operations by this policy.
- A later ordinary preparation may recreate the same content-addressed revision. Its old reclamation receipt remains a record of the earlier deletion, not a permanent ban on that digest. Execution uses a currently retained, verified bundle before consulting deletion diagnostics.
- The current source is not compiled during planning. If it corresponds to an unreferenced candidate, startup can recreate that candidate. The active pointer is always protected, even when source files have since changed.

Use current exit conventions: InvalidInput is 2; Unavailable is 3; Conflict, NotFound, RevisionUnavailable and LimitExceeded are 5. Unknown/inconsistent dependency formats refuse with RevisionUnavailable. There is no new RPC, SDK service or automatic-retention setting.

## What keeps a revision

Protection is repository-wide. The offline owner must not delete another principal's code merely because the current CLI principal cannot list its runs. Counts are exact within the bounded scan; examples are at most 20 per revision and explicitly marked when truncated. Multiple reasons may protect the same revision.

| Reference | Policy and rationale |
| --- | --- |
| `.effectory/active.json` | Always protects its revision. There is no fallback to another active revision. |
| Every retained `host_runs` row | Protects its revision regardless of status, admission lane or origin. Completed source runs can still regenerate reports; report runs and pinned historical operations also remain usable. |
| Report groups, sources, generations and cancellation work | Validate ownership through their retained source/report runs; those runs supply the revision protection. Missing or inconsistent owners refuse planning rather than producing an apparently unused bundle. No separate expiry for settled reports. |
| Invocation, attempt, wait, recovery and undelivered outbox work | Validate retained run ownership and supported state. A work row whose required owner is missing refuses; it is not treated as evidence that code is unused. Delivered receipt/history metadata is not an execution dependency by itself. |
| Nonremoved schedules | Protect the stored revision, including paused schedules and those with no pending slot. Scheduler reconciliation, not retirement, moves a definition to a new revision. |
| Removed schedules | A pending slot conservatively protects the recorded revision. Any active run is protected through `host_runs`. Otherwise the definition/history is metadata and does not protect its old bundle. `schedule resume` only changes pause state; it does not restore a removed definition. Re-adding it uses the current application's definition and revision. |
| Scheduler's current revision | Protect the recorded scheduler revision until normal reconciliation advances it. A stale scheduler pointer is not rewritten by reclamation. |
| Queued/running extension operations | Protect `baseApplicationRevision`; a recorded activation intent also protects its candidate `applicationRevision`. Validate operation/intent correspondence and the active pointer. Never run extension recovery during a preview. |
| Completed/failed extension receipts | Keep their revision IDs as historical metadata, without independently protecting code. Receipt replay returns the original receipt; it does not rerun the operation. Their extension archives/locks/trust records are not deleted. |
| Compact `host_retired_runs` and target identities | Do not protect bundle files. Preserve every record and its revision string. Repeated submissions keep the existing Conflict response naming the retired run and its inspection command; they do not execute missing code. |
| Artifact records, retired schedule history, completed upgrade receipts and external recovery images | Metadata references do not independently keep code. Artifact content, signatures, tags, versions, pins and protections remain unchanged. Verified recovery images are never modified. |

Retirement must not use `inspectUpgradeWork` unchanged: that inventory intentionally ignores completed runs and schedules without pending slots. Its bounded scanning primitives can be reused, but its eligibility predicate cannot.

An accepted runtime upgrade, run-family deletion or another revision deletion blocks a new plan/apply. Complete that operation with its existing recovery path first. A pending extension activation is treated as a validated dependency, not silently completed. The apply lease prevents a daemon or cooperating offline writer from changing these facts while deletion is in progress.

## Proposed output shapes

These are the approved shapes for new CLI JSON output. The Effect schemas and CLI integration now exist; final recovery and executable transition verification remain in progress. String literals and canonical UTC timestamps use the existing Effect Schema primitives.

```ts
type RevisionProtection = {
  revision: string;
  reasons: readonly {
    kind:
      | "Active"
      | "Run"
      | "Schedule"
      | "Scheduler"
      | "ExtensionOperation"
      | "ExtensionActivation";
    count: number;
    examples: readonly string[]; // maximum 20 total per revision
  }[];
  examplesTruncated: boolean;
};

type RevisionReclaimPlan = {
  planId: string;
  repositoryId: string;
  hostBuild: string;
  createdAt: string;
  expiresAt: string;
  selector: { _tag: "Unreferenced" } | { _tag: "Revision"; revision: string };
  status: "Ready" | "NoCandidates";
  retainedCount: number;
  projectedRetainedCount: number;
  logicalBytes: number;
  candidates: readonly {
    revision: string;
    hostBuild: string;
    executionContract: string | null; // null for legacy manifest format
    bundleDigest: string;
    manifestDigest: string;
    bytes: number;
  }[];
  protected: readonly RevisionProtection[];
  scannedRows: number;
  scannedBytes: number;
};

type RevisionReclaimReceipt = {
  planId: string;
  startedAt: string;
  completedAt: string;
  revisions: readonly string[];
  removedFiles: number;
  logicalBytes: number;
};

type RevisionReclaimInspection = {
  plan: RevisionReclaimPlan;
  phase: "Planned" | "Applying" | "Complete";
  completedRevisions: number;
  receipt: RevisionReclaimReceipt | null;
};
```

A `NoCandidates` plan cannot be applied; apply returns Conflict. Unknown IDs are NotFound. Receipt fields describe actual removed bundle/manifest files and remain stable on retry. The journal retains enough per-file progress to count a removal once after a crash. The plan and receipt contain no application inputs, outputs, secret values or bundle source text.

## Storage and ownership implementation constraints

These are internal mechanics, not an additional authoring API:

1. Use the existing repository lease, Effect Scope and interruption-safe acquire/release pattern. No new daemon background service or scheduler. Inspection copies `state.sqlite` and required sidecars into private temporary storage using the established offline-copy reader; do not open or migrate the original SQLite database for planning. Plan/journal files are the only writes until acceptance. A fresh initialized store with no runs is supported; a catalog-only directory without runtime credentials/database first needs normal compatible initialization.
2. One shared scan budget covers every visited dependency header: at most one million rows and 256 MiB of projected header data, using bounded indexed keyset pages and yielding between complete synchronous pages. These are work limits, not latency guarantees or evidence of eligibility. Exhaustion refuses the entire preview without an applicable partial plan. Copying uses the existing 32 GiB database-plus-sidecars bound and may need comparable temporary space. Existing run-family reclamation can reduce large retained history before retrying.
3. Validate directory, manifest and bundle identities without importing modules. No symlinks, unknown files inside a candidate directory, path traversal or changed digests are accepted. At most 128 retained manifests; incomplete candidate directories remain the catalog's existing responsibility and are not a new deletion selection. Shared blocks/hard links outside a removed path do not change logical byte accounting.
4. Bind each preview to repository identity, owner build/platform/architecture, supported storage version, active pointer, captured dependency state and exact candidate bytes. Store the complete preview atomically. Interrupted planning leaves no applicable partial preview. Apply independently revalidates these facts before accepting; do not treat a caller-supplied Ready object as authority.
5. Persist and sync accepted intent before changing directory membership. Under the lease, move each verified candidate to a plan-owned quarantine directory on the same filesystem, using rename; then unlink its verified files. Sync directory/journal transitions. Recovery distinguishes a still-present candidate, a quarantined candidate, and files already removed using the accepted manifest. Never treat an unrelated/mutated path as completed deletion.
6. An accepted intent gates normal startup and ordinary writers before the catalog scans bundles. Startup must refuse with the exact resume command; it does not unexpectedly finish an operator's deletion. `revision reclaim apply PLAN_ID` is the recovery path. It finishes cleanup before marking Complete and releasing the gate. I/O failure leaves Applying, returns Unavailable, and requires the same retry; it never reports success with hidden pending cleanup.
7. A crash after acceptance may leave some unused bundles already deleted. The accepted operation is resumable, not transactional filesystem rollback. No running work exists under the maintenance lease. The operator can make an offline backup beforehand if preserving unused code matters; deletion does not mutate that backup or manufacture a new recovery copy. A full disk can prevent writing the intent; free external space first. No bundle is moved before durable acceptance.
8. Restore of a snapshot containing Applying must retain the gate and support the same resume path. Builtin backup remains non-mutating and must refuse a pending revision-deletion operation rather than copying a partially moved tree as an ordinary complete snapshot. Existing verified upgrade images from before acceptance are unaffected. Interactions with raw offline copies need crash/recovery proofs, not a claim that copying alone completes cleanup.
9. Completed receipts survive plan expiry and bundle recreation. Unaccepted previews are bounded to 32 live plans with expired/unaccepted preview cleanup; completed receipts are retained and have no automatic pruning in this slice. The record format is versioned. Unknown pending formats refuse safely before opening application code.
10. This source change changes the host build digest. Before shipping, retain the current `c26a3010…` executable and certify the actual new transition under the approved upgrade contract, including old offline writers. The current writer-owner guard makes a same-storage transition plausible, not proven. Do not advertise another compatible build until its real executable matrix passes. Storage numbers and compatibility labels alone grant no permission.

The explicit gate in point 6 favors predictable offline recovery over silent startup deletion. It must also be recognized by upgrade assessment, extension/bootstrap tools, vault tools, run reclamation, backup and restore. Reads that do not mutate data may inspect saved progress; they must not clear the gate.

## Required proof gates before shipping

1. Extend the real 128-revision reproduction: preview 127 unused candidates, apply, retain the active bundle, and start/run a newly edited application. Prove candidate enumeration is complete and no source import occurs during plan/apply.
2. Protect a revision for each retained terminal/nonterminal run, root and invocation reports (including all retry generations), paused/nonpaused schedules, scheduler pointer and pending extension base/activation intent. Exercise orphaned/malformed dependency rows and refuse without deletion.
3. Reclaim a completed run family through the real existing command; preserve its compact submission identity and existing Conflict response while allowing its now-unreferenced bundle to be removed. Repeat the original submission key after removal and prove no new handler runs.
4. Remove an otherwise unused removed-schedule revision; schedule history/pause/resume remain readable, no old occurrence executes, and re-add uses the current revision. A pending slot remains protected. Completed extension receipt replay remains identical without recreating its old application.
5. Change source dependencies, active pointer, candidate bytes or protected references between plan and apply; refuse the whole unaccepted plan. Completed/accepted retries follow receipt/resume rules rather than expiry. Reject forged previews, symlinks, unexpected files and foreign repository/build plans.
6. Real SIGKILL at acceptance, each rename/unlink/journal sync boundary, gate removal and final receipt. Retry exactly once, count actual files consistently, refuse startup while pending, and preserve every protected revision. Include I/O failure, insufficient space, duplicate applies and a restored interrupted copy.
7. Recreate the same content-addressed revision after completed removal; old apply still returns its original receipt and does not delete the recreated bundle. Normal historical lookup prioritizes the currently retained bundle.
8. Archived incompatible revisions can be inspected and reclaimed without importing their code, but retained runs still protect them. Unknown manifests/dependencies refuse. Prove source SQLite, WAL and SHM files are unchanged by successful/failed planning.
9. Scale scans, plan size, temporary-copy limits and interruption; release all cursors, descriptors and repository ownership. Verify complete counts despite truncated examples. No migration or Layer acquisition occurs under an inspection transaction.
10. Run actual old/new-host replay, writer refusal and verified rollback for the new build, then `bun run typecheck && bun run check && bun test` against frozen source. Existing status, finalization, vault, reader/report protection and agent setup gates remain required.

## Relation to Swamp and decision for the user

Vendored Swamp's [`run gc`](../vendor/swamp/design/surfaces/repo.md) couples collected runs to evaluated snapshots and also removes old orphan snapshots. Effectory uses retained executable bundles shared across runs, so the comparable lifecycle gap requires dependency inspection rather than copying Swamp's age cutoff. This proposal does not add Swamp's automatic run cleanup or claim full lifecycle parity.

Approve the offline `revision reclaim plan|apply|inspect` command family and these consequences together: only unreferenced bundles are selectable; all retained runs protect their revisions; compact retired identities and settled metadata do not keep code forever; interrupted accepted deletion requires an explicit resume; and later preparation may recreate the same revision. The user approved this command family and its consequences on 2026-11-08. Shipping remains gated on the required proofs above.
