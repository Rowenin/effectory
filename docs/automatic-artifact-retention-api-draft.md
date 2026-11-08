# Automatic artifact retention — proposed contract

Status: **user-approved, implemented and verified**, 2026-11-06. This is the next Swamp parity slice after the verified workflow-invocation reports. Research and labelled design probes are in [the evidence note](automatic-artifact-retention-research.md). No independent reviewer approval is claimed. See [operator usage](automatic-artifact-retention.md) and [implementation evidence](automatic-artifact-retention-implementation.md).

## Purpose and operator API

Effectory already captures artifact retention policies and supports manual preview/apply. This proposal adds an explicitly enabled daemon collector that applies those same policies without an operator approving every batch. Existing installations stay manual until enabled. No new authoring service, Layer requirement, task context field, workflow schedule, or artifact option is needed.

```sh
# Optional preview of what current policies allow. This does not enable anything.
effectory lake reclaim plan --policy

# Enable policy-based collection for this repository, including existing versions.
effectory lake reclaim automatic enable
effectory lake reclaim automatic status

# Stop new automatic deletion decisions.
effectory lake reclaim automatic disable
```

The three commands use the existing owner-authenticated daemon connection. They print the status object using the CLI's normal pretty/compact JSON convention. They do not prompt. The enable command's help and successful human-mode stderr note say that existing and future policy-eligible content may be deleted without individual previews. There is no automatic Selection or Version mode, and no force bypass for protected content.

The repository setting is stored in SQLite, defaults to false when absent, survives daemon restart and application deployment, and is included in backup/restore. An enabled restored repository starts collecting when its compatible daemon starts. This is repository operational state, not a setting in a pinned application revision. It covers the authenticated owner's artifacts in this single-owner daemon; it is not authority for future cross-owner collection.

Enable returns after persisting the setting, not after collection. Repeated enable/disable has no cumulative effect. Concurrent commands use last-committed-setting semantics. No request-key receipt is added for setting a boolean: after uncertain delivery, inspect status or repeat the desired setting. A repeated identical setting leaves `changedAt` unchanged. Commands require the new `lake.retention.automatic.v1` capability before sending a new RPC; an old daemon causes exit 3 with restart guidance, not a silently ignored request. Existing reclamation commands keep their current capability and behavior.

## What can be collected

The [approved retention contract](artifact-retention-api-draft.md) remains authoritative:

- The effective policy is captured on the highest-version publication for an identity, including tombstones. It is not read from the currently loaded definition. Editing a policy only takes effect at the next new publication for that identity; an older pinned run can later publish an older policy.
- No policy means indefinite policy retention. The newest kept version is always protected. An older version is eligible when it exceeds `maxAge` **or** falls outside `maxVersions`. Count kept versions across the whole identity, including protected versions and other schema versions.
- Unfinished producers, unfinished consumers' first-access pins, and unsettled report obligations all protect content. Missing producer/consumer state remains conservatively protected. The collector cannot clear pins or cancel runs/reports.
- A first-access pin protects from successful access onward. References merely held in inputs, query pages, prior results, or external systems do not gain protection. Automation makes this existing window operationally relevant: acquire with `ArtifactReader.metadata` before waiting when content must survive the wait.
- A single-version daily/publication-key identity never becomes eligible under author policies. Explicit operator Selection remains necessary to remove its final version. This feature does not add Swamp's whole-entry lifetime or repository-wide maximum-age deletion.

For example, an identity with ten old versions and `maxVersions: 3` may lose its seven oldest unprotected versions. An identity with one version and `maxAge: "30 days"` keeps that version even a year later. Enabling does not invent a default policy for either case.

An automatic deletion has the same effects as manual deletion: an immutable tombstone and receipt remain, version numbers are never reused, content reads fail as reclaimed, and a changed reclamation epoch expires affected query/version cursors. Automatic collection can therefore make a paged lake query fail with `CursorExpired` between pages. That is an explicit consequence of enabling it, not a new query consistency promise.

## Timing, disabling, and failures

An enabled daemon begins or resumes a sweep after existing storage recovery and starts a new sweep about once a minute after completing the previous sweep. There is at most one collector fiber. This is an eventual maintenance cadence, not a deletion deadline: backlog, busy storage, protection, continuous writes to an identity, and daemon downtime can delay deletion. A daemon that is stopped does not collect. Age is evaluated against a fixed sweep cutoff from Effect Clock; negative ages are treated as zero.

A sweep has a finite identity horizon and durable progress. New identities and versions newly eligible after the cutoff are revisited by later sweeps. Protected rows skipped in one sweep are reconsidered in later sweeps. Restart resumes progress instead of starting at the oldest protected prefix every time. Disable discards the current scan checkpoint; the next enable starts a fresh sweep and cutoff.

Every automatic metadata transaction rechecks enabled state and its setting generation. Once disable returns, no later transaction can make a new automatic tombstone until another enable commits. It does **not** undo a transaction that committed before disable, restore content, or cancel durable unlink work from that transaction. Already-committed cleanup, including manual cleanup, may finish while automation is disabled. The disable acknowledgement makes this distinction explicit.

Collection is independent of task outcomes and foreground CLI observation. A failed collection batch does not fail a run, reject an otherwise valid publication, or become a report task. It records a bounded diagnostic and retries with delay. Disk pressure can independently cause publication or SQLite writes to fail, as today. If the disk is completely full, even reclamation's metadata write may fail; operators may need to free unrelated space first.

Expected SQLite contention is retried outside transactions with a bounded delay, then reported without advancing past an uncommitted batch. Other cleanup errors remain durable and visible. One failing blob must not prevent later identities from being inspected. Pending unlink jobs are retried in bounded batches, including when automation is disabled, because their deletion was already committed. Current startup also attempts reclamation recovery and logs a warning on failure; it does not guarantee all reclamation I/O succeeded before readiness. Binary-install recovery retains its separate contract.

## Status and RPC shapes

Add two control-plane RPCs, reusing `OperationError` and the existing strict Schema conventions:

```ts
LakeReclamationAutomaticGet({}): AutomaticReclamationStatus
LakeReclamationAutomaticSet({ enabled: boolean }): AutomaticReclamationStatus

type AutomaticReclamationStatus = {
  readonly enabled: boolean
  readonly changedAt: string | null
  readonly lastSweepStartedAt: string | null
  readonly lastSweepCompletedAt: string | null
  readonly lastBatch: null | {
    readonly committedAt: string
    readonly receipt: ReclamationReceipt
  }
  readonly lastError: null | {
    readonly at: string
    readonly code: OperationError["code"]
    readonly message: string
    readonly planId?: string
  }
}
```

These are contract sketches, not existing TypeScript exports. Timestamp strings use the existing canonical ISO format. Nullable fields are present as null before an event exists; `planId` is omitted when an error is not associated with committed cleanup. The last batch is the latest **nonempty automatic deletion batch**, with its receipt read at status time so pending/reclaimed bytes reflect cleanup progress. It is not a total across all history. No batch/plan/receipt is created for a scan that deletes nothing. Sweep completion means its horizon was inspected, not that every eligible version was deletable or every unlink succeeded.

Status is read-only and does not itself trigger a sweep. `lastError` identifies the most recent unresolved collector/cleanup problem, with bounded host-generated text and no artifact values. A successful unrelated batch must not clear it; resolve the implicated operation first. Multiple pending errors are summarized by one representative and the message says when additional failures exist. The existing `doctor` output gains a Warning when this maintenance has unresolved failures, pointing to status and, when available, `lake reclaim apply <planId>`. Empty or fully protected sweeps are not errors.

Each nonempty automatic batch uses the existing plan ID, tombstone, receipt and unlink mechanism. `lake versions --include-reclaimed` identifies its `reclamationPlanId`. Add optional `origin: "Manual" | "Automatic"` to reclamation receipts, with omission in old receipts understood as Manual; new manual receipts say Manual. An automatic batch's receipt says Automatic. Re-running `lake reclaim apply <planId>` looks up its existing receipt first and only resumes cleanup, even after disable. It cannot select additional versions. Existing manual receipt-replay behavior and byte definitions are unchanged. Older clients can drop the additive field.

Read/mutation authentication and errors follow existing reclamation: invalid request is InvalidInput (exit 2), unavailable storage is Unavailable (exit 3), and other operation codes keep their existing mappings. Failed setting writes never falsely acknowledge a new value. There is no new retention error family exposed to task handlers.

## Internal ownership and bounded work

Use ordinary Effect primitives. A host-owned `Layer.effectDiscard` starts one `Effect.forkScoped` maintenance loop using `Clock`, interruptible sleep/yield, and existing Lake/lease services. The Layer depends on the shared lake instance, so its fiber and cleanup finish before SQLite closes. No JavaScript interval, detached fiber, author-provided collector, or durable workflow engine execution is needed. A durable scan checkpoint is data; it is not a long-lived run Scope. The existing host lease fences all writes.

Do not repeatedly call the current full `planReclamation({ _tag: "Policy" })`: its 1,000-candidate limit does not bound the rows scanned or the rank lookup. Reuse its policy and protection rules and durable mutation machinery, with a private incremental traversal:

1. Maintain an indexed identity projection with stable enumeration sequence and a mutation epoch. Publication and reclamation update the epoch transactionally. Initialization/backfill must complete before enabling collection over that projection. Migration can add startup work; no author code is executed.
2. Walk a fixed identity horizon, then retained versions newest-first using `(artifactId, version)` keyset seeks. Save position, kept rank, effective policy identity, mutation epoch and cutoff. At most 128 versions are evaluated per synchronous transaction, and the collector yields between batches. Avoid OFFSET proportional to `maxVersions`, whole-history window sorts, or an unbounded count in a candidate check.
3. If an identity changed between batches, invalidate its saved rank and restart it conservatively. Cap restarts per sweep and defer a continuously changing identity to the next sweep, so it cannot starve other identities. Automatic deletions advance the saved epoch and subtract removed rows from the rank carried to the next batch.
4. Evaluate a batch's candidate ranks together before mutating. In the same immediate transaction, check current policy, newest-version rule, protections, setting generation and repository lease; tombstone only approved rows and persist the continuation and cleanup intents. A stale checkpoint never grants deletion authority.
5. Use existence checks for protection in this worker rather than enumerating/counting every consumer. Do not retain a SQLite iterator, transaction or snapshot across an Effect yield, retry, sleep or filesystem operation. No author codec is called.
6. Recover committed unlink work through the existing shared-content check. Metadata changes, concurrent manual apply, new binary installation and open POSIX readers retain their current serialization rules. A shared blob stays while any kept record references it; an already-open binary reader may delay actual disk-space recovery after unlink.

The batch size limits application-level work; it is not a hard wall-clock bound on synchronous SQLite or filesystem calls. Add short pauses between slices and keep cleanup batches bounded so an idle large backlog does not monopolize the daemon. Exact private pause/budget constants may be tuned by implementation evidence without changing the public API or promising real-time latency.

## Compatibility, retained limits, and proof gates

Existing applications need no code change. Existing policies remain manual until enabled. Automatic policy collection does not prune run histories, native execution results, report results, retained revisions, tombstones or receipts. Metadata can still grow without bound. Nonempty automatic receipts grow with actual deleted content, not with idle timer ticks. No backup-size guarantee follows from this feature, and backup stays non-mutating. Exported copies preserve the enabled setting; operator documentation must call that out.

Before shipping, verify with the real implementation:

- Defaults and persistence: upgrade remains disabled, capability refusal sends no mutation, repeated settings, restart/backup/restore, and no per-tick plan growth on an empty or protected store.
- Eligibility: count, age, OR semantics, nonmonotonic timestamps, cross-schema identities, aliases, no policy, captured policy changes, tombstoned latest policy, daily keys, and backwards clock movement. Compare automatic and manual eligibility at equivalent observation points.
- Protections and races: unfinished/NeedsAttention producers, 1,024 consumer pins, missing consumer state, queued/running/NeedsAttention reports including workflow-invocation reporters, and release followed by a later sweep. Recheck pin versus tombstone under actual engine-connection SQLite contention.
- Progress: at least 200,000 versions with a large protected prefix, a single very deep identity, huge maxVersions, continuous publications, and manual deletes between slices. Prove bounded indexed batches, no leaked snapshot, progress across restarts, and no hot-identity starvation of others. Measure foreground latency; do not infer it from LIMIT alone.
- Durability: kill before/after metadata commit, checkpoint persistence, unlink and receipt updates; retry yields the same deletion record. Shared blobs, binary relink, open reader/download, I/O error and disk-full cases preserve existing semantics.
- Disable and ownership: race disable with scanning, commit and cleanup; after acknowledgement no new tombstone; old cleanup continues. Disable followed immediately by enable invalidates the old batch through the setting generation, even though the boolean is true again. Shutdown interrupts work and awaits cleanup before closing Lake, with no detached worker or duplicate collector.
- Operator truth: automatic origin, lastBatch byte updates, unresolved errors not hidden by unrelated success, doctor warning, CursorExpired during a paged query, and existing manual plans/apply receipts still work.
- Run repository typecheck, formatting/lint and the complete test suite after implementation. The research probes below are not substitutes.

## Approval package

Approve the repository-wide, default-off automatic mode and its three commands; coverage of existing and future captured policies; existing newest-version and reader/report protections; eventual background cadence; disable fencing with completion of committed cleanup; additive status RPCs/receipt origin/doctor warning; and persistence across restore. No authoring API changes or automatic whole-entry deletion are proposed.
