# Binary artifacts — consumer review, round 2

Reviewer: Claude, as the consumer-DX review subagent. Subject: revision 3 of [binary-artifacts-api-draft.md](binary-artifacts-api-draft.md), checked against [consumer round 1](binary-artifacts-review-consumer-round1.md) and [Effect round 1](binary-artifacts-review-effect-round1.md). This file is the only one I wrote. I made no source edits and no commits, and I started no subagents. Typed run tags and SDK work were not touched. **Reviewer approval is not user approval.** No binary API has been approved or implemented.

## Verdict

**REQUEST CHANGES before presenting.** All round-1 consumer blockers are resolved:

- B1: the command is `lake download`.
- B2: install uses hard-link then unlink, with the existing `Conflict` and `Unavailable` codes.
- B3: a kind/MIME descriptor detects drift per schema version.
- B4: the example maps a FileSystem source.
- B5: test publication records are discriminated by kind.

The should-fixes (MIME grammar, describe outputs, discovery path, skew warning, incremental dedupe, `lake get` metadata check) are also in. The Effect round-1 structure is in place too: a framed content endpoint, a separate `publishBytes` hook, publication supervision and a quota.

Three of the new choices are still not coherent enough to present:

1. **The shared 512 MiB quota changes existing JSON publication, and once it is full there is no way to recover.**
2. **The publication supervisor does not say what happens when the caller of an awaited publish is interrupted.** A probe shows that the naive fork-and-join lets a publication commit after its caller has already failed.
3. **The 1 MiB inline limit and whole-array snapshot add a public limit that is easy to bypass and buy nothing.** Meanwhile the per-slice rule leaves digest/content agreement up to producer behaviour.

Each has a small fix below. After those fixes, the remaining items are should-fix wording and simplifications, and I would expect to approve the draft for presentation.

## Evidence labels

- **Source fact:** read in this checkout or in `node_modules/effect` 4.0.5.
- **Tested:** a scratch probe in the session scratchpad, run with this checkout's Effect 4.0.5 through a symlinked `node_modules`. Disclosure: my first run of the join probe briefly copied the file into the checkout root as `.probe-join.mts` and then deleted it. I re-ran it from the scratchpad with identical output. No checkout file remains.
- **Parent-reported:** the BunFileSystem bundling and missing-file probe recorded in the draft. I did not re-run it.
- **Untested proposal:** everything else in the draft and in this review.

Source facts used below:

- `OperationError` already has `Conflict`, `Unavailable`, `LimitExceeded`, `StorageFull` and `ContentUnavailable` (`packages/runtime/src/protocol.ts:115–128`).
- `storageError` maps `ENOSPC`/`EDQUOT`/`SQLITE_FULL` to `StorageFull` with the message "free space before retrying the original request" (`storage-error.ts:17–25`). `host-store.ts:259` counts each `StorageFull` as a storage failure, and `doctor.ts:51–56` turns that into an Error-severity finding.
- A `TaskRuntimeError("LimitExceeded")` passes through as `OperationError("LimitExceeded")` (`storage-error.ts:5–10`).
- `limits` already advertises `bundleBytes` and `extensionArchiveBytes` at 16 MiB, and `finalizationGraceMs: 2000` (`control-plane.ts:28–45`). A 16 MiB binary cap therefore matches existing limits.
- The backup caps are 1 GiB, 128 MiB per file and 50,000 entries (`backup.ts:34–36`). `backup-restore.md:3` says the backup is not an upgrade or migration tool.
- The daemon fetch wrapper only routes `/rpc` and `/rpc/` (`daemon.ts:170–173`), so an old daemon answers `/rpc/content` with a 404. The client only accepts the endpoint `http://127.0.0.1/.../rpc` (`client.ts:30–37`). Deriving `/rpc/content` from that endpoint is straightforward.
- `RpcSerialization.makeNdjson({ maxBufferSize })` exists in 4.0.5 (`RpcSerialization.ts:110, 150`).
- `Stream.scoped` and `Stream.unwrap` already exclude `Scope` (`Stream.ts:1704, 1738`). `Stream.runDrain`/`Channel.runDrain` do **not** exclude `Scope` from `R` (`Stream.ts:20634`, `Channel.ts:11337`).
- `Task.test` references are `test-artifact-N`/`test-digest-N`, and the fingerprint is `canonical({ tags, value })` (`task.ts:355–385`). The reference schema has `digest` but no byte length (`artifact.ts:8–16`).

## Blockers (ranked)

### B1 — The shared blob quota changes existing JSON behaviour and has no recovery path

The draft is honest that this is a new limit on JSON and needs approval. The problem is that the tradeoff is presented as a uniform rule, when in practice it turns an upgrade into a delayed outage for users who never publish bytes.

**Counterexamples (source facts plus arithmetic; untested end to end):**

1. **Existing large store.** A repository that already holds more than 512 MiB of JSON blobs is upgraded. Under "existing stores above quota … cannot add new immutable bytes", every JSON publication with new content fails on the first run. Scheduled workflows that worked yesterday stop working.
2. **JSON-only repository.** A scheduled task publishes a distinct 64 KiB JSON report every 5 minutes. 512 MiB ÷ 64 KiB = 8,192 publications, which is about **28 days**. After that, every new JSON publication in the repository fails. There is no supported reclamation command, and deleting blob files by hand corrupts the lake. In practice the only recovery is a new repository, which loses run history and provenance.
3. **Binary use.** A nightly 16 MiB archive with distinct content fills the quota in **32 days**. With the shared quota, this also blocks every JSON task in the repository.
4. **Error code.** The draft never names one. If an implementation reuses the storage path, it gets `StorageFull`. That code tells the user to "free space before retrying", which does not help, and it raises a doctor Error that means real disk exhaustion.

**Smallest coherent fix:**

- **Apply the quota only when admitting bytes publications.** Measure it against total physical blob bytes, including JSON, plus outstanding byte reservations. The JSON publication path stays exactly as it is today, including its documented, pre-existing unbounded growth.
  - This keeps the simple "count unique physical blobs once" measurement, so there is no need to track which kind owns a shared digest.
  - The sentence the user is approving becomes "binary content is never what pushes the lake past 512 MiB", rather than "your existing JSON may stop".
  - Concurrent JSON installs can push the total over by at most the number of concurrent JSON publications × 1 MiB. Say so.
- **Name the failure** as `TaskRuntimeError("LimitExceeded")`, which surfaces as `OperationError("LimitExceeded")`. The message names `lakeBlobBytes`, current usage, and the fact that this release has no reclamation. It must not be `StorageFull`. Task retry policy does not retry `TaskRuntimeError`, so a full quota fails fast.
- **Check the quota at admission as well as at install.** Reject immediately if usage is already at or over quota, before staging up to 16 MiB that will then be thrown away.
- **Present the remaining dead end as an explicit user decision:**
  - (a) Accept a bounded binary v1. About 32 distinct 16 MiB artifacts can be stored for the life of the repository until retention lands.
  - (b) Require minimal reference-aware orphan reclamation or retention before binary ships.

  The draft should not imply that (a) is a neutral default. Recommendation: (a), only with the bytes-only gate and the failure message above.

- **Update the backup paragraph.** The quota bounds only what binary adds to the backup. JSON blobs, the database, revision bundles and extension caches can still exceed 1 GiB, as they can today.

Doing this also removes a required proof ("concurrent JSON/bytes quota reservations") and the JSON over-quota compatibility case. Startup reconciliation, pending-file sweeps and orphan accounting stay.

### B2 — Interrupting the caller of an awaited publish does not interrupt the publication

The draft says that each publish "registers a child fiber with this supervisor using the caller's Effect context, then awaits it", and that closing interrupts outstanding children. It does not say what happens when the **awaiting caller** is interrupted while the attempt is still open.

**Tested.** I forked a 300 ms "commit" child into an attempt `Scope` with `Effect.forkIn`, awaited it with `Fiber.join`, and wrapped the caller in `Effect.timeout("50 millis")`. Log: `["caller exit: Failure", "child committed", "attempt closed"]`. The child committed **after its caller had already failed**.

**Consumer counterexample:**

```ts
const ref =
  yield *
  context.publish("archive", primary, { key: "release" }).pipe(
    Effect.timeout("30 seconds"),
    Effect.catchTag("TimeoutError", () =>
      context.publish("archive", fallback, { key: "release" })
    )
  );
```

The handler sees a timeout and starts the fallback under the same key. The original child is still writing and can commit first. Depending on timing, the fallback then fails with `PublicationConflict`, or the handler returns one reference while the lake records the other. `Effect.race` between two sources has the same problem. This is an in-attempt race, so close-time interruption does not catch it.

**Tested fix.** Make the awaited publish interruptible as a single unit:

```ts
Fiber.join(child).pipe(Effect.onInterrupt(() => Fiber.interrupt(child)));
```

In the same probe this logged `child interrupted` before the caller's timeout failure. A detached caller (`forkDetach`) was interrupted and awaited when the attempt scope closed.

Specify these semantics explicitly:

- "Interrupting the caller interrupts the publication and awaits its finalizers before the caller observes the interruption."
- "A publish the handler has not awaited by the time it returns is interrupted. Its artifact does not exist, and the attempt outcome is unaffected."

Add both the timeout/fallback race and the detached case to the required proofs. A simpler equivalent is also acceptable: register the caller's own fiber for the publish region instead of forking, so caller interruption is native. The fork-and-join version is the one I tested.

**Nit, same section:** a publish admitted after close is a lifecycle violation, not changed content. Reusing `PublicationConflict` for it makes the logs ambiguous. Prefer the `InvalidBoundary` code the draft already uses for the missing hook.

### B3 — The inline limit can be bypassed, the snapshot is redundant, and producer mutation can break digest/content agreement

**Counterexample (design).** `context.publish("archive", bytes2MiB, …)` fails with `LimitExceeded`. `context.publish("archive", Stream.succeed(bytes2MiB), …)` succeeds. It uses no more memory, because the caller already holds the array. A consumer learns that "wrap it in a Stream" is how to get past the limit.

The snapshot also protects nothing that the draft's own contract does not already require. The copy is taken after the permit is acquired, so it happens while the publication Effect is running. During that time the caller is already obliged to leave the array unchanged.

Meanwhile, the streamed path makes store integrity depend on producer behaviour:

- The draft hashes and writes producer-owned slices without copying them.
- A fiber that mutates a yielded buffer while the write is awaited (the draft explicitly does not promise protection against this) can produce a blob whose bytes do not match the digest that was recorded.
- That damages the content-addressed lake, not just the one publication. Later downloads would fail with `ContentUnavailable`.

**Smallest coherent fix:**

- **Drop the whole-array snapshot and `binaryInlineBytes`.** A `Uint8Array` is exactly `Stream.succeed(bytes)`, with the single 16 MiB cap and the same rule: "keep it unchanged until the publish completes."
- **Copy each ≤64 KiB slice into the writer's own fixed 64 KiB buffer, then hash and write from that buffer.** These are the 4 × 64 KiB buffers the draft already budgets. This keeps memory constant and does not double allocation, which was the Effect review's S7 concern. Producer misbehaviour can then only change _which_ bytes are published. It can never make the stored blob disagree with its digest.

The result is one fewer public limit, simpler documentation and a stronger integrity guarantee.

`Task.test` still copies, because it keeps bytes for assertions, and the harness is not the place where memory is bounded.

## Should fix before presentation

- **S1 — Do not exclude `Scope` from the publish result type.**
  - `Exclude<R, Scope.Scope>` diverges from Effect's own run functions: `Stream.runDrain` keeps `R`.
  - The draft admits it still needs a feasibility proof.
  - It is not needed for the documented source: `FileSystem.stream` has no `Scope` in `R`, and authors who do have scoped resources use `Stream.scoped`.
  - Return `Effect<Reference, E | TaskRuntimeError, R>`. In the one sentence of documentation, point authors to `Stream.scoped`. The publication still owns its internal writer Scope privately.
- **S2 — Test reference digests.**
  - A bytes `TestPublication` has a real `sha256` next to `reference.digest === "test-digest-N"`. An assertion such as `expect(pub.reference.digest).toBe(pub.sha256)` looks reasonable and fails.
  - Keeping synthetic references is right for compatibility, as both round-1 reviews said. State it in the record's documentation: "`reference` is synthetic in `Task.test`; use `sha256`/`byteLength` for content assertions."
  - Also state that the harness fingerprint for bytes is `{ sha256, contentType, tags }`, not `canonical({ tags, value })`. Otherwise conflict detection in tests is unspecified.
- **S3 — Do not advertise `binaryFrameBytes`.**
  - Authors cannot exceed it, because the runtime slices, and clients do not need it to decode.
  - The real client constraint is the NDJSON `maxBufferSize`, which is internal to the shipped client.
  - Keep the frame size internal. Advertise `binaryArtifactBytes` and `lakeBlobBytes` only. After B3, that is two new limits instead of four.
- **S4 — Content endpoint: show the plain-bytes alternative to the user.**
  - The NDJSON design is coherent, and the Effect review's tested collection problem justifies a separate endpoint. Its cost is visible, though: Base64 inflation of about 33%, a 128 KiB line-budget proof, a 16 KiB request envelope, batch rejection, and middleware bypass.
  - A raw `POST /rpc/content` response with `content-length` and a digest header, streamed with pull backpressure, would avoid all of the framing proofs:
    - errors before the body use the existing `OperationError` JSON body;
    - an error mid-body aborts the connection;
    - the CLI verifies length and digest, as it does already.
  - Neither version changes the consumer CLI. Present the plain-bytes alternative as the smaller transport option with its tradeoff: no typed RPC client for content, and errors after headers are a connection abort rather than a typed failure. This is untested. It is not a blocker.
- **S5 — Detached and JSON behaviour change.** Supervising JSON publications too (correctly) changes today's behaviour: a forked JSON publish that is still running after the handler returns will now be interrupted instead of committing. Say so in the compatibility paragraph so existing users can find it.

## Assessment of the specific new choices

| Choice | Assessment |
| --- | --- |
| 16 MiB streamed cap | Coherent. It matches the existing `bundleBytes`/`extensionArchiveBytes`, stays well under the 128 MiB per-file backup cap, and bounds staging to 64 MiB. It is a real limit for release archives, so present it as one. |
| 1 MiB inline cap | Remove it (B3). |
| Shared 512 MiB blob quota | Not coherent as a shared rule. Make it a bytes-only admission gate against total blobs, with `LimitExceeded`, and put the dead end to the user explicitly (B1). |
| No reclamation command | Honest, but it has to sit next to the timelines (about 32 nightly archives) so the user can choose (a) or (b). |
| 1 GiB backup caveat | Honest. After B1, reword it: the quota bounds what binary adds, not the whole backup. |
| Scope-owned publications incl. detached | The direction and Layer ordering are right. Caller-interruption semantics are missing (B2). Rename the post-close error (nit). |
| Separate NDJSON endpoint | Sound and justified by tested evidence. Offer the raw-bytes option (S4). Old daemons answer 404, and the client gates on `lake.bytes.v1` before creating a temp file, so compatibility holds. |
| Synthetic harness references + real digest/length | Right for compatibility. Document the mismatch and the bytes fingerprint (S2). |
| Error/requirement inference | Right, apart from the `Scope` exclusion (S1). |

## Required-proof changes

- **Add:**
  - a timeout or race around an awaited publish, showing that no commit happens after caller interruption (B2);
  - a JSON-only store above `lakeBlobBytes` that keeps publishing JSON while bytes fail with `LimitExceeded` and a message naming the quota (B1);
  - a producer that mutates a yielded buffer during a write, showing that the stored blob still matches its recorded digest (B3).
- **Remove:** finite-input rejection above 1 MiB, and concurrent JSON/bytes quota reservations. Keep concurrent bytes reservations.

## What holds up (no change requested)

- One `Artifact.make` with `kind: "bytes"`, and `Artifact.Artifact` kept as the JSON shape with a separate `Artifact.Bytes`.
- `context.publish` overloads with typed source errors that must be mapped to declared errors.
- Explicit `.provide(BunFileSystem.layer)` with no implicit host FileSystem (parent-reported probe).
- Hard-link install with `Conflict`/`Unavailable`, and `lake get` refusing bytes based on metadata.
- The descriptor that prevents drift, and optional wire/persisted keys normalised at read edges.
- `task describe` outputs, the documented discovery path, and an honest Swamp gap list.

None of this has been implemented or approved by the user.
