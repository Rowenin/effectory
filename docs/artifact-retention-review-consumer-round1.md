# Artifact retention draft — consumer/CLI review, round 1

Reviewer: Claude (consumer and operator perspective). Subject: `docs/artifact-retention-api-draft.md`. Reviewer approval is not user approval. Every API in the draft is a proposal; nothing here is implemented.

Verdict: **revise before presentation.** The direction holds up: manual-only collection, plan/apply, tombstones plus version floors, and honest physical/logical bytes. Three blockers stop an operator from reclaiming a full store, or would surprise consumers who rely on a latest version. Each has a small fix. The other items are doc corrections or optional additions that need no further review round once they are applied.

Evidence labels: **[source]** means checked in this checkout, **[probe]** means run against pinned Effect 4.0.5 under Bun, **[inference]** means reasoning, and **[proposal]** means a suggested change.

## Facts checked

- [source] `packages/platform-bun/src/lake.ts`: `artifactId = sha256(canonical([principal, taskId, output, key]))`. The definition's `id` is not part of identity, but the publication `key` is. `version = COALESCE(MAX(version),0)+1` for each artifactId, so deleting every row of an identity would reuse version 1 without a floor. `publicationKey = [runId, invocationPath, output, key]` is UNIQUE and is the dedup lookup. `committedAt` comes from `new Date()`, not Clock. Content is `atomicBlob(directory, digest, bytes)` and is written before the metadata transaction. `get` reads the file synchronously and verifies its digest and length.
- [source] Publication is admitted only while the run is `Queued/Running/Waiting/Retrying` and the attempt owner matches. A completed run therefore cannot re-hit its own collected `publicationKey`. Only an unfinished run can, and the draft already protects those. So the "low-level retry of a collected receipt" case is narrow. It still needs a defined Conflict (or equivalent) so that a tombstoned key never inserts a new version.
- [source] `control-plane.ts` hard-codes principal `"owner"` for Lake RPCs today. Multi-principal semantics are therefore future-facing.
- [source] CLI `--request-key` pattern (`waitDecision`, `main.ts:207`): the CLI generates a UUID when the key is omitted. It prints the key only on uncertain delivery, so the user can retry with it. The draft's "generated; retries reuse it" matches this existing behaviour.
- [source] Existing `OperationError` codes include `NotFound`, `ContentUnavailable`, `CursorExpired`, `LimitExceeded` and `StorageFull`. `StorageFull` tells the user to "free space before retrying". Today no command can free space, which is why this feature matters.
- [probe] `Duration.fromInput` (Effect 4.0.5):
  - `"30 days"` → 2592000000 ms and `"1 week"` works.
  - `"1 month"` → `None`. Swamp's `mo` unit has no equivalent.
  - `"0 millis"`, `-5` and `"Infinity"` are all accepted.
  - The draft's own "finite positive" check is therefore required, not redundant. Docs should not show month units.
  - The probe ran from a transient file that was deleted immediately. No checkout file remains.
- [source] Swamp `vendor/swamp/src/infrastructure/persistence/unified_data_repository.ts` `collectGarbage`:
  - The per-spec policy is either an integer _or_ a duration, not both.
  - Names with ≤1 promoted version are skipped.
  - The duration branch explicitly keeps `latestVersion`.
  - The policy comes from the data record (`data.garbageCollection`), i.e. captured at write time, not from the current definition.
  - Only the operator-level repository `garbageCollection.data` removes the latest version (`data.md` Versioning table).
  - Swamp per-version `data delete` writes no tombstone and leaves `ModelOutput` references dangling.
  - `gc --dry-run` is a read-only preview with no stored plan.

## Blockers

### B1. A full store of legacy or keyed artifacts cannot practically be reclaimed

Counterexample [inference from source identity]: a daily task publishes `Report` with `key: "2026-11-05"`. Each key is its own artifactId, with one version each. After a year there are 365 identities, all published before `retention` existed, so none has a captured policy. The draft offers two recovery routes:

- Editing the definition does nothing, because those keys are never republished (dormant by construction, not by accident).
- `lake delete plan <artifactId> --version N` requires 365 plan/apply cycles, plus a separate discovery step through `lake query` to learn the hashed artifactIds.

Even with a policy, `maxVersions` is useless for this pattern: every identity has exactly one version. The operator facing `StorageFull` has no bounded bulk route, which is the scenario the user prioritised.

Smallest fix [proposal]: make the operator-supplied policy a third plan mode, reusing the same bounded and revalidated plan/apply path. Drop the per-version-only mode as the sole recovery route:

```ts
{ mode: "selection", schemaId, schemaVersion?, artifactId?, olderThan?: Duration.Input, keepLatest?: PositiveInt }
```

- At least one of `olderThan` or `keepLatest` is required.
- `schemaId` is required, so there is no unscoped `--all`.
- The same 1000-candidate cap, `hasMore`, unfinished-run protection and tombstones apply.
- An explicit single version becomes `{ mode: "selection", artifactId, version }`, or stays as its own variant.

This is Swamp's `--older-than`, repository `garbageCollection.data` and `data delete --prefix` collapsed into one previewed, bounded selector. It also answers "dormant" and "legacy" without loading author code, and makes the "policy changes only on next publication" tradeoff acceptable.

CLI shape: `effectory lake reclaim plan --schema report --older-than "90 days" --json`.

### B2. Author `maxAge` deleting the newest version diverges from Swamp and breaks latest-readers silently

The draft's sources paragraph says Swamp's "age policy can remove the newest version". [source] That is true only of the repository-wide operator retention. Swamp's per-spec duration GC never removes the latest version.

Counterexample: a quarterly `Config` artifact declares `maxAge: "30 days"`. In month two, `gc apply` deletes its only version. A scheduled workflow that queries the latest `Config` now gets an empty query or `NotFound`. The author never asked for "make this artifact disappear", only for "don't keep old copies".

The OR semantics make it worse. `{ maxVersions: 10, maxAge: "30 days" }` reads to many consumers as "keep 10, and anything newer than 30 days". Under the draft it is instead "remove anything beyond 10 _or_ older than 30 days, including the newest".

Smallest fix [proposal]:

- An author policy never makes the newest version of an identity eligible. This matches Swamp per-spec behaviour.
- Removing the final version is operator-only, through B1's `olderThan` selection, where the plan states it explicitly. For example, the reason could be `Age(final)`, with a count of identities that will become empty.
- Keep remove-if-either for the two author fields and document it with one worked example.
- Correct the Swamp comparison sentence.

### B3. Apply idempotency must outlive plan expiry, and the receipt must be retrievable

Counterexample: an operator runs `gc apply` at minute 14. The daemon commits the logical deletion and starts unlinking, then the client connection drops. The operator retries at minute 16 with the same request key. Under "an expired plan fails Conflict … preview again", the retry fails. A new preview shows fewer candidates, and the operator cannot tell whether the deletion happened or how many `pendingBytes` remain. The draft also leaves the status RPC open.

Smallest fix [proposal]:

- Look up the receipt by (actor, requestKey), or by (actor, planId), _before_ checking plan expiry. A retry always returns the current receipt, with `pendingBytes` updated as cleanup progresses.
- With that rule, a separate status RPC is unnecessary: re-running apply _is_ the status call.
- Simpler still: make `planId` the idempotency key, so one plan has at most one apply and one receipt, and drop `requestKey` from this RPC.
  - A plan is already actor-scoped and immutable, so a second key adds a conflict case without adding a use.
  - If the team keeps `requestKey` for consistency with other mutating RPCs, state that its scope is a single plan.
- Specify how long receipts are retained (they are small, so indefinitely, or as long as the tombstones), so a retry days later still answers.

## Doc corrections (no further round needed once applied)

1. **Naming.** `lake delete plan` applied by `lake gc apply` reads badly. Use one family:
   - `effectory lake reclaim plan [--schema S [--schema-version V]] [--artifact ID [--version N]] [--older-than D] [--keep-latest N] [--policy]`
   - `effectory lake reclaim apply <planId>`

   `--policy` (or the absence of a selection) means the captured author policies. "Reclaim" matches the RPC names `planReclamation`/`applyReclamation`. Avoid `gc`: Swamp's `gc` deletes without a stored plan, so the borrowed name implies the wrong workflow.

2. **Bytes.** Define `logicalBytes` as the sum of the candidate records' `bytes`. Define `reclaimableBlobBytes` as an estimate at plan time that apply may lower. The receipt's `reclaimedBytes` is authoritative. A candidate whose blob is shared reports its logical bytes and contributes 0 to the physical bytes. Small canonical JSON values (`{"count":0}`) dedup heavily, so show a one-line example where deleting 1000 versions frees almost nothing.
3. **Discovery.** State how operators find what to reclaim. Today only `lake query`/`lake versions` expose artifactIds, and nothing reports usage. With B1, a broad preview such as `reclaim plan --schema X --older-than "1 day"` doubles as a sizing report. That is enough for this slice, so do not add a separate `usage` command unless the user asks for one.
4. **Collected-content error.** `NotFound` with a message cannot be branched on. Keep the gated `NotFound` code for old clients. For `lake.retention.v1` clients, either add a new `Reclaimed` code or have `lake versions --include-reclaimed` list tombstones (`reclaimedAt`, plan/receipt id), so "never existed" and "deliberately collected" can be told apart. I recommend the tombstone listing: it reuses existing data and adds no error variant.
5. **Duration validation.** Probe facts: zero, negative and `Infinity` are accepted by `Duration.fromInput`, and month units are not. Reject the former at definition construction, and use `"days"`/`"weeks"` in examples. Measure age from `committedAt`, which is wall-clock today, against Clock "now". Say that TestClock controls only "now", unless the implementer also moves `committedAt` to Clock.
6. **Count semantics.** "newest maxVersions" counts _retained_ versions by version number, after earlier explicit deletes. Say so, and say that a tombstoned version never counts.
7. **Cross-principal oracle (future).** Once real principals exist, an actor's `reclaimableBlobBytes` for its own version reveals whether another principal stores identical bytes. Note the issue now. Either report physical bytes only to the owner principal, or report them in aggregate. Alternatively, scope blob dedup to each principal. This is not a blocker while the control plane is owner-only [source].
8. **Cross-run consumers.** The draft's honest limitation is acceptable _because collection is manual-only_. Add the example the draft promises: run B, still running, holds a reference from completed run A, `maxVersions: 1` collects it, and B's `LakeGet` fails. State that automatic collection will need this question reopened. No pinning API is needed in this slice.
9. **Plan bounds.** 15 minutes, 1000 candidates and 64 plans per actor are reasonable. Document the operator loop (`plan → apply → plan` while `hasMore`) in the CLI help. Do not add `--until-empty`: an unbounded deletion loop belongs in a script the operator reads.
10. **Swamp comparison wording.** Swamp has write-time integer caps and post-run GC (automatic), `data gc`, per-version and name deletion without tombstones, `prune` for orphaned definitions, and opt-in hourly repository-wide age retention. Effectory's slice is deliberately manual and tombstoned. Call that a parity _subset_ with stronger history guarantees, not parity.

## Items reviewed and accepted as written

- Policy snapshotted on `Artifact.make` and excluded from schema identity and fingerprints. Changing it needs no schema bump.
- Policy captured from the latest publication, so collecting never loads author code. Acceptable once B1 exists.
- Protecting unfinished producer runs, including `NeedsAttention`, with the check repeated inside apply's transaction and no force bypass.
- Tombstones, version floors, never-reused versions, preserved receipts, `CursorExpired` on invalidated snapshots, and no collection of run events or journals.
- Unlinking only after the tombstone commits, refcounting across all principals, store-boundary coordination with publication between blob install and commit, and restart recovery of unlink intents.
- Orphan blob cleanup: **defer.** Add a plan mode only after measuring how much crash orphaning actually occurs; it does not block reclaiming a full store.
- No MCP tool, and no automatic scheduler, in this slice.

## Summary for the author

Apply B1 (operator selection plan mode), B2 (author policies keep the newest version; final-version removal is operator-only) and B3 (receipt survives expiry; `planId` as the idempotency key), plus the doc corrections. After that, a further consumer round is needed only if the B1 selector grows beyond `schemaId/schemaVersion/artifactId/version/olderThan/keepLatest`.
