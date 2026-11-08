# Binary artifacts — consumer re-check, round 4 (revision 7)

Reviewer: Claude consumer review (developer/operator POV). Scope: a **narrow re-check**, not a new design round. It covers the revision-7 changes to `docs/binary-artifacts-api-draft.md`:

- the POSIX read/reclamation model;
- non-mutating backup refusal and the conservative raw-copy rule;
- offline-copy evidence;
- explicit `Metadata`/`Bytes` frames;
- whether the round-3 consumer corrections are represented.

Settled DI, transport and constructor choices are not reopened. The draft was frozen during this review.

**Reviewer approval only permits presentation. It is not user approval and does not authorize binary implementation.** A separate Claude Effect re-check of revision 7 is still required by the user's rule; this review does not substitute for it.

## Verdict: APPROVED for presentation after four small text corrections (R1–R4)

The revised recommendations are understandable and, with R1–R3, recoverable by an operator who has only the draft. The POSIX model is simpler for consumers than revision 6. Apply keeps its approved success and failure meaning, there is no new receipt field, and a script that treats exit 0 as "versions tombstoned and files unlinked" stays correct. The one consumer-visible surprise, disk blocks freed only on descriptor close, is stated in bold (line 225) and repeated in the operator path (line 288).

All round-3 consumer corrections are represented (table below). No material public contract is missing, and I found no incorrect claim. The gaps are recovery instructions an operator needs and one type-signature trap. **No further consumer round is needed** if R1–R4 are applied as written. Re-check only if the parent changes the backup or recovery behavior itself rather than adding these sentences.

## Corrections

### R1. Say how an operator releases blocks and permits held by a stalled download (fix before presentation)

Line 247 states writer starvation, but the download side has no matching sentence. With no server idle timeout:

- a stalled or abandoned client keeps its descriptor open, and with it the disk blocks of a reclaimed version, indefinitely;
- four such clients make every further download fail `LimitExceeded`.

An operator who sees `reclaimedBytes > 0` but no change in `df` needs the remedy.

Add after line 225 (and one clause at line 288):

> A stalled or abandoned download holds its descriptor, and any reclaimed blocks, until the client disconnects or the daemon stops. Four stalled downloads make new downloads fail `LimitExceeded` until then. Stopping the daemon interrupts the downloads and closes their descriptors. No download idle timeout is added in this slice.

If the parent prefers an idle timeout, that is a new behavior and would need a re-check. The sentence above needs none.

### R2. Make the "start then stop the daemon" backup remedy deterministic (fix before presentation)

Line 241 tells the operator to start and then stop the daemon to finish recovery. Line 239 says recovery runs "with bounded batches". The draft does not say:

- whether all recorded installation work is resolved before `daemon start` reports ready;
- what happens if startup recovery itself fails.

Without that, an operator cannot tell when it is safe to stop, and a persistent cleanup I/O error leaves backup refused with no stated way out.

Replace the relevant sentences in line 241 with:

> Startup resolves all recorded installation intents and abandoned binary staging files, in bounded batches, before `effectory daemon start` reports ready. The Conflict message names `effectory daemon start` followed by `effectory daemon stop`. If startup recovery fails, the daemon does not start and reports the cause, and backup stays refused. Fix the cause, for example permissions or free space, and retry. Otherwise, use the offline filesystem copy below, whose restored recovery applies the conservative rule.

If the daemon is meant to start in a degraded state instead, state that. Either choice is acceptable; leaving it unstated is not.

### R3. Write the offline-copy procedure as operator steps, not only as evidence (fix before presentation)

The backup recommendation (lines 253 and 333) is to "document that procedure". The only description is the evidence paragraph at line 337. I read the probe script (`/tmp/effectory-offline-copy-proof.mts`) and its log. The probe:

- writes `effectory.snapshot-incomplete` into the destination first, so the daemon refuses to start on a half-finished copy (`daemon.ts`, snapshot marker check);
- excludes exactly the paths that builtin backup excludes (`backup-restore.md`, line 17);
- removes the marker only after inventory verification.

Those are the safety-relevant steps, and the draft does not tell operators about them. Add a short block before "Offline-copy feasibility evidence":

```sh
effectory daemon start && effectory daemon stop   # finish recorded installation work
mkdir -m 700 /path/copy && printf 'Manual copy incomplete\n' > /path/copy/effectory.snapshot-incomplete
rsync -aS --exclude=.git --exclude=node_modules \
  --exclude=/.effectory/daemon.json --exclude=/.effectory/daemon.json.tmp \
  --exclude=/.effectory/daemon.log --exclude='/.effectory/state.sqlite.owner*' \
  --exclude=/.effectory/state.sqlite-shm --exclude=/effectory.snapshot.json \
  /path/repo/ /path/copy/
# Verify SHA-256 and length of every copied file against the source, then:
rm /path/copy/effectory.snapshot-incomplete
# Reinstall application dependencies from the lockfile before deploying new revisions.
```

Follow it with one sentence: "This is a privileged, unencrypted copy that includes credentials, like builtin backup; verification is the operator's responsibility."

Optional: suggest `rsync -aHS` (add `-H`). With the start/stop step first, no installation work remains, so hard-link identity rarely matters. `-H` still avoids double-counting a staging file and its blob if a crash left both.

The evidence paragraph is accurate. It says "sparse", it says it validates JSON/runtime state only, and it says it is not proof of a binary installation implementation. The script and log exist only in `/tmp`. They are acceptable as scratch evidence for presentation, not as durable proof.

### R4. Name the `NoInfer` trap in the conditional signature (should fix; one sentence in line 77 or the proofs list)

Today the JSON service signature is `value: NoInfer<A["schema"]["Type"]>` (`packages/core/src/artifact-storage.ts`). If the widened conditional keeps `NoInfer` around the whole value type, stream `E`/`R` are no longer inferred. I probed this: a `Stream<Uint8Array, "boom">` argument was **rejected** ("Type '"boom"' is not assignable to type 'never'"), because `E` fell back to its `never` default. Without `NoInfer` on the bytes branch, the same call inferred `"boom" | TaskRuntimeError`.

Add: "`NoInfer` may guard the JSON value branch only; the bytes branch must infer `E` and `R` from the value." Also add a proof bullet: "a failing stream source infers its error type through `storage.publish`."

## Round-3 consumer corrections: represented?

| Round-3 item | Revision-7 location | Status |
| --- | --- | --- |
| 16 MiB cap; no quota; 512 MiB gate removed as a user decision | Lines 87, 247–251, 330 | Represented. The cap, the four writers, the reversal of an earlier proposal and the configurable-quota alternative are all stated. |
| Basic `.value` reads via `value?: never` | Line 91 | Represented, including the note that whole-record equality changes and that JSON-requiring code must narrow. |
| Fake compatibility and consuming generic fake | Lines 144–203 | Represented. Probe (below): the fake compiles, drains, and preserves the source error at runtime. |
| Example cause preserved | Lines 64–66 | Represented. `error.message` on Effect 4.0.5 `SystemError` is `<Tag>: <module>.<method> (<path>): <description>` (`PlatformError.ts:132–136`), so path and reason survive. |
| Wait/fail concurrency | Lines 247, 269 | Represented. Publication waits within the task deadline; the fifth download fails fast with `LimitExceeded`. The download-side recovery sentence is R1. |
| Full-disk caveat and ENOSPC proof | Lines 243, 249 | Represented, including the nested `PlatformError` cause trap. |
| Operator example | Lines 277–288 | Represented and checked against `packages/cli/src/main.ts`: positional `run outputs <id>`, `lake reclaim plan --schema --older-than` (`Duration.fromInput`), positional `apply <planId>`, root-shared `--json`. `lake download <id> --version <n>` matches the existing `lake get <id> --version` shape. |
| MIME parameters diagnostic | Lines 142, 257 | Represented. |
| Old-CLI guidance on `lake get` of bytes | Line 257 | Represented ("requires an upgraded CLI supporting lake.bytes.v1"). |
| `pendingBytes` amendment (B2) | Lines 223, 288, 332 | Resolved by not amending it. Leases remain only as the named alternative. |
| Backup non-mutation (B1) | Line 241 | Resolved by refusal; see R2. |
| 1 GiB cap dead end (B3) | Lines 253, 333, 337 | Resolved by option (a) plus evidence; see R3. |

## New revision-7 surfaces: consumer reading

- **POSIX reclamation (lines 219–227).** The model is clear. Whichever of the reclaim commit and the download open happens first wins, and the outcome is binary: `NotFound`, or a complete byte-identical download. `reclaimedBytes` keeps its approved meaning, and the blocks-on-close caveat is visible. The Windows assumption is stated. With R1, an operator can explain the gap between `reclaimedBytes` and `df` and recover from it.
- **Backup refusal (line 241).** It is non-mutating, checked before inventory, and leaves normal reclamation intents copyable. The probe confirms that a copied pending reclamation resolves in the copy only. With R2 the remedy is actionable.
- **Raw-copy conservative rule (line 237).** Delete only the owned staging file, preserve the unproven blob, and never block startup or backup. A restored copy can therefore leave a permanent unreferenced blob. The draft states this honestly as outside this slice's GC scope, which is acceptable.
- **Response frames (line 261).** `Metadata` then `Bytes`, with LakeDownload bytes-only and JSON rejected with `lake get` guidance. The client rules (no missing or repeated metadata, no bytes before metadata, final length/digest verification) are a complete consumer contract. The required `ArtifactRecord` content metadata (kind, contentType, plus the existing digest and size) gives the client what it needs to verify. No missing public field found.
- **Minor, optional.** Line 275 gates `lake download` on `lake.bytes.v1`. Consider naming the message for a new CLI against an old daemon, for example "the daemon does not support lake.bytes.v1; upgrade and restart it". This is not material.
- **Housekeeping.** Once the Effect and consumer re-checks are recorded, the status line (line 3) and line 325 still say a re-check is required before presentation. The parent should update both when unfreezing.

## Evidence: tested vs inferred

**Tested.** Scratch directory outside the checkout: `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/6d81980a-e6c1-4820-9953-acfbaec198b6/scratchpad/r4/fake.ts`, using the repo's TypeScript and Effect 4.0.5.

The probe used stand-in `Json`/`Bytes` artifact types with the repo's real `referenceSchema` and `TaskRuntimeError`, a `Context.Service` with the widened conditional `publish`, and the draft's `fakePublish` verbatim (modulo stand-in imports):

- `tsc` strict with `exactOptionalPropertyTypes`: exit 0.
- The `Layer.succeed(..., Service.of({ publish: fakePublish }))` assignment compiles.
- A failing stream inferred `"boom" | TaskRuntimeError` and failed at runtime with `Fail("boom")`, so the stream was drained.
- A finite `Uint8Array` inferred `TaskRuntimeError` only, and decoded a valid synthetic reference.
- With `NoInfer` around the conditional value, the stream call was rejected (R4).

**Read, not executed.**

- The CLI command shapes (`main.ts`).
- The `PlatformError` message format.
- The daemon's incomplete-snapshot refusal.
- The backup exclusions and offline-only ownership (`backup.ts`, `backup-restore.md`).
- The offline-copy probe script and its `passed: true` log.

I did not re-run that probe, and I did not run the repository suite. No binary code exists.

**Inferred.** That startup recovery completes before `daemon start` reports ready, and that a stalled reader holds its descriptor indefinitely. The draft does not state either; R1 and R2 make them explicit.

No files in the checkout were changed apart from this review.

## Recommendation

Apply R1–R3 (three short additions) and R4 (one sentence plus a proof bullet). Then present revision 7 with its decision list (lines 327–333). Add these consumer-visible points to that list:

- reclaimed blocks are freed on descriptor close, and stalled downloads hold them (R1);
- backup refusal recovery is start then stop, with the offline copy as the fallback (R2);
- the documented offline-copy procedure (R3).

No further consumer review is needed unless the parent changes behavior rather than wording. The user still decides every listed choice.
