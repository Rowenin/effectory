# Binary artifacts — Claude Effect review, round 3 (draft revision 6)

Reviewer: Claude (Effect/Scope/Layer and durability). Date: 2026-11-05. Subject: `docs/binary-artifacts-api-draft.md` revision 6. The draft was frozen during this review. Read: `docs/artifact-storage.md`, `docs/artifact-retention-api-draft.md`, rounds 1–2 of the Effect review, `packages/core/src/{artifact-storage,task,publication-lifetime}.ts`, `packages/platform-bun/src/{lake,lake-reclamation,lake-retention-store,daemon,backup,storage-error}.ts`, and pinned Effect 4.0.5 sources: `http/HttpEffect.ts`, `rpc/RpcServer.ts`, `PlatformError.ts`, and `@effect/platform-node-shared` `internal/utils.ts`.

**This approval is for presentation only. It is not user approval and does not authorize implementation.**

## Verdict: CONDITIONAL APPROVAL for presentation, after three text corrections (C1–C3)

Revision 6 keeps everything round 2 settled. That covers the constructor and overload shape, source E/R/Scope preservation through `lifetime.run`'s forked child, generic `never` defaults, `Stream.rechunk(1)`, the bounded route read, the separate NDJSON serialization context, SDK/host ownership and honest finalizer timing. I did not reopen those decisions. Removing the 512 MiB gate is coherent now that manual reclamation exists, and old JSON fingerprints are unaffected (see S5).

Three statements are contradicted by tests or by approved contracts. Each one is a text fix, and none changes the public authoring API:

- **C1** promises a response-body lifetime that the Effect HTTP stack cannot observe.
- **C2** silently redefines an approved receipt field.
- **C3** gives backup two incompatible jobs.

Applying C1–C3 as written below needs no full round 4. If the parent adopts the simpler reclamation design in C2 option B, the "Reclamation and live operations" and "Binary installation recovery" sections change materially. That needs a narrow re-check of those two sections only, not a full review.

## Blockers (presentation text)

### C1. "Permits held for the response-body lifetime, including slow readers" cannot be met (tested)

The draft asks for an explicit transport ownership hook and a real-socket proof that permits last through response-body consumption (lines 146 and 175). I measured this on Bun 1.4.3 with Effect 4.0.5, using `RpcServer.toHttpEffect(..., { streamBufferSize: 4 })`, `makeNdjson({ maxBufferSize: 131072 })`, `Stream.rechunk(1)`, 64 KiB frames, `HttpEffect.toWebHandler` and a real `Bun.serve` loopback socket. The client read slowly. Three lifetimes were logged: a handler-stream `acquireRelease`, a finalizer added to the HTTP request `Scope` in a route wrapper, and the legacy fetch `finally`.

| Case | Handler finalizer | Request-scope finalizer | Fetch `finally` | Client finished |
| --- | --- | --- | --- | --- |
| ~1 MiB (12 frames) | 61 ms | 63 ms | 62 ms | 829 ms; nothing had been read when all three ran |
| 16 MiB (256 frames) | 1206 ms | 1237 ms | 45 ms | 1497 ms; ~4–5 MB still unread at request-scope close |
| 16 MiB, client cancels after 5 reads | 403 ms (interrupted) | 406 ms | ~90 ms | cancelled at 265 ms |

Findings:

- Effect already provides the "transport ownership hook". `toWebHandlerWith` transfers the request Scope to the body stream (`scopeTransferToStream`), and it closes when the body stream exits or aborts. A route-level `Effect.gen` that takes a permit and registers `Scope.addFinalizer` on the request Scope is ordinary Effect. It needs no custom hook.
- That scope closes when the last frame is handed to Bun, not when the client consumes it. Bun and kernel socket buffering absorbed a whole ~1 MiB response, and several MB of a 16 MiB one, beyond every Effect-visible lifetime. The handler-stream and request-scope lifetimes differ by only milliseconds.
- The draft is right that the fetch `finally` is insufficient: it fires when the Response is returned.
- The maximum NDJSON line was 87,430 bytes, which reproduces round 2's ~87 KiB.

**Fix.** Replace "response-body lifetime, including slow readers" and the "explicit transport ownership hook" with a contract that can be met:

> The download admission permit is held in the HTTP request Scope from route entry until the content body stream completes, fails or is aborted. It bounds concurrent producers, file handles and Effect-side queues. It does not bound bytes already handed to Bun and kernel socket buffers, which can be several MB per download (measured on loopback).

In the required proofs, replace "permits persist through response-body consumption" with three proofs:

- A fifth concurrent request is refused while four producers are active.
- Abort releases the permit and closes the file.
- Server memory stays bounded with four slow readers.

If the digest read lease is kept (C2 option A), keep it in the **handler stream** Scope, not the request Scope. The RPC server's own finalizer interrupts handler fibers and waits on `shutdownLatch` before the services Layer, including the Lake, is released (inferred from source). The request Scope closes through Bun stream cancellation and can run after the Lake Layer has closed.

### C2. The `pendingBytes` change rewrites an approved contract; a simpler alternative exists (contract read and tested)

The approved retention contract defines pendingBytes as "durable cleanup work remains after an I/O error or interruption" (`artifact-retention-api-draft.md:78`). Revision 6 adds a third meaning: work blocked by an active reader lease. It also needs a lease-release cleanup worker, and changes to the apply receipt and the CLI. The draft calls this an "observable change" to test. It is actually a change to a user-approved contract, so it must be presented as a user decision, not as an internal choice.

There are two coherent options:

- **Option A — keep the revision-6 design.** List it under user decisions as an amendment to the retention contract. It also needs implementation notes:
  - In `resumeReclamation` (`lake-reclamation.ts`), a lease-blocked job must not set `failure`. Today any job failure turns the whole apply into an `Unavailable` error, so lease blocking needs a separate outcome.
  - The cleanup worker belongs in the lake Layer: `Effect.forkScoped` after the database `acquireRelease`, so it is interrupted before `db.close()`.
- **Option B — recommended, smaller.** Use the POSIX semantics of an open file. The reader checks retained metadata **and** calls `openSync` on the blob inside the same synchronous, non-yielding store section that `unlinkJob` already uses. After that, the reader streams from the descriptor, and an unlink cannot affect it.
  - I tested on Darwin with Bun 1.4.3: after `unlink`, both `readSync` and `createReadStream` on an already-open descriptor returned all 16,777,216 bytes intact.
  - Writers need no lease either. Keep the staging file until commit, as the draft already requires. Verify an existing blob through a descriptor opened inside a synchronous section. In the commit section:
    - if the blob path is missing (it was reclaimed meanwhile), `link(staging, blob)` again;
    - if the blob is a different inode, another publisher has installed identical content; accept it.
  - Reclamation never blocks, so pendingBytes keeps its approved meaning. No receipt change, cleanup worker, lease-release queue or new coordinator is needed: the existing synchronous store section is the coordinator. `reclaimedBytes` stays honest under its approved definition ("files actually unlinked"). Add one sentence: "disk space for a version being downloaded is freed when that download finishes."
  - Cost: this relies on POSIX unlink-while-open. Windows is not built (`binary-distribution.md:100`). State the assumption, and revisit it if Windows targets are added.

If the draft keeps option A without user approval of the amendment, it must not be presented as compatible with the approved retention contract.

### C3. The backup claims contradict each other, and filesystem identity does not survive backup (tested and from source)

- The draft says "offline backup preparation recover[s] recorded installation work … before inventory". It also requires an "honest backup-budget failure without mutation of the source repository". Recovery is a mutation.
- Today `repositorySnapshot` (`backup.ts`) is a pure offline copy under exclusive ownership. It never opens the lake or runs recovery, so this would be new behavior.
- The draft identifies the "blob installed from this staging file" by filesystem identity. That identity does not survive backup. I tested this: `link(staging, blob)` gives the same `(dev, ino)` with `nlink = 2`, and after `copyFile` of both files the copies have different inodes. A restored unresolved intent can therefore never prove ownership again, and the blob is preserved forever.
- While an intent is unresolved, backup also copies the content twice (staging plus blob), which counts against the 1 GiB budget twice.

**Fix.** Choose one option and state it:

- **(a) Recommended:** backup refuses with `Conflict` while binary staging files or unresolved installation intents exist, and tells the operator to start and then stop the daemon, which runs recovery. This keeps backup non-mutating.
- **(b)** Backup runs the same bounded recovery first, and the "no mutation" claim is narrowed to "no mutation beyond recorded crash recovery".

Either way, add: "after restore, an intent whose filesystem identity no longer matches is resolved conservatively: delete the owned staging file and preserve the blob." With option B of C2, the retained staging file plus inode equality _is_ the intent, so no new intent table is required. That is optional, but simpler.

## Should fix (small; may be applied before presentation or left as implementation notes)

- **S1. StorageFull mapping (from source).** The draft builds host Effect FileSystem services for internal writes. In `@effect/platform-node-shared`, `handleErrnoException` maps `ENOSPC` and `EDQUOT` to `SystemError._tag: "Unknown"`, with the errno only in `cause`. `storageError` reads a top-level `code`, so it would report `Unavailable`, not `StorageFull`. Either map `PlatformError.reason.cause.code`, or keep `node:fs` for host blob I/O. The existing proof bullet ("Real disk exhaustion maps to StorageFull") catches this; the draft should name the trap.
- **S2. Disk-full recovery honesty (inference).** The host store uses WAL. `lake reclaim apply` writes tombstones, intents, a receipt and an epoch in one SQLite transaction, so at true disk exhaustion it can itself fail with `SQLITE_FULL`. The "use ordinary StorageFull and manual reclamation" recommendation should say that operators may need to free space outside Effectory first. This also matters for the user decision on removing the gate (D1).
- **S3. No-overwrite install needs hard links.** Node has no `RENAME_NOREPLACE`, so "no-overwrite installation" in the lake means `link()`. A repository on a filesystem without hard links could still publish JSON (which uses rename) but not bytes. State the failure mode (`Unavailable` with guidance), matching the CLI download rule.
- **S4. Global writer starvation.** The four writer permits are shared across the daemon and taken before the first chunk arrives. Four stalled author sources block binary publication for every run until a deadline fires. State this. The deadline requirement already covers it, but it is an observable cross-run effect.
- **S5. Fingerprint and descriptor implementation notes (from source).** JSON fingerprints stay `canonical({ digest, schemaId, schemaVersion, tags })`, and `Task.test` keeps `{ tags, value }`. The bytes path must use a separate fingerprint builder, so no JSON code path ever adds `kind`. The current `INSERT OR IGNORE INTO lake_schemas VALUES (?, ?, ?)` is positional, so adding the `kind` and `contentType` columns requires naming the insert columns.

## Deliberate choices (confirmed; no change requested)

- Reusing `publicationLifetime`, the per-invocation MemoMap and acquisition-plus-handler publication. `run` forks with the caller's context, so the source R (including any author Scope) is satisfied and stays visible. The private writer Scope is separate.
- Removing the 512 MiB admission gate in favour of per-artifact (16 MiB) and concurrency bounds. Technically sound, but it reverses an earlier proposal, so it is listed under D1.
- Recording installation recovery without a general orphan sweep. This is consistent with the approved retention deferral. Legacy `.pending-*` JSON temporaries and untracked orphans stay out of scope.
- The framed Effect RPC download as the recommendation, with raw HTTP as the alternative. Unchanged from round 2.
- The JSON 1 MiB cap, the backup limits (1 GiB / 128 MiB / 50,000), and the statement that 64 distinct 16 MiB blobs fill the budget (arithmetic checked).

## Required user decisions (to present, not reviewer-resolvable)

- **D1.** Remove the previously proposed bytes-only 512 MiB gate. There would be no quota, and disk-full recovery may require freeing space outside Effectory (S2). The alternatives are a fixed gate or a separate configurable quota API.
- **D2.** Reclamation during an active download, which is C2:
  - (A) amend the approved pendingBytes meaning and add lease-blocked cleanup; or
  - (B) unlink immediately, let open readers finish, and state the POSIX-only assumption.
- **D3.** Backup with unresolved binary installation work, which is C3: (a) refuse, or (b) recover first.
- **D4 (already in the draft; confirm it is surfaced).** Widening the `Task.test` publication record to a discriminated union is a TypeScript compatibility change for existing tests that read `.value`.

## Tested facts vs inferences

**Tested.** Scratch files are outside the checkout, in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/8d49d652-f9d9-4cb5-99c3-7fbf9e6cbb1f/scratchpad/r3/` (`lifetime.ts`, `fs.ts`, with a symlinked `node_modules`). Environment: Bun 1.4.3, Darwin arm64, Effect 4.0.5.

- The handler-stream, request-scope and fetch-`finally` lifetimes against client consumption, for 1 MiB, 16 MiB and abort (table in C1).
- The maximum NDJSON line after `Stream.rechunk(1)` is 87,430 bytes.
- Unlink-while-open reads (sync and stream) return all 16 MiB unchanged.
- A second `link()` onto an existing name fails with `EEXIST` and does not overwrite.
- A linked staging file and blob share `(dev, ino)`; `copyFile` breaks that identity.

**From source (read, not executed).**

- `HttpEffect.toWebHandlerWith` transfers the request scope to the body stream.
- The RPC server finalizer interrupts handler fibers and waits on `shutdownLatch`.
- `RpcServer` handles `Interrupt` with `interruptUnsafe`, which does not wait. So a request-scope close does not wait for handler finalizers.
- The daemon builds the services Layer before `toHttpEffect`, so release order is Bun stop → RPC server → services.
- ENOSPC is normalized to `Unknown` by `handleErrnoException`.
- `storageError` reads only a top-level `code`.
- A failed job in `resumeReclamation` turns apply into `Unavailable`.
- Backup performs no lake recovery.
- JSON publish is fully synchronous, so it already shares the non-yielding section with `unlinkJob`.
- `lake_schemas` is inserted positionally.

**Inference (not tested).**

- The C2 option B writer re-link flow (only the underlying link and unlink semantics were tested).
- RPC shutdown waits for handler finalizers before the Lake closes.
- WAL writes can fail at true disk exhaustion.
- Buffered-byte figures on non-loopback sockets or other OSes.

## Exact corrections for conditional approval

1. **C1:**
   - Reword lines 110, 146 and 175 to the request-Scope admission contract above.
   - Delete "explicit transport ownership hook".
   - Replace the "permits persist through response-body consumption" proof with the three proofs listed in C1.
   - If a read lease remains, place it in the handler stream Scope.
2. **C2:** Present D2 explicitly as an amendment to the approved retention receipt, or adopt option B. Option B means rewriting "Reclamation and live operations" and the writer-lease sentence in "Binary installation recovery"; that rewrite triggers the narrow re-check.
3. **C3:**
   - Choose backup option (a) or (b) and remove the contradicting sentence.
   - Add the post-restore conservative-resolution rule.
   - Note that staging and blob are counted twice in the backup budget while an intent is unresolved.
4. Add S1–S4 as one sentence each. S5 may stay as implementation notes.
5. Add D1–D4 to the presentation's user-decision list.

With 1, 3, 4 and 5, plus option A for item 2 presented as a decision, no further Effect round is needed before presentation. With option B for item 2, re-check those two sections only.
