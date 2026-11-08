# Completed run-history reclamation — proposal

Status: **user-approved, implemented and verified**, 2026-11-06. See [usage](run-history-retention.md) and [implementation evidence](run-history-retention-implementation.md). The preceding approved Checks/JUnit slice is complete. This draft follows [retention research](run-history-retention-research.md). No independent review is claimed.

## Purpose and recommendation

Reclaim the large host and native workflow histories of completed runs while retaining permanent compact submission records that prevent accidental re-execution. Artifact bytes and metadata continue to follow the separately approved lake retention policies.

Recommend an **offline, preview/apply first slice**. Every command below takes exclusive repository ownership and refuses while the daemon owns the repository. It does not stop the daemon automatically or build application Layers. This deliberately requires an operational pause. Automatic online run retention and revision pruning remain parity gaps; the existing automatic artifact collector stays independent.

Swamp distinguishes workflow-run retention from artifact/output retention and protects unfinished related runs. Effectory's linked children share a host run; its separate reporter runs create the relevant cross-run dependency instead. See the cited source locations in the research note. This proposal is not full Swamp retention parity.

## Operator API

Approved commands:

```sh
effectory daemon stop
effectory run reclaim plan --completed-before 2026-10-01T00:00:00.000Z
effectory run reclaim apply PLAN_ID
effectory run reclaim inspect RUN_ID
effectory run reclaim compact
effectory daemon start
```

- `plan` requires exactly one selector: `--completed-before <ISO instant>` or `--run <source-run-id>`. Optional `--target <root-target-id>` applies to the date selector. No default cutoff and no implicit deletion.
- Date selection uses the family's **latest terminal completion time**, not submission time. A long-running or recently retried family is therefore not selected just because its root was admitted long ago. New terminal writes capture completion time; migration derives it from an unambiguous retained terminal event. Missing or inconsistent historical evidence protects the family as `UnknownCompletion`.
- A report-run id supplied to `--run` is refused with `InvalidInput` and its source-run id. An explicit root still must satisfy the safety rules below; it bypasses age only.
- Plans select at most 100 eligible source families, oldest completion first, then source-run id. `hasMore` means another plan may find further eligible families. They store an exact manifest, not a selector that is re-run at apply. Human output names included roots, report counts, removed data categories, protected-family counts and the regeneration consequence. JSON output contains the same facts.
- The command processes indexed batches and yields between them. Work is proportional to the inspected history; 100 families is an output limit, not a latency guarantee. Large report families can take time. It must not buffer all report runs, events or native messages in memory.
- Plans expire 15 minutes after completion. Their manifest is bound to repository identity, storage format, principal and family membership/completion facts. Applying an expired or changed plan returns `Conflict`, with no new deletions. Interrupted planning leaves no applicable partial plan.
- `apply` takes a plan id as its idempotency key. A completed receipt is returned before expiry or current-state checks. A retry of interrupted application resumes its durable intent. No extra request key or force flag.
- `inspect` reads the permanent compact retirement record for a run. It also works after native cleanup completes. A run never retired returns `NotFound`; this command is not another general run-status command.
- `compact` performs a checkpoint and SQLite compaction under exclusive ownership after retirement recovery finishes. It reports actual file sizes before/after. Logical deletion alone makes pages reusable and does not promise a smaller file. Compaction can require substantial free disk and can fail independently of successful reclamation; it is safe to retry. It does not compact vault storage or delete revisions, artifacts or backups.
- Commands accept existing global repository/JSON options. They do not auto-start a daemon. Existing error conventions remain: `InvalidInput` exits 2, `Unavailable` exits 3, `Conflict`/`NotFound`/`LimitExceeded` exit 5. No new RPC or SDK service is proposed for these offline operations.

## Family eligibility and report consequence

A family is a submitted root task/workflow run plus **every generation of every report run and report record sourced from it**, including invocation reports and records that never became runs. A source is never retired while leaving a reporter that can still read or regenerate from it.

All family members must be terminal. All report obligations must be settled. `WaitingSource`, `Queued`, `Running` and `NeedsAttention` protect the family, including an operator-held manual report. Unfinished host runs, unresolved recovery continuations and undelivered host outbox work also protect it. Offline maintenance does not fabricate terminal outcomes, cancel runs or execute user code to make a family eligible.

**Applying a plan permanently ends report regeneration for its families in that store history.** Report Markdown/data, report generations/search rows, source inputs/results, task outputs, checks/JUnit data, events, logs, waits and recovery diagnostics are removed. A report that an operator wants to keep must be exported before applying. Report retries against a retired family return `Conflict` and name the source's retirement record.

This amends the current report invariant that native outcomes remain available while regeneration is possible. It does not silently weaken that invariant for retained families.

Linked workflow boundaries and fan-out share the root family. A family's settled reports can be much newer than the source; the date selector waits for the latest of their completion times. NotApplicable records with no run are included in retirement once their source is settled.

## Permanent records and idempotency

Retain a compact record per retired run containing:

```ts
type RetiredRun = {
  runId: string;
  sourceRunId: string; // root itself for a submitted run
  kind: "task" | "workflow";
  targetId: string;
  revision: string;
  status: TerminalRunStatus;
  acceptedAt: string;
  completedAt: string;
  retiredAt: string;
  planId: string;
};
```

Private storage additionally retains principal, admission namespace, original request key and submission fingerprint. The compact record never expires automatically. It holds no input, result, error payload, tags, invocation paths or check messages. Consequently this feature substantially reduces history payloads but does **not** bound the number of permanent receipt rows. Restoring an older backup restores its older history and idempotency state, just as today.

Manual submission checks both live runs and retirement records **before loading a revision** and again in the admission transaction. A key matching retired history never creates another run:

- identical submission: `Conflict`, message `Run <id> was retired; inspect with run reclaim inspect <id>. Use a new request key only to intentionally start another run.`;
- different submission under that key: existing request-key `Conflict`;
- keys remain scoped by principal and admission namespace, including scheduled admissions.

Returning Conflict for an identical retired submission is a deliberate compatibility change: the original full Run response no longer exists. It preserves the stronger guarantee that a retry cannot repeat an external action. It requires user approval with this proposal.

Historical wait/cancel/recovery/report mutation receipts are retired with their family. Those operations against retired targets return Conflict rather than replaying old receipt bodies. Never-found targets remain NotFound. Minimal target-to-retired-root mappings are retained where needed to make that distinction without retaining prompts, payloads or invocation paths. Submission deduplication is permanent; replay of the other historical receipt bodies ends at explicit retirement.

## Existing read APIs and artifact protection

- Ordinary `run get`, events, outputs, checks, JUnit, watch, report reads and summaries refuse retired history with `NotFound` and a retirement/inspect hint. They never return a successful empty history or substitute null for an original input/result.
- `run list` and report search omit retired families. A retirement epoch invalidates previously issued history cursors with `CursorExpired`; they cannot silently skip deleted rows. There are no live daemon observers during offline apply. An export spanning a stop/start or carrying an old cursor must fail rather than complete a partial document.
- Schedule last-run summaries and history use retained terminal facts when their referenced run is retired. Links can still identify the old run; detailed inspection gives the explicit retired-history response. Retirement cannot make schedule get fail or reactivate overlap blocking.
- Lake records, version identities, digests, publication keys, tags and file contents are unchanged. Existing artifact references remain readable and normal artifact retention stays authoritative. An artifact's producer id may refer to a retired run; the compact terminal record proves that producer is finished.
- Before removing a consumer run, remove its terminal consumer pins and pending pin-cleanup rows transactionally. Unknown/missing runs without a valid retirement record remain conservatively protected. A retained unfinished consumer's pins are untouched even if the producer family is retired. The explanatory protection lookup, worker boolean lookup and reclamation candidate SQL must all consult the same compact terminal facts; updating only one is insufficient. The retirement record must not accidentally convert a genuinely missing producer into an unprotected one.
- Settled report holds are removed with their records; unfinished report holds make the family ineligible. No reader/report protection is waived to reclaim history.
- Revision bundles, extension archives/trust and credentials are retained. Offline maintenance never builds or closes author Layers. Daemon restart rebuilds the remaining catalog normally; this slice does not solve retained-revision ABI migration.

## Receipts, progress and physical space

A plan contains metadata counts by category and an estimated logical payload total, explicitly **not physical bytes recoverable**. Exact native-table/file shrinkage is reported only by measurements after cleanup/compaction. Shared SQLite pages, indexes, WAL and retained compact rows prevent a reliable per-family disk estimate.

The apply receipt has `planId`, `startedAt`, `completedAt`, `retiredFamilies`, `retiredRuns` and deleted-row counts by category. Success means all selected families are retired and their native cleanup completed. An interruption or I/O failure can leave a committed retirement intent; the error prints the plan id and repeat-apply instruction. It must not claim rollback after a durable intent. Recovery never widens the original manifest.

Space is still needed for SQLite's journal and retirement intent. On a completely full disk, operators may need to free space outside Effectory first. Neither deletion nor compaction promises to succeed with zero writable capacity.

## Effect ownership and durable ordering

Use the existing repository ownership Layer and scoped SQL resources. No scheduler, application build or WorkflowEngine is started by maintenance. Use pinned Effect `SqlMessageStorage`/`MessageStorage.clearAddress` for native message/reply cleanup, not hand-written deletion of native tables.

1. Under exclusive ownership, finish earlier retirement intents, validate the plan, and recheck every family's terminal/report/outbox/recovery eligibility. Persist the frozen retirement intent and all compact records before deleting any execution deduplication.
2. The same host transaction records the retirement epoch and makes the selected families inaccessible to normal admission/inspection. It materializes exact cleanup identities in bounded manifest rows. No author code or native cleanup runs inside that transaction.
3. Delete host payload/detail rows in dependency order, preserving compact submission and target mappings. Repeatable batches persist progress. The deletion inventory includes task/workflow invocations, events, checks/budgets, telemetry, waits/receipts, fences/outbox, attempt/windows/holds/gates/generations, report sources/plans/groups/generations/search/tags/cancellation/receipts, `host_report_paths` projections and terminal pin bookkeeping. Report search/tag rows precede report generations because their foreign keys do not cascade. Shared counters, scan positions, pagination secrets and SQLite sequence state are preserved.
4. For every native root and task execution identity in the manifest, clear its `Workflow/<name>` address and its `Workflow/-/DurableClock` address. These calls are repeatable; progress follows successful calls. Workflow invocation controllers in today's host are not a third native Workflow type. Explicitly verify the inventory before shipping.
5. Persist the completed receipt only after every stage succeeds. Temporary plan data may be reclaimed later, but compact deduplication records and receipts needed to resume an accepted apply are retained.
6. Daemon startup and other host constructors complete unfinished retirement intents through storage-only Layers under exclusive ownership **before building the entire owned host Layer**. Recovery cannot be a sibling Layer racing catalog, engine, scheduler or automatic artifact collection acquisition. Recovery failure prevents readiness and reports the plan id. Offline backup refuses unfinished retirement work without mutating the repository, following the existing non-mutating backup rule. A clean completed backup includes compact records. Restore/start must not resurrect retired work. A private pending marker is fsynced before the intent transaction and removed/fsynced only after durable completion; backup refuses by inspecting that marker without opening SQLite. Startup safely resolves a marker left before intent commit. See the [storage audit](run-history-retention-storage-audit.md) for the exact ordering and dependency inventory.

Offline ownership eliminates live entity caches and live readers during cleanup; it does not replace durable crash recovery. Implementation must prove that the retained compact record blocks both manual and internal admission paths after native results have gone.

## Evidence so far and implementation gates

The following are pre-implementation scratch probes. Actual implementation evidence is recorded separately in [verification](run-history-retention-implementation.md).

- Clearing a completed address removed its native deduplication; executing the same identity after rebuilding the engine executed the body again. This establishes the need for the host's permanent compact record.
- A second probe completed a parent/child with durable clock work and left an unrelated parent suspended on a timer. After closing the engine, a storage-only Layer cleared four exact addresses (parent, child and their clock addresses). All four had zero remaining messages. A fresh engine returned None for the removed parent, resumed the unrelated parent, and executed only that parent's child. Script/log: `/tmp/effectory-checks-research/retirement-probe/offline.ts` and `offline.log`.
- These are same-process scoped-engine restarts, not OS kill tests or proof of all Effectory dependency paths.

Required implementation gates:

1. Real daemon/CLI history with linked children, retries, timers, manual recovery, checks, binary/JSON artifacts and every report scope. Retire one eligible family; unrelated waiting work resumes correctly after restart.
2. SIGKILL before/after each durable stage and native clear, plus repeat apply before/after expiry. Receipt lookup precedes expiry; no user handler reruns without a deliberately new submission key.
3. Original request retries, changed-input retries, scheduled admissions, concurrent ownership refusal and foreign-principal lookups. Unknown and retired identities remain distinguishable only to their owner.
4. Unfinished source/report/recovery/outbox protection; a new report generation after planning invalidates apply. Very large families are processed in bounded memory/batches. Settled generations are removed together.
5. Artifact reads and reclamation before/after producer retirement, unrelated consumer pins, missing-run protection, report holds and schedule summaries/history.
6. Cursor invalidation and JUnit/export refusal across maintenance. Report regeneration and old mutation receipts give the documented retired response.
7. Native address inventory and leftover messages/replies/clocks; no native-table schema duplication. No application/provider Layer acquisition during maintenance/recovery.
8. Logical deletion, actual compaction, low-disk failure and interrupted compaction. Backup refusal must not create/change source WAL/SHM files; clean backup/restore preserves retirement and admission safety.
9. Migration of completion times, strict malformed-store handling, plan identity binding, old-host ABI refusal, typecheck, formatting/lint and full repository tests.

## Approval package

Approve offline plan/apply/inspect/compact, entire completed report families, permanent submission deduplication records, Conflict on replay of retired submissions/mutations, ending report regeneration, unchanged artifact content and protection, explicit cursor expiry, and startup recovery before runner activation. The user approved this package for implementation. That approval does not direct reclamation of existing user history or enable an automatic policy.
