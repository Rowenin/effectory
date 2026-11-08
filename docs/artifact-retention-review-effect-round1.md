# Artifact retention draft — Effect and consumer review, round 1

Reviewed: `docs/artifact-retention-api-draft.md`. Reviewer approval is not user approval. All retention syntax in the draft is a proposal; none of it is implemented. `Artifact.make` currently throws on any `retention` key (`packages/core/src/artifact.ts:36-40`).

Evidence labels used below:

- **[source]**: read in this checkout.
- **[probe]**: scratch script run outside the checkout against the pinned `effect@4.0.5` and Bun's SQLite.
- **[inference]**: reasoning from the two above.
- **[proposal]**: reviewer suggestion, not approved.

## Verdict

The draft's direction holds up: author-declared policy, operator plan/apply, tombstones that keep receipts and version floors, and protection for active producers. Its Effect primitive choices (Duration, Schema, no new author service, no Config) are also right.

**One substantive blocker needs a revised section and a short focused re-review:** where the effective policy comes from (B1). Everything else is a small doc correction or an implementation constraint that the "Required proofs" list can absorb. Those do not need another round once applied as written below.

The maxAge/latest semantics (D1) are a user decision rather than a reviewer blocker. The presentation must show it with the counterexample given here.

## Facts established from source

- **Artifact identity:** `artifactId = sha256(canonical([principal, taskId, output, key]))` (`lake.ts:290-292`). The schema id and version are not part of identity, so one artifactId can hold versions from several schema ids/versions. The same definition registered under two output aliases yields two identities. A key that varies per run yields a new identity per run.
- **Versions:** assigned as `COALESCE(MAX(version),0)+1` over `lake_records` for the artifactId, inside the publish transaction (`lake.ts:293-299`). `UNIQUE(artifactId, version)` and `publicationKey UNIQUE`. Deleting rows would reuse version numbers, so tombstone rows (or a floor table) are required. Keeping tombstone rows satisfies MAX, both UNIQUE constraints and receipt fingerprints at once **[probe]**.
- **Digest location:** the digest lives only in `metadataJson` (also inside the canonical `fingerprint` string). There is no digest column and no index **[source]**. A partial expression index `ON lake_records(json_extract(metadataJson,'$.digest')) WHERE collectedAt IS NULL` is used by SQLite 3.51 for `= ? AND collectedAt IS NULL` lookups. Without the partial predicate in the query, it falls back to a full scan **[probe]**. So per-digest reference checks are feasible without a new table, but every reference query must repeat the predicate exactly.
- **Blob install:** `atomicBlob` returns early when the digest file already exists (after verifying it), then the metadata transaction commits (`lake.ts:56-85, 215-216`). Publish, get and query are synchronous `Effect.try` bodies on one connection, guarded by the repository lease **[source]**.
- **Reading content:** the only reader is the `LakeGet` RPC (`control-plane.ts:266`). No runtime or SDK path reads lake content during a run today **[source]**. Today's cross-run exposure is therefore limited to external `lake get` callers. A future `ArtifactStorage` read or stream API would change that.
- **Publication admission:** requires run status `Queued | Running | Waiting | Retrying`, no fence, and a matching attempt owner (`lake.ts:241-249`). Terminal statuses (`Succeeded, Failed, Rejected, TimedOut, Cancelled`) are final: `project` refuses to leave them (`host-store.ts:1225-1227`). `NeedsAttention` can return to Running, and **`Cancelling` is a non-terminal status** (`host-store.ts:473, 974`).
- **Principal:** the control plane hard-codes the `"owner"` principal (`control-plane.ts:266-268`). The protocol `Record` has no principal field.
- **Query cursors:** a query cursor stores `(snapshot = MAX(sequence), position = last returned sequence)`. On resume it raises `CursorExpired` only when the **anchor row** is gone (`lake-query.ts:425-435`). Removing any other row between pages is silently skipped. `matched` changes. In `versions: "latest"` mode, a newer row hides older ones through a `NOT EXISTS newer` subquery (`lake-query.ts:289`). Version-list cursors key on version number and never detect removal (`lake-versions.ts`).
- **Clocks:** `committedAt` comes from `new Date()` and attempt clocks from `Date.now()` (`lake.ts:320`, `host-store.ts`). They are not Effect `Clock`.
- **Backup:** backup is an **offline whole-repository snapshot** under exclusive `RepositoryLease` (`backup.ts:184-238`). It is capped at 50,000 files, 1 GiB total and 128 MiB per file.
- **Swamp parity:** per-spec `garbageCollection` takes _either_ a count _or_ a duration. The duration form **never removes the latest version** (`vendor/swamp/src/infrastructure/persistence/unified_data_repository.ts`, `collectGarbage`: `if (version !== latestVersion)`). Only `lifetime` expiry and repository-wide `garbageCollection.data` remove the latest (`design/primitives/data.md:370-385`).

## Probe facts (Effect 4.0.5)

Results of `Duration.fromInput`:

| Input | Result |
| --- | --- |
| `"30 days"`, `"30 day"`, `{ days: 30 }` | 2,592,000,000 ms |
| `"1 month"`, `"30days"`, `" 30 days"`, `"1e3 millis"` | `None` |
| `"Infinity"` | infinite |
| `NaN` | **0** |
| `-1` | −1 ms |
| `1.5` | 1.5 ms (fractional) |
| `2n` | **2 ns** (bigint is nanoseconds) |
| `[1, 0]` | 1 s |

`Schema.DurationFromMillis` encodes `Duration.infinity` as the number `Infinity`, which `JSON.stringify` writes as `null`.

**Race probe.** It ran three steps against real files:

1. GC tombstones a row and counts references (0).
2. GC yields once (`await`).
3. A publisher of identical bytes takes `atomicBlob`'s exists-early-return path and commits.

GC then unlinks. The result was 1 retained reference with no blob. The draft states this hazard abstractly; the probe shows it is real as soon as any yield sits between the reference check and the unlink.

## Blocker

### B1. Policy taken from the latest publication cannot reclaim dormant or key-churned data

**Counterexample.** A scheduled task publishes `Report` with `key: date` (or any per-input key) and no retention for six months. That gives about 180 identities, one version each. The author adds `retention: { maxAge: "30 days" }` and deploys.

Under the draft, an identity's policy changes only when that identity publishes again. Yesterday's keys never publish again, so none of the 180 is ever eligible. Tightening 30→7 days later has the same problem: only identities that publish again are affected. The draft offers single-version `lake delete plan <artifactId> --version N` as the route. That means 180 (or 18,000) plan/apply pairs, which contradicts "No source-code changes or publishing are required to recover a full binary store".

maxVersions has the same blind spot. It is counted per identity, so a key that changes every run never exceeds 1 version.

Mixed schema ids under one artifactId also make "latest publication's policy" govern versions written under another definition. That may be intended, but the draft does not say.

**Smallest fix [proposal].** Resolve the effective policy from the **active application revision**, not the latest row:

1. Take `Catalog.get()` → `registry.artifacts.get(schemaId of the identity's newest row, tombstones included)` → the normalized, frozen `retention` value. This is plain data on an already-loaded frozen definition. No author code or Layer is run, so the draft's reason for avoiding the active revision does not apply **[source: `application.ts` Registry exposes `artifacts`; `artifact.ts` freezes definitions]**.
2. If the active revision no longer contains that definition id, fall back to the policy captured on the newest row (store it in a separate column, not in `Record` or `fingerprint`).
3. The plan output reports `policySource: "ActiveRevision" | "Captured" | "None"` and the revision id. Apply revalidates against the revision active at apply time and skips candidates whose eligibility changed.

Cost: rolling back a revision changes policy. That tradeoff is visible and previewed, which is better than policies that can never take effect.

If the user prefers to keep capture-on-publish, the draft must replace the one-version recovery claim with a bounded bulk explicit mode. Example: `{ _tag: "Explicit", schemaId, schemaVersion?, committedBefore }`, capped by the existing 1,000-candidate plan bound. It also needs the key-churn example in the presentation.

Either way, add "count retention is per identity (principal/task/output/key); per-run keys need maxAge" to the consumer text.

**Re-review scope:** only the revised policy-source section plus its proofs.

## User decision (must be presented, not a reviewer blocker)

### D1. maxAge removes the newest version: this is not Swamp's GC semantics

With OR semantics, `{ maxVersions: 10, maxAge: "30 days" }` on a monthly or paused schedule deletes the _only_ report after 30 days. Many readers will take `maxVersions: 10` to mean "keep at least the recent ones".

Swamp's per-spec duration GC keeps the latest. Removing everything is Swamp's `lifetime` and repository retention behavior. The draft's choice is the one that handles key churn (see B1), so it is defensible. The presentation should offer both options with this example:

- **(a) As drafted:** age can empty an identity.
- **(b) Swamp-parity:** `maxAge` keeps the newest retained version. Whole-identity expiry is deferred to a separately named field later (for example `expireAfter`). Under (b), key churn still needs B1's bulk route or a later lifetime field.

## Small corrections (apply as written; no further round needed)

1. **Protected statuses.** Replace the enumerated list with "any non-terminal status (everything except Succeeded, Failed, Rejected, TimedOut, Cancelled)". The draft's list omits `Cancelling`. A run in Cancelling still owns attempts whose idempotent re-entry could reuse a receipt. Defining it by the terminal set also covers future statuses.
2. **Collected-receipt retry is unreachable.** Publication is admitted only for non-terminal runs, terminal is final, and non-terminal producers are protected. A collected receipt therefore can never be retried through `publish`. State it as an invariant with a defensive check: if the `publicationKey` row is tombstoned, fail `Conflict` "publication was reclaimed". Do not invent a restore path.
3. **Count rank.** "Newest maxVersions" ranks among _retained_ versions by version number. Tombstones and explicitly deleted versions do not count. Protected versions count toward N.
4. **Schema filter.** `--schema/--schema-version` filters **candidate rows** by their own schemaId/version. Ranking and policy still come from the whole identity (see B1). Say so; otherwise an operator filtering `report@1` will be surprised that the rank includes `report@2` rows.
5. **Policy source on explicit deletion of the newest version.** Under capture semantics, the policy comes from the newest row _including tombstones_. Under B1's fix it comes from the active definition with the same fallback.
6. **"latest" after collection.** Define it as the newest _retained_ version. Today's `NOT EXISTS newer` subquery must exclude tombstones, or explicitly deleting v5 hides a retained v4 from every latest query. `LakeVersions` should keep returning NotFound for a wholly collected identity, not an empty page (its existence check uses `MAX(version)` and would see tombstones).
7. **Cursor detection.** The current code does not meet the draft's "detect a collection … fail CursorExpired" requirement. It only notices a missing anchor row, and in latest mode a collection can _surface_ an older row behind the cursor. Smallest fix: keep a per-principal `reclamationEpoch` counter, increment it in the apply transaction, embed it in both lake query and version cursors, and fail `CursorExpired` when it differs. Without the epoch, the doc should promise only snapshot-of-retained semantics.
8. **Retry and status.** `applyReclamation` with an already-used `(actor, requestKey)` returns the stored receipt **regardless of plan expiry**, after first resuming any pending unlinks. That makes the receipt the status surface, so no separate status RPC is needed. Startup recovery runs the same resume.
9. **Wire schema.** Use the codebase's `_tag` convention (`Schema.TaggedStruct`/`Schema.Union`, as in `lake-protocol.ts` `Expression`) rather than `mode`. Carry `maxAgeMillis` as a positive `Schema.Int`, never as `DurationFromMillis`: an infinite value would serialize as JSON `null`.
10. **Duration validation.** Normalize with `Duration.fromInput`, then require `isFinite`, `toMillis >= 1000` (or at least ≥ 1 and an integer after `Math.floor`), and freeze. Reject at `Artifact.make` with the existing synchronous `Error` style. Document the probe pitfalls: a bare number means milliseconds, a bigint means **nanoseconds**, `NaN` becomes 0 (and is rejected), and `"1 month"` is unsupported. Copy the retention object rather than relying on the existing `...spec` spread, which keeps the caller's reference.
11. **Clock.** Plan "now" comes from `Clock.currentTimeMillis`, but `committedAt` is wall-clock `new Date()`. TestClock proofs therefore need fixture rows, or a change so publish reads `Clock`. Treat a negative age (backward skew) as 0.
12. **Backup.** Backup is already an offline whole-repository snapshot, so tombstones, receipts and intents are included automatically. The requirement reduces to "pending-intent recovery is idempotent: ENOENT is success, and references are rechecked before every unlink". Also note that retention directly affects backup feasibility: the snapshot caps out at 50,000 files and 1 GiB.
13. **Orphans.** Defer the `orphans` plan mode. Its only sources today are crash-time installs (`lake.ts:214` comment), so it is not needed for the binary-store recovery claim once B1 lands.

## Implementation constraints (delegated design; add to Required proofs)

- **Reference check and unlink in one non-yielding section.** Each unlink must be preceded by a reference recheck (`json_extract` partial index, or a `lake_contents` table) in the same synchronous critical section on the lake connection, with no Effect yield between them. Today's publish is fully synchronous, so this alone closes the probe's race in-process.
- **Digest leases for future async writers and readers [proposal].** Streamed binary writes and reads will yield, so add a process-local digest lease registry (a ref-counted map). Acquire a lease with `Effect.acquireRelease` in the operation's `Scope`: publishers before `atomicBlob`'s existence check, readers for the stream lifetime. GC **skips** leased digests (no waiting) and leaves them as pending intents. An in-memory registry is sufficient because the repository lease makes the daemon the only writer, and a crash ends every lease along with the process. Nothing about leases is exposed publicly.
- **Apply transaction contents.** One SQLite transaction holds: recheck protection, policy, identity and `sequence ≤ plan snapshot`; tombstone rows; insert digest intents; write the receipt with pending bytes; bump the epoch. Unlinks run afterwards, each followed by a small receipt update. Never run a codec or async I/O inside the transaction.
- **Progress guarantee.** Plans exclude protected versions and order candidates deterministically, so applying a `hasMore` plan always makes progress.
- **Plan storage.** A simplification to consider: a stateless HMAC-signed plan token, reusing `createPagination`'s secret, that encodes the request, snapshot sequence, plan time and a candidate-set hash. It replaces plan storage, the 64-plan limit and pruning. Apply then recomputes and intersects. Optional; the stored-plan design is also acceptable.

## Consumer-perspective check

- **Coherence without extra services or DSLs.** Yes: two optional fields on `Artifact.make`, plus CLI and RPC entry points on the existing lake family. Nothing is added to the author's Effect context, so `ArtifactStorage` stays unchanged.
- **Error codes.** Collected content returning `NotFound` with an explicit message is acceptable. `ContentUnavailable` must keep meaning corruption only.
- **Cross-run references.** The documented limitation is acceptable _for this slice_, because no in-run reader exists today (see Facts). Any future in-run read or stream API must reopen this question before shipping. Record that dependency in the binary proposal.
- **Required presentation examples:** per-run keys with count retention (B1), monthly report with maxAge (D1), an alias registered under two outputs giving separate counts, and a cross-run reference expiring.

## Summary for the parent

- **Blocker:** B1 (policy source and dormant/key-churn reclamation). Revise the draft, then re-review that section only.
- **User decision to present:** D1.
- **Small corrections:** items 1–13. Apply them; they need no further reviewer round.
- **Implementation constraints:** belong in the proofs list.
- **Reviewed and sound:** tombstone/floor design, active-producer protection (with fix 1), shared-digest single counting, offline backup compatibility, and the `lake.retention.v1` gate.
