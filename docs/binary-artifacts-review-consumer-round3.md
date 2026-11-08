# Binary artifacts — consumer review, round 3 (revision 6)

Reviewer: Claude consumer review (developer/operator POV). Scope: `docs/binary-artifacts-api-draft.md` revision 6, read against `docs/artifact-storage.md`, `docs/artifact-retention-api-draft.md`, `docs/backup-restore.md` and the implemented source. Settled DI choices (`yield* ArtifactStorage`, the acquisition-plus-handler lifetime, explicit author FileSystem Layer) are not reopened.

**Reviewer approval is not user approval.** Nothing below authorizes implementation. Items marked **USER DECISION** must be put to the user explicitly.

## Verdict

Revision 6 is close. The authoring surface stays elegant and consistent with the implemented JSON service. Removing the unapproved 512 MiB gate is coherent now that reclamation exists. Three problems must be fixed before presentation:

- one internal contradiction: backup is described as both mutating and not mutating the source repository;
- one silent amendment to an approved contract: the meaning of `pendingBytes` and the success/failure behavior of apply;
- one storage limit presented as unchanged that becomes a practical dead end for binary repositories: the fixed 1 GiB backup cap.

All three have small textual fixes. **No further consumer round is needed** if the parent applies the corrections below and presents the listed user decisions. Run a focused re-review only if the parent redesigns backup-time recovery or proposes a new backup-limit API rather than making these edits.

## Evidence: tested vs inferred

Facts from reading the source (not from executing the suite):

- Today `applyReclamation` → `resumeReclamation` **fails with `Unavailable`** if any cleanup job fails. The error message carries the deleted, reclaimed and pending counts and says "Re-run lake reclaim apply" (`packages/platform-bun/src/lake-reclamation.ts`, the end of `resumeReclamation`). A successful receipt is returned only when no job recorded a failure. Jobs blocked by retained references finish as `Shared`. There is no lease state yet.
- The retention contract defines `pendingBytes` as "durable cleanup work remains after an I/O error or interruption" (`artifact-retention-api-draft.md`, Operator surface).
- Backup limits are hard-coded constants with no flag or config: `maximumBytes = 1_073_741_824`, 128 MiB per file and 50,000 entries (`packages/platform-bun/src/backup.ts:34–36`). Restore enforces the total again (around `backup.ts:186`). The `backup` CLI command takes only a destination. `backup-restore.md` calls these "Defaults", but they are fixed.
- `ENOSPC`, `EDQUOT` and `SQLITE_FULL` map to `StorageFull` (`packages/platform-bun/src/storage-error.ts`), and `packages/platform-bun/test/storage-full.test.ts` exists.
- `SystemStatus.limits` is `Schema.Record(Schema.String, Schema.Int)` (`packages/runtime/src/rpc.ts:86`), so adding `binaryArtifactBytes` is wire-compatible.
- `TestPublication` is `{ tags, output, value: Schema.Json, reference }` with no `kind` (`packages/core/src/task.ts:403`). Three in-repo sites read `.value` directly: `packages/core/test/artifact-storage.test.ts:494`, `packages/core/test/occurrence.test.ts:158` and `packages/platform-bun/test/artifact-storage-modules.test.ts:52`. Other tests read only `.reference`, `.tags` or `.output`. None does a whole-record `toEqual`.
- The `ArtifactStorage` service type is a public interface with a single JSON-only generic `publish` (`packages/core/src/artifact-storage.ts`). `artifact-storage.md` documents user fakes through `Layer.succeed(ArtifactStorage, fake)` and `Effect.provideService`.
- Today `Artifact.make` rejects unknown keys with "Unsupported artifact specification option; binary outputs are not implemented". This is the old-host failure message the draft relies on.

Scratch `tsc` probes (strict, the repo's TypeScript and Effect 4.0.5) using **stand-in types, not the real SDK**:

1. A contextually typed fake `Storage.of({ publish: (_a, _v, o) => Effect.succeed(ref) })` **still compiles** against a widened conditional `publish<A extends Json | Bytes, E = never, R = never>`. A fake explicitly typed as `<A extends Json>(a: A, v: A["schema"]["Type"], …)` **fails** with "Type 'Bytes' is not assignable to 'Json'". With stream input, the widened call inferred the source error `"boom"` into the result.
2. A discriminated union `{kind:"json"; value} | {kind:"bytes"; bytes}` makes `publications[0]?.value` a **compile error** (TS2339). Adding `value?: never` to the bytes variant makes the same expression compile as `unknown | undefined`.

Not done: I did not run the repository suite or re-verify the 209-test claim. No binary code exists to test. During probing I briefly copied a probe file into `packages/core/test/`. I removed it immediately without compiling or running it. `git status` shows no residue.

## Must fix before presentation

### B1. Backup is described as mutating and as non-mutating

"Binary installation recovery" says: "Restart **and offline backup preparation** recover recorded installation work under exclusive ownership before inventory". Recovery unlinks blobs and staging files. "Storage and backup limits" requires "an honest backup-budget failure **without mutation of the source repository**". `backup-restore.md` presents backup as a verified copy. The retention contract deliberately avoids backup-time cleanup: backup copies intents, and "the new requirement is safe, idempotent pending-intent recovery after restore".

An operator who runs `effectory backup` to protect a damaged repository should never find that backup deleted files first.

**Correction (minimal):** delete "and offline backup preparation". Backup copies installation intents and staging evidence as SQLite and file state, like reclamation intents. Daemon startup recovers them in both the source and the restored repository. Add a proof: back up a repository with an unresolved installation intent, restore it, start it, and verify that the intent resolves once in the restore and the source repository is unchanged by the backup.

### B2. `pendingBytes` and apply success semantics silently amend the approved retention contract

The draft says apply "returns its normal receipt with nonzero `pendingBytes` rather than treating an active reader as an I/O error". Today any pending cleanup after `resumeReclamation` makes apply **fail** with `Unavailable`. The approved definition of `pendingBytes` covers only I/O errors and interruptions. So a successful apply can now mean "content not yet freed". A script that treats exit 0 as "space reclaimed" would be misled. The draft says to "test this observable change" but does not flag it as a change to a user-approved contract.

**Correction:**

- **USER DECISION:** present this as an amendment to the approved retention contract, and update its `pendingBytes` definition.
- Contract text: "A cleanup job blocked only by an active download or writer lease stays pending and does not fail apply. Apply returns its receipt with `pendingBytes > 0`. Any other cleanup failure still fails `Unavailable` with the current counts message. If both occur, the failure wins."
- CLI: when a successful receipt has `pendingBytes > 0`, print to stderr: "`<n>` bytes are held by active downloads and will be removed when they finish; re-run `lake reclaim apply <planId>` to confirm." Keep the JSON receipt unchanged; no new field is needed.
- State that `reclaimableBlobBytes` in a plan does not account for active leases.

### B3. The fixed 1 GiB backup cap becomes a dead end for binary repositories

The draft says backup "retains its existing limits" and that operators "must preview/apply retention before backup when needed". For a JSON repository that is mild. With bytes, about 64 retained 16 MiB artifacts make the repository un-backupable. The only documented remedy is to **delete retained data in order to take a backup**, which inverts the purpose of backup. The cap is not configurable today, and restore re-checks it.

**Correction:**

- **USER DECISION:** offer three options.
  - (a) Accept and document: "repositories whose retained content exceeds 1 GiB cannot use `effectory backup`; stop the daemon and copy the repository with filesystem tools, or reclaim first."
  - (b) A separate, explicitly approved backup-limit API, which needs symmetric restore acceptance and version-skew rules.
  - (c) A smaller per-artifact cap.

  The reviewer recommends (a) for this slice, with the documented offline-copy procedure. That procedure needs its own short verification before it is promised.

- Fix the wording in `backup-restore.md` from "Defaults cap" to "Backup caps", because the values are fixed.

## Should fix (contract text, no new API)

### S1. Widening the `ArtifactStorage` service type affects documented user fakes

Probe 1 shows two effects. Existing contextually typed fakes keep compiling, but they now **silently accept bytes publications without consuming the stream**: source errors, requirements and finalizers never run. Explicitly typed JSON-only fakes stop compiling. `artifact-storage.md` documents fakes as a supported path.

**Correction:** add a compatibility line under the consumer surface, and add a fake example that branches on `artifact.kind` and drains bytes with `Stream.runForEach` or `Stream.runDrain`. Mark this as part of the public type change presented to the user.

### S2. Task.test publication union: offer the non-breaking variant

The draft's union is a confirmed compile break for `.value` reads (probe 2; three in-repo sites, plus unknown external tests). A bytes variant carrying `value?: never` keeps those reads compiling, and narrowing on `kind` still works. Adding `kind: "json"` to JSON records at runtime still changes whole-record `toEqual` assertions in external tests; none exist in the repo.

**USER DECISION:** strict union (breaking) or union with `value?: never` (source-compatible). The reviewer recommends the latter. Either way, show a narrowing example:

```ts
const [p] = result.publications;
if (p?.kind !== "bytes") throw new Error("expected bytes");
expect(p.byteLength).toBe(3);
expect(p.sha256).toBe(expectedSha);
```

### S3. Practical recovery from a full disk without the gate

Removing the 512 MiB gate is sound. It was never approved, it could block healthy large JSON repositories, and reclamation now exists. The reviewer agrees, but this is a **USER DECISION**. Without the gate, the operator's escape hatch is `lake reclaim plan/apply`, and apply itself writes SQLite rows (tombstones, intents, receipt, epoch). On a truly full disk it can itself fail with `StorageFull`.

**Correction:**

- Add a proof: a byte publication hits `ENOSPC`, its staging file is removed, and a subsequent `reclaim plan/apply` succeeds.
- Add an operator sentence: "If reclamation itself fails `StorageFull`, free space outside the repository first; reclamation needs a small amount of free space for metadata."
- State that four concurrent writers can hold up to 64 MiB of staging that is released on failure.

### S4. Admission waits are unspecified to consumers

- Publication: does the fifth concurrent byte publication wait for a permit or fail? From "acquire a permit before opening a writer", the reviewer infers that it waits. State that it waits, and that waiting counts against the task deadline.
- Download: the draft says "a fifth download cannot escape admission" but not whether it queues or fails, or with which code.

**Correction:** specify both. The reviewer suggests that publications wait and that a fifth download fails fast with `LimitExceeded` ("4 downloads active; retry later"). Holding an HTTP request open while it queues behind slow readers is a worse operator experience. Both limits are part of the user-visible limit list below.

### S5. Missing complete examples

The draft has one file-stream example. Before presentation, add short, complete versions of:

1. A finite `Uint8Array` or CSV publication with `contentType: "text/csv"` and `Stream.encodeText`, showing that zero bytes are valid.
2. The Task.test narrowing shown in S2.
3. A fake `ArtifactStorage` that handles both kinds (S1).
4. An operator walkthrough: `effectory run outputs <runId>` → take `artifactId`/`version` from the reference → `effectory lake download <artifactId> --version <n> --output ./release.bin` → `lake reclaim plan --schema release/file --older-than "30 days"` → `apply`, including the `pendingBytes` note (B2).

In the existing example, keep the cause: `Stream.mapError((error) => new ArchiveFailed({ message: error.message }))`. As written, the message drops the path and the reason.

### S6. Wording that will confuse authors

- "Changed bytes under the same publication key fail `PublicationConflict`" sits next to an example that **intentionally** reuses the key `"release"` across runs, where `maxVersions: 3` applies. Say "within one invocation, including its retries; a later run publishes a new version of the same identity."
- The MIME grammar rejects parameters, so the common `text/csv; charset=utf-8` fails. Keep the strictness, but require a diagnostic that says "parameters are not supported; use `text/csv`" (**USER DECISION**: list it with the limits).
- An old CLI receiving `lake get` guidance that names `lake download` should be told to upgrade: "(requires an Effectory CLI with `lake.bytes.v1`)".

## Confirmed as coherent (no change requested)

- `Artifact.make({ kind: "bytes", contentType, retention })` with `Artifact.Artifact` kept as the JSON shape, and one `storage.publish` accepting `Uint8Array | Stream<Uint8Array, E, R>` with `E`/`R` preserved (stand-in inference confirmed in probe 1).
- Retention reused unchanged for bytes; exact-version download with no latest fallback; hard-link install with `Conflict`/`Unavailable`; `lake get` refusing bytes from metadata.
- Active downloads pin bytes through a scoped lease, while held references do not. This is honest and consistent with the retention contract's cross-run limitation. The download that leased first completes; new reads get `NotFound`.
- Recorded installation recovery, not a general orphan sweep, consistent with the retention contract's deferral.
- JSON fingerprints unchanged byte-for-byte; optional wire keys normalized at read edges; `limits.binaryArtifactBytes` wire-compatible.

## Limits and choices to present to the user explicitly

| Item | Status | Reviewer view |
| --- | --- | --- |
| 16 MiB per binary artifact | Proposed, never user-approved | Coherent; present as a real limit for release archives |
| No total quota; 512 MiB gate removed | Changes an earlier unapproved proposal | Agree, with the S3 recovery proof |
| 1 GiB fixed backup cap with bytes | Presented as "unchanged" | B3: choose (a), (b) or (c) |
| `pendingBytes` success on lease wait | Amends an approved contract | B2: needs explicit approval |
| Task.test record union | Breaking as drafted | S2: prefer `value?: never` |
| `ArtifactStorage` type widening | Unstated | S1: affects fakes |
| 4 writers (wait) / 4 downloads (fail?) | Behavior unspecified | S4 |
| NDJSON RPC vs raw HTTP transport | Open | Unchanged from round 2; RPC is acceptable |
| MIME without parameters | Proposed | S6 |

## Recommendation

Apply B1 (delete one clause, add one proof), the B2/B3 text and decision framing, and S1–S6 (wording, examples and two behavior statements). Then present the draft with the table above. Another consumer round is not required for these edits. A separate Claude Effect review of revision 6 is still outstanding per the user's rule and is not substituted by this review.
