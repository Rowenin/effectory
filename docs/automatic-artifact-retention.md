# Automatic artifact retention

Automatic retention runs existing artifact policies in the daemon. It is **off by default**, including after an upgrade. Enable it explicitly for a repository:

```sh
# Optional preview of current policy eligibility.
effectory lake reclaim plan --policy

effectory lake reclaim automatic enable
effectory lake reclaim automatic status
effectory lake reclaim automatic disable
```

These commands require the owner-authenticated daemon. Add `--json` for compact output. An older daemon must be restarted on the new build before it supports the commands; the CLI checks `lake.retention.automatic.v1` before sending them.

## What enabling authorizes

Enabling authorizes background collection of existing and future versions that qualify under their stored retention policies. It does not wait for a first sweep and does not prompt for individual batches. The setting survives restart, deployment, backup and restore. **An enabled restored copy starts collecting when its compatible daemon starts.**

An artifact's latest publication captures its policy. For example:

```ts
const Report = Artifact.make({
  id: "report",
  version: 1,
  schema: ReportSchema,
  retention: { maxVersions: 10, maxAge: "30 days" },
});
```

This is a fragment using your existing `ReportSchema` and the SDK's `Artifact` import. The authoring API is unchanged. A definition edit takes effect on an identity's next new publication, not just when the revision loads. A later publication from an older pinned revision can restore its older policy.

Older kept versions qualify when they exceed the age limit **or** fall outside the count limit. The newest kept version always survives policy collection. Versions from unfinished producers, versions pinned by unfinished consumers, and source publications held by pending reports remain protected. These rules cover JSON and binary content.

A daily publication key creates a separate identity. If each daily identity has only one version, automatic policy collection keeps all of them. Use an explicit selection such as `lake reclaim plan --schema report --older-than "90 days"` followed by apply when you intend to remove final versions. No policy means indefinite policy retention.

## Timing and disabling

An enabled daemon begins or resumes a sweep after storage recovery. It traverses bounded batches with durable checkpoints, then waits about a minute before the next sweep. Large backlogs, storage contention, protected content and continuous writes can delay collection. This is eventual maintenance, not an exact deletion deadline. Nothing runs while the daemon is stopped.

Once disable returns, no new automatic tombstone can commit until someone enables the setting again. Already-committed blob cleanup can still finish, including while disabled. Disabling does not restore content. Repeated enable/disable is safe; concurrent settings use the last committed value. After an uncertain command response, inspect status or repeat the desired setting.

## Understanding status

Status returns:

- `enabled` and `changedAt`: the persisted setting and when it last changed.
- `lastSweepStartedAt` and `lastSweepCompletedAt`: scan history. Completion means the sweep's identity horizon was inspected, not that every version could be deleted.
- `lastBatch`: the latest nonempty automatic batch, with its current reclamation receipt. It is not a total across all history. A scan that deletes nothing creates no receipt.
- `lastError`: the most recent unresolved maintenance problem, with a plan ID when cleanup can be retried directly. It remains visible through unrelated successful work.

The receipt's `deletedVersions` counts logical deletions. `reclaimedBytes` counts completed blob unlink work; `pendingBytes` counts committed cleanup that remains. Shared content is retained until its final kept reference disappears. A POSIX reader with an already-open file can finish after unlink, so physical disk space may remain occupied until that reader closes.

New receipts identify `origin: "Automatic"` or `"Manual"`; an older receipt without origin is manual. Inspect a version with `lake versions <artifact-id> --include-reclaimed` to find its `reclamationPlanId`. Retrying `lake reclaim apply <plan-id>` returns the existing receipt and resumes cleanup; it does not select more versions, and works after automation has been disabled.

Failures appear in status and as a `doctor` warning. They do not change a task's outcome. The daemon retries cleanup in bounded batches. If SQLite cannot persist its own error because storage is full or busy, the current host keeps that diagnostic in memory until the implicated operation succeeds; that fallback cannot survive a process loss. A completely full disk may require freeing unrelated space before reclamation can write its transaction.

## Reading and pagination

Protection begins at a successful exact `ArtifactReader` access. Query results, unaccessed input references, and references embedded in old task results are not automatically pinned. Call `metadata` before waiting when a consumer needs to retain a reference. See [artifact reads](artifact-reads.md).

Automatic deletion can expire an in-progress lake query/version cursor with `CursorExpired`. Restart that listing. The collector does not silently weaken the existing pagination consistency check.

Automatic retention does not prune run history, native execution results, report results, application revisions, tombstones, receipts or arbitrary orphan blobs. It does not bound total repository size or guarantee that a repository fits the builtin backup limit. See [the approved contract](automatic-artifact-retention-api-draft.md) and [implementation evidence](automatic-artifact-retention-implementation.md).
