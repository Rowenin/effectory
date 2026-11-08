# Artifact retention draft — Effect review, round 2 (focused on B1)

Reviewed: revision 3 of `docs/artifact-retention-api-draft.md`, section "Policy source and dormant-artifact recovery". Only the parts of the selector, plan/apply and proofs that B1 depends on were checked. This is not a full re-review and does not ask for another round.

**Reviewer approval is not user approval.** Retention is still unapproved. The user must still choose D1 (newest-version protection versus whole-identity age expiry).

Evidence labels:

- **[source]**: read in this checkout.
- **[probe]**: scratch scripts in the session scratchpad, run under Bun's SQLite with the pinned `effect@4.0.5`. They live outside the checkout and nothing in the checkout was modified.
- **[inference]**: reasoning from the two above.

## Verdict

**B1 is resolved. Approved for presentation once corrections C1–C3 below are applied as written; no further round is needed.**

The draft keeps capture-at-publication and adds a bounded, schema-scoped operator Selection. That is the alternative round 1 offered, and it does reclaim dormant and per-key identities without republishing. The declined active-revision lookup is now described correctly: the draft calls it feasible and treats rejecting it as a deliberate choice. C4 is an implementation constraint for the proofs list.

## Source facts that support the revised section

- **Separate policy column.** `lake_records` has no policy column today (`packages/platform-bun/src/lake.ts:129-135`). The fingerprint covers `digest`, `schemaId`, `schemaVersion` and `tags` only (`lake.ts:208-213`). A separate column keeps policy out of the fingerprint and out of the public `Record`, as the draft says **[source]**.
- **Duplicate receipts don't rewrite policy.** The dedup lookup by `publicationKey` returns the prior record before any insert (`lake.ts:250-263`). A policy column written only on the insert path therefore cannot be rewritten by a retry. Admission is checked before dedup (`lake.ts:240-249`), so the draft's Conflict for a tombstoned key slots in there **[source]**.
- **Mixed schemas within one identity.** Identity is `sha256(canonical([principal, taskId, output, key]))` (`lake.ts:290-292`), and each row stores its own `schemaId` and `schemaVersion`. Per-row schema filtering combined with identity-wide ranking can therefore be expressed **[source]**. Probe: one identity held v1 under schema `old`, v2 under `report@1` and v3 under `report@2`, with policy `maxVersions: 1` captured on v3.
  - Policy mode filtered to `report` selected only v2.
  - Policy mode filtered to `old` selected only v1.
  - In both cases ranking used the whole identity **[probe]**.
- **Policy after the newest version is deleted.** An identity's newest row was a tombstone carrying `maxAge: 30 days`. Its older retained rows were 60 and 90 days old. The 60-day row stayed protected as the newest retained version, and the 90-day row was selected. No older policy was resurrected **[probe]**.
- **Selection semantics.** Fixture: 180 single-version daily identities with no policy, plus the two identities above. Selection `schema=report, olderThan=30 days` selected 153 rows: 150 daily rows plus 3 old rows from multi-version identities. Adding `keepLatest 1` reduced that to 2. This confirms that the two selectors intersect and that age-only selection can empty identities **[probe]**.
- **Wire types.** `Schema.TaggedStruct`/`Schema.Union` with `_tag` is the existing convention (`packages/runtime/src/lake-protocol.ts:56-68`). `Schema.Int.check(Schema.isGreaterThan(0))` accepts 1 and rejects 2^53, 1.5, Infinity and −1, and it encodes to a plain JSON number. So "positive safe-integer `olderThanMillis`/`maxAgeMillis`" needs no custom schema **[probe]**.
- **Runs are pinned to a revision.** `host_runs.revision` is `NOT NULL` (`packages/platform-bun/src/host-store.ts:176`). The `artifact` that `publish` receives, and so the captured policy, comes from that run's revision, not from whichever revision is currently active **[source/inference]**. This matters for C3.

## Corrections (small; apply without another round)

### C1. The dormant-key proof is vacuous; state the stronger consequence

Under the recommended D1, author policy never makes the newest retained version eligible. Every one-version identity is therefore ineligible under policy mode, whatever the policy source, even when retention was declared from day one. The required proof "180 daily identities … policy mode selects none" passes for that reason alone. It proves nothing about capture-at-publication.

- **Proofs:** add a multi-version identity test. Publish v1–v3 with no policy (or with `maxVersions: 10`). Tighten the definition to `maxVersions: 1` without republishing, and verify that policy mode selects none. Then publish v4 under the new definition, and verify that v1–v3 become eligible. Keep the 180-identity case as the test that operator Selection recovers them.
- **Draft wording:** replace "neither adding retention later nor maxVersions can collect old one-version daily identities" with this: "under newest-version protection, author retention never collects single-version identities, including per-key identities that had retention from the start. Operator Selection is the only route for them." The D1 presentation should name per-key/daily identities as the second consequence, next to the paused monthly report. If the user chooses whole-identity age expiry, author `maxAge` would collect them.

### C2. Apply re-evaluates eligibility at apply time, not only the plan's selector

The draft says apply revalidates "against current protection, captured policy or explicit selector". It does not say whether the ranking and the effective policy are recomputed. Counterexample **[inference]**:

1. Plan A explicitly deletes v5.
2. Plan B, in Policy mode, selects v4, which is legitimately not the newest because v5 still exists.
3. Apply A, then apply B.
4. The identity is now empty under a mode that promises newest-version protection.

The reverse case also matters. A publication after the snapshot can capture a looser policy, and B would still apply the stricter one.

Required wording: "A candidate is removed only if it is eligible both in the plan and when re-evaluated inside apply's transaction. Re-evaluation uses the current newest-row policy (including rows committed after the snapshot and tombstones), the current retained ranking (protected versions still count), and the plan's fixed evaluation time or cutoff. Otherwise the candidate is skipped and reported."

The same rule covers Selection with `keepLatest` and keeps the age cutoff stable. Add the two-plan sequence to the revalidation proof.

### C3. Make "next new publication" precise, and keep the policy on tombstones

- **Which publication captures the policy.** Runs are pinned to their revision, and policy is taken from the highest version number. A run that is still executing an older revision and commits after the deploy therefore re-captures the old policy, until the next run on the newer revision publishes. Say "the next publication by a run of a revision containing the edited definition". Note that a long-running or retried old-revision run can temporarily restore the earlier policy. This is still stable captured semantics. It just isn't "takes effect on deploy".
- **Tombstones keep their policy.** State that tombstoning a row leaves its policy column intact. The newest-row rule reads tombstones, so clearing that column would reintroduce resurrection.
- **Spell out the scope of identity-wide ranking.** State that it applies to Selection `keepLatest` as well as to Policy mode. The current sentence says "count ranking" without naming the mode.

## Implementation constraint (C4; add to Required proofs)

"At most 1000 candidates" bounds the plan's output, not its scan. Two source facts drive the cost:

- `committedAt` exists only inside `metadataJson` (`lake.ts:320, 336-338`). It is wall-clock, so it is not monotonic in `sequence`.
- Identity-wide ranking cannot be answered from the `lake_schema(principal, schemaId, schemaVersion, sequence)` index alone.

Probe on 200k in-memory rows (100k matching the schema):

| Query shape | 1001 candidates | No match |
| --- | --- | --- |
| Principal-wide `ROW_NUMBER() OVER (PARTITION BY artifactId)` | ~0.8 s | ~1.7 s |
| Driven from `lake_schema`, with a correlated count of retained newer versions through the `UNIQUE(artifactId, version)` index | ~0.4 s | ~0.1 s |

Every variant runs synchronously on the one lake connection **[probe]**. Preferred approach:

- Drive the scan from the schema index in `sequence` order, and rank each candidate with the correlated retained-newer count.
- Add an internal `committedAtMillis` column (and, optionally, an index that includes it) rather than calling `json_extract` on every row.
- Repeat the retained predicate in every partial-index lookup, as round 1 noted.

Add a proof bounding plan latency at a stated row count, and a proof that the deterministic `sequence` order makes progress across `hasMore` iterations.

## Not re-raised

These items are accepted as revised: six-field Selection, `_tag` Policy/Selection/Version, integer `olderThanMillis` with Duration input at the CLI, age ∩ keepLatest, author OR semantics for non-newest versions, protected versions counting toward N, alias isolation, no `policySource` output field, and no active-registry lookup.

The remaining round-1 fixes that the draft says it folded in were not re-reviewed: nonterminal protection, tombstones, cursor epoch, duration bounds, replay, the non-yielding unlink, backup recovery and the deferred orphan mode.

## Summary for the parent

- **B1 is resolved:** reviewer approval for presentation after C1–C3, with no further round. C4 goes into Required proofs.
- **Still the user's decision:** D1, and approval of retention as a whole. C1 adds per-key identities as a D1 consequence to present.
