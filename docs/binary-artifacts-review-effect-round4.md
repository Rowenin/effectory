# Binary artifacts — Claude Effect review, round 4 (narrow re-check of draft revision 7)

Reviewer: Claude (Effect/Scope/Layer and durability). Date: 2026-11-05. Subject: `docs/binary-artifacts-api-draft.md` revision 7, which was frozen during this review.

Scope: this check covers only the following parts of the draft:

- "Reclamation and live operations — revised recommendation"
- "Binary installation recovery — revised recommendation", including its backup paragraph
- The adjacent transport, admission and receipt bullets: the four-download permit, the fifth-request refusal, the Metadata/Bytes frames, the operator note, and the reclamation/backup lines in "Required proofs" and "Decisions to present"

All authoring and DI decisions were settled in rounds 1–3. I did not reopen them.

I also read:

- `docs/binary-artifacts-review-effect-round3.md`
- `docs/artifact-retention-api-draft.md:74-78`
- `packages/platform-bun/src/lake.ts` (`atomicBlob`, `PRAGMA synchronous = FULL`)
- `packages/platform-bun/src/lake-reclamation.ts` (`unlinkJob`)
- `packages/platform-bun/src/backup.ts` (`repositorySnapshot`, the exclusion list)

**This is reviewer approval for presentation only. It is not user approval, and it does not authorize any binary implementation.**

## Verdict: CONDITIONAL APPROVAL for presentation, after three text corrections (R1–R3)

Revision 7 adopts round 3's C2 option B faithfully:

- The download checks metadata and opens its descriptor inside the same non-yielding section as `unlinkJob`.
- `acquireRelease` owns the descriptor in the handler stream Scope.
- Reclamation never waits. `pendingBytes` and `reclaimedBytes` keep their approved meanings, and the draft states honestly that disk blocks are freed only on the final close.
- Writers keep their staging file and re-link it if the blob is missing.
- A changed inode is re-verified outside the transaction.
- Backup refuses unfinished binary installation work with Conflict and does not mutate the repository.

The text is also consistent with the approved retention contract. That contract already says "do not claim that a successful metadata transaction necessarily freed disk space" (`artifact-retention-api-draft.md:78`).

The adjacent transport bullets are consistent with the revised sections:

- The permit lives in the request Scope and the descriptor lives in the handler stream Scope.
- A fifth request fails fast with LimitExceeded before any file is opened.
- The response is one Metadata frame followed by Bytes frames, and the method accepts bytes artifacts only.
- The text promises only producer-side bounds, not client consumption.
- `LimitExceeded` already exists as an `OperationError` code.

Three gaps remain. Each needs one or two sentences, none changes a public API, and none changes what is presented to the user. **If R1–R3 are applied as written below, no further Effect round is needed.** S1–S4 can be applied now or left as implementation notes.

## Required text corrections

### R1. Keep the writer's verification descriptor open until the commit check finishes

The commit step says: "If it still identifies the previously verified file, use it." The only identity test available on a pathname is `(dev, ino)`. That test is sound only while the writer still holds the verified file open, because an open descriptor keeps its inode allocated.

If the writer closed the descriptor after verifying, the following sequence breaks the test:

1. Reclamation unlinks the blob.
2. The inode is freed.
3. A different file is later installed at the digest path and receives the same inode number.

ext4 reuses freed inode numbers readily. On APFS my probe saw no reuse, either while the descriptor was open or after it closed (2,000 creates each). So the hazard is platform-dependent, and a macOS-only proof would miss it.

**Add:** "The writer keeps the verification descriptor open until the final commit section completes, and compares the pathname's `lstat` (dev, ino, regular file) with that descriptor's `fstat`. A mismatch or a missing path takes the re-link or re-verify branches."

Also bound the re-verify loop: "Re-verification is retried a bounded number of times; after that the commit fails `Unavailable`." Without a bound, repeated reclaim and republish of the same digest can make a writer loop.

### R2. State the intent and staging ordering that makes recovery sound

The draft persists an intent and later recovers it, but it never says when the intent becomes durable relative to `link()`, or how staging deletion is ordered relative to intent resolution. Both orders decide whether recovery is correct. **Add:**

- **Intent before link.** The intent row is committed (`synchronous = FULL`) after the staging file is written and fsynced and before any `link(staging, blob)`. A staging file with no intent is handled by the existing naming-rule cleanup. A linked blob with no intent must never exist.
- **Proof of ownership.** Inside the non-yielding section, recovery proves that a blob came from a staging file by checking that the two pathnames are _currently_ the same file: equal `dev` and `ino` from `lstat`, both regular files, and `nlink ≥ 2`. It also checks that no retained record of either kind references the digest. A recorded `(dev, ino)` alone is never sufficient. After a restore or a copy it is either meaningless or, with inode reuse, a false match.
  - This check handles both copy styles in the parent's evidence. I tested both: `rsync -aH` keeps the shared inode, so recovery can still prove ownership and clean up correctly. `rsync -aS` and `copyFile` break it, so the conservative rule applies.
- **Resolve before deleting staging.**
  - On the failure path: unlink the proven blob, then mark the intent resolved, then unlink staging.
  - On the success path: commit the record and the intent outcome together, then unlink staging.
  - This keeps one invariant: an unresolved intent always has its staging file present. A crash at any step can therefore be retried, and the conservative rule (discard staging, keep the unproven blob) is always available.

### R3. Backup must detect unfinished work without opening SQLite

`repositorySnapshot` never opens the database. It copies `state.sqlite` and its WAL raw and excludes only `-shm`. The draft's check for "unresolved installation intents" would therefore be new: a SQLite read during backup. In WAL mode, even a read-only open can create `-shm`. A read-write open can checkpoint the WAL on close. Either contradicts "does not mutate".

With the R2 invariant, the check can be a pure directory read. **Replace** "while binary staging files or unresolved installation intents remain" with:

> "Builtin backup refuses with Conflict if the dedicated binary-staging directory contains any entry. By the recovery invariant, this includes every unresolved installation intent. Backup does not open the database for this check."

Also change "If recovery fails, report that cause" to:

> "Backup reports that unfinished installation work exists. Daemon startup reports any recovery failure and its cause."

An offline backup cannot see a recorded recovery cause without reading the database.

The check stays race-free: `repositorySnapshot` already holds exclusive ownership for its whole run, so no new staging can appear after it.

## Should fix (optional before presentation)

- **S1. Releasing the permit and closing the descriptor are not atomic on abort (from source, round 3).** `RpcServer` interrupts the handler fiber without waiting, so the request Scope (and its permit) can close before the handler stream's descriptor finalizer runs. A new request may then be admitted while the aborted request's descriptor is still closing. Worded this way it is honest: "the permit bounds active producers; descriptor closes on abort complete shortly after." The proof "abort closes the file and releases capacity" should wait for both events, not assume any order between them.
- **S2. Add a proof for shutdown ordering.** "Shutdown … waits for their file finalizers before releasing repository services" is still inferred from source. Add a proof bullet: "Stopping the daemon during an active download runs the descriptor finalizer before the lake Layer releases." Nothing breaks if the order is wrong, because a descriptor read does not depend on SQLite. But the draft states the order as fact.
- **S3. Clarify the double-count sentence.** "Copies of both staging and its linked blob consume the backup/copy budget twice" applies only to raw offline copies, because builtin backup refuses whenever staging exists. Say that, and recommend `rsync -aH` (or a clean daemon start and stop before copying) for the documented offline procedure. The parent's evidence used `-aS`.
- **S4. Required proofs.** The list already has most items, but should add:
  - an R1 test on Linux: unlink and recreate at the digest path while the writer is verifying;
  - R2 crash points: after the intent commits but before link; after link but before commit; after the blob unlink but before resolve; after resolve but before the staging unlink;
  - a backup test showing that a repository with staging present is refused, and that no `-shm` or `-wal` file is created or changed.

## Confirmed as written

- **Download and reclamation race.** Both sides use the same synchronous section, so the outcome is either NotFound (reclamation first) or byte-identical completion from the descriptor (open first). Hashing and length checks while streaming, plus `fstat` on the descriptor, stop a swapped path from serving the wrong bytes. `unlinkJob`'s `lstat` size and regular-file check stays as it is.
- **Writer re-link with JSON.** JSON `atomicBlob` never overwrites: its exists check, verification and rename are all synchronous in the same section. So a JSON publication cannot change the inode under a byte writer at runtime. The "changed inode" branch matters only for concurrent byte writers and repositories that were copied or edited outside Effectory.
- **Reclamation intents across restore.** They are keyed by digest and reference-checked again at unlink time, so they are safe to copy. If a resumed job unlinks a linked but uncommitted installation blob, installation recovery then sees a missing blob and discards the staging file. That is consistent.
- **Finalizer registration.** The descriptor is opened inside the `acquireRelease` acquire step, which is uninterruptible, so a descriptor can never be open without its finalizer registered. Staging handles stay with the publication Scope, as approved.
- **Exact bounds.** Request-Scope producer bounds and fifth-request LimitExceeded refusal, with no client-consumption or end-to-end memory claim. These match round 3's measurements.

## Evidence

**Tested (scratch, outside the checkout):** `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/f3fe6c07-ded0-451c-a441-2adbfda89cb5/scratchpad/r4/probe.ts`. Environment: Bun 1.4.3, Darwin, APFS.

- On APFS, the inode of an unlinked file was not reused across 2,000 creates while its descriptor stayed open, nor across 2,000 more creates after it closed.
- `link()` gives staging and blob the same `dev` and `ino`, with `nlink` 2.
- `rsync -aH` preserves the shared inode (`nlink` 2).
- `rsync -aS` breaks it: distinct inodes, `nlink` 1.

**From source:**

- `lake.ts` sets `synchronous = FULL`, and `atomicBlob` is fully synchronous and never overwrites.
- `unlinkJob` checks references, then `lstat` size, then marks the job started, then unlinks.
- `repositorySnapshot` copies under `ownershipLayer` and never opens SQLite.
- The backup exclusion list omits only `-shm` and the owner files.

**Inference (not tested):**

- ext4 inode reuse after close.
- WAL `-shm` creation or a checkpoint caused by a backup-time SQLite read.
- The ordering of RPC shutdown relative to the descriptor finalizer.

The parent's offline rsync evidence covers the current JSON/runtime state only. It is not evidence for future binary installation recovery, and I did not treat it as such.
