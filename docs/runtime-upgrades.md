# Runtime upgrades

Runtime upgrades are separate from dependency-pin updates. Bare `effectory upgrade` still updates the project's SDK and Effect pins; it does not migrate runtime state.

The runtime keeps build hashes for provenance and retained-bundle integrity. A separately tested execution/storage transition determines whether another host can execute those bundles. Matching package versions or execution labels is insufficient. There is no force option or manifest-rewriting shortcut.

## Supported transitions

The executable proof matrix passed for these exact transitions. Evidence for each platform is recorded in [the current certification record](runtime-effect-4.1-certification.json):

| Predecessor | Source storage | Target | Platform |
| --- | --- | --- | --- |
| Effectory v0.1.0 release, build `a8fa9264e18ea79615f9d7934ec510b8110d39ff305a9a2d8980aa1840baa7c9`, Effect 4.0.5; fresh repository | 1 | Execution contract `effectory.execution/v1`, storage 3, Effect 4.1.2 | Darwin ARM64 |
| Effectory v0.1.0 release, build `a8fa9264e18ea79615f9d7934ec510b8110d39ff305a9a2d8980aa1840baa7c9`, Effect 4.0.5; fresh repository | 1 | Execution contract `effectory.execution/v1`, storage 3, Effect 4.1.2 | Linux x64 |

The target is build `1d84112ffa3cf9cbd335ee1ac8853f528f5af37b8b1d74939c4d8c300692fdc8`. Each edge was proved with the published v0.1.0 executable for its platform. Repositories that v0.1.0 itself upgraded from an earlier development build (storage 3) are not certified for this target. Earlier edges all targeted Effect 4.0.5, so they cannot match this host. Their records remain historical evidence: [Effect 4.0.5 disconnect certificate](runtime-http-disconnect-certification.json), [format-1-to-2 certificate](runtime-upgrade-certification.json) and [earlier storage-3 target certificate](runtime-upgrade-format2-certification.json). Other predecessor/build/source-format combinations and platforms remain unsupported until separately tested and listed.

Effect 4.0.6 changed how a failure combines with a defect: a cleanup defect now makes a declared task failure fatal. Retained runs executing on this host follow that rule; see [task cleanup cause evidence](task-cleanup-cause-evidence.md).

A fresh repository created by the previous host has no upgrade marker and uses source storage 1. A repository that already passed through runtime upgrade uses its recorded storage format. Each state needs its own tested edge; a build hash alone does not determine the stored format.

## Plan and apply offline

1. Stop the daemon with the compatible predecessor. These commands never stop or start it for you.
2. Use the target executable to run `effectory upgrade plan --repository PATH --json`.
3. Inspect the returned plan, including `status`, `blockers`, retained revision dispositions, work counts, migrations and `recoveryCopy`.
4. Apply a Ready plan with `effectory upgrade apply PLAN_ID --repository PATH --json`.
5. Read progress or its receipt with `effectory upgrade inspect PLAN_ID --repository PATH --json`.
6. After phase `Complete`, start the target daemon normally.

A plan is valid for 15 minutes after inspection finishes. It binds captured repository contents and dependency manifests/lockfiles. Unaccepted stale plans must be regenerated. Planning reads private database copies and does not import application code or run migrations; it writes a bounded preview record on success.

Apply independently revalidates the plan, creates or verifies its recovery image, then records acceptance before changing formats. An interrupted accepted apply must be retried with the same plan ID and accepting executable on the same platform. A completed retry returns the stored receipt before expiry or recovery-copy freshness checks. The active transition blocks ordinary startup and writers until completion or a preserving abort.

From storage 1, migration wraps credentials and the extension lock and advances the vault format fence. From storage 2 or 3, it transfers the existing envelope owners and preserves the populated vault; an empty vault sentinel is replaced atomically. All paths publish repository storage format 3. A storage-3 source still needs ownership transfer even though its storage number stays the same. This marker makes the actual format-2 predecessor refuse offline writes that an owner change alone did not prevent. The vault database itself remains version 2. Native activity results, run rows, pinned revisions, historical receipts and bundle bytes stay unchanged. New application revisions record their execution contract. Existing compatible runs retain their accepted revision, request-key receipts, waits, timers, recovery permissions, reports and artifact protection. Host replacement alone does not reset schedule generations or watermarks.

If an old writer changes data during partial fencing, apply aborts by reversing only its own format fields. It preserves the intervening write; it never restores a stale image automatically over it. For a format-2 or format-3 source, abort restores the previous envelope owner, keeping changed logical values. Current offline vault, extension and run-reclamation entry points also check the accepting build before opening storage. Inspect `abortReason` and create a fresh plan after resolving the source change.

An active repository owner or stale plan returns Conflict (exit 5). An unsupported transition returns RevisionUnavailable (exit 5). Invalid arguments exit 2; unavailable storage exits 3. An Unsupported plan is not permission to apply it.

## Recovery image and rollback

Apply places a private recovery directory outside the repository. Its `manifest.json` records the plan, source and each captured file's size, SHA-256 and executable flag, plus empty directories. The acceptance receipt records the manifest digest. The complete image is `recoveryCopy/repository`.

The copy bounds are 32 GiB per file, 128 GiB total, 50,000 entries and 16 MiB of manifest metadata. The builtin backup command retains its separate 128 MiB per-file and 1 GiB total limits. Recovery copying preserves database WAL contents. It excludes dependency installations, Git metadata, SHM/ownership files, daemon bookkeeping and temporary upgrade records. External vault keys remain external.

Rollback means restoring the verified pre-upgrade image and using its compatible predecessor executable:

1. Stop every daemon using the upgraded repository or recovery image. Preserve the upgraded directory for investigation.
2. Verify `manifest.json` against the acceptance receipt's `recoveryDigest`, then verify every listed file's byte count and SHA-256. Reject an image with `effectory.snapshot-incomplete`, unexpected paths, symlinks or mismatched entries. Keep the original verified image unchanged.
3. Copy the listed files and directories into a fresh destination. Keep an `effectory.snapshot-incomplete` marker in that destination until its files have independently passed the same checks. Preserve executable flags and private permissions; copy and flush data before removing the marker.
4. Make the original external vault keys available separately. Reinstall dependencies from the captured manifests/lockfiles before building new application revisions.
5. Start the compatible predecessor against the restored destination and inspect the retained runs before continuing work.

The upgrade image is not the builtin `effectory.snapshot.json` backup format; do not pass its enclosing directory to `effectory restore`. The executable proof suite verifies the recovery-copy component before restoration and then resumes a real waiting predecessor run. A restored image also restores its earlier deduplication state: reconcile external actions performed after the snapshot before resuming work. There is no reverse migration that preserves writes made after the upgrade.

## Breaking execution changes and archives

A breaking transition refuses while affected runs, reports, recovery continuations or scheduled admissions remain. Finish or explicitly cancel them with the compatible host; cancellation may itself produce report work that must finish. The upgrade never silently drops that work.

After an approved breaking transition, retained data can be read without importing incompatible bundles. Historical operations that require those bundles, such as a pinned task description, vault-provider access or report regeneration, return RevisionUnavailable. Report retry checks executable compatibility before creating a new generation; an already accepted retry still returns its receipt. Bundle pruning is separate and is not performed by upgrade.

Loaded revision resources belong to scoped borrowers. The active revision and in-flight tasks/provider operations keep their Layers alive; activation does not close an old Layer until its remaining users and cleanup have finished.

## Maintaining a release edge

Build the target with `bun scripts/build-binary.ts`. Preserve the actual predecessor executable and its digest. Run the [executable proof script](../scripts/verify-runtime-upgrade.ts) with explicit old/new binaries and a new evidence directory, together with the required full checks. The optional deliberately incompatible fixture tests breaking refusal and archived inspection; it is not a shipping execution contract.

```sh
bun scripts/verify-runtime-upgrade.ts \
  --previous /absolute/path/to/predecessor \
  --target /absolute/path/to/target \
  --breaking /absolute/path/to/incompatible-test-fixture \
  --output /absolute/path/to/new-evidence-directory
```

For a previously upgraded predecessor (storage 2 or 3), also pass `--bootstrap /absolute/path/to/legacy-predecessor`. This creates the predecessor storage through a real earlier upgrade and leaves legacy work pending while the intermediate host admits new work. Rollback then proves both retained revisions still execute under that intermediate predecessor.

The script creates synthetic temporary repositories and retains them for inspection. It checks waiting/manual reuse and rollback, timer/retry/manual recovery, reports and retention protection, schedule state, vault keys, and predecessor offline-writer refusal. Component tests additionally kill processes at copy, journal, fence, migration and abort boundaries. Every advertised transition must be verified on its actual release executable; earlier candidate or single-build tests are insufficient.
