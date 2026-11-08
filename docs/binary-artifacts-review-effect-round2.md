# Binary artifacts — Effect review, round 2

Reviewed: [binary-artifacts-api-draft.md](binary-artifacts-api-draft.md), revision 3 (not user-approved, not implemented), against [the Effect round-1 review](binary-artifacts-review-effect-round1.md) and [the consumer round-1 review](binary-artifacts-review-consumer-round1.md). Scope: whether revision 3 resolves round-1 B1–B4, and a critique of the new deliberate choices. I changed only this file: no source edits, no other docs, no commits, no subagents. Approval from this reviewer is not user approval.

Evidence labels:

- **Source fact**: read in this checkout or in `node_modules/effect` 4.0.5.
- **Tested**: a scratch probe outside the checkout, run with this checkout's Effect 4.0.5, TypeScript and Bun 1.4.3. Probes are in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/ef8f46f5-5339-4cbe-812b-b5ca61f4f48b/scratchpad/bin-r2/`. They are not project artifacts.
- **Untested proposal**: a reviewer suggestion that has not been probed.

## Verdict: REQUEST CHANGES (small)

Revision 3 resolves the structure of all four round-1 blockers. I probed its two riskiest feasibility claims, and both hold:

- Scope can be removed from the publication's requirements without a cast.
- A supervisor close barrier placed inside the task-local `.provide` Layer wrappers runs publication finalizers before the Layer releases.

Five issues remain, and each has a small fix:

1. One storage default regresses existing JSON-only users.
2. The draft's "register then await" supervisor wording admits a tested commit-after-abandon.
3. One cleanup guarantee is misstated.
4. One overload signature infers `unknown` for the common `Uint8Array` case.
5. RPC chunk batching provably breaks the 128 KiB line budget unless the stream is rechunked.

Fix these in revision 4. None of them needs another design round.

## Round-1 blocker status

| Round-1 blocker | Revision 3 | Status |
| --- | --- | --- |
| B1 buffered `/rpc` download | Separate authenticated `POST /rpc/content` `ContentPlane` with NDJSON, bounded request, `streamBufferSize: 4`, a download permit held for the response lifetime, and no `/rpc` fallback | **Resolved in design.** R5 below names the one missing mechanism. Two placement details are in S3. |
| B2 backup/storage growth | 16 MiB cap, 512 MiB blob quota counting orphans, sweep of `.pending-*` before backup, explicit 1 GiB backup caveat | **Direction resolved.** The quota's application to JSON is a new regression (R1). |
| B3 runtime/author boundary | Separate `publishBytes` hook returning `Exclude<R, Scope>`, error mapping at each host call site, daemon-owned async FileSystem not provided around author code, author-provided `BunFileSystem.layer` | **Resolved.** The Scope removal was tested (below). R4 is a typing detail. |
| B4 attempt ownership | Private per-invocation supervisor, atomic admission/close, barrier inside the `.provide` wrappers, attempt-active commit fence for JSON and bytes | **Resolved in placement (tested).** R2 and R3 are semantic gaps in the wording. |

The consumer round-1 blockers are also addressed:

- `lake download` naming.
- Install via hard link and unlink.
- The `{kind, contentType, fields}` schema descriptor, which catches drift.
- A complete, mapped-error example. It is still untypechecked against real SDK types, but the parent's source probe ran an equivalent task.
- The discriminated `TestPublication`.

## Feasibility probes for this round

### P1. Scope removal from `publishBytes` requirements (tested, real Effect types, stand-in Ref/error)

`types.ts` typechecks a generic hook implemented with no casts. Under `strict` and `exactOptionalPropertyTypes` the build exited 0, and every `@ts-expect-error` fired. The hook does `Effect.scoped(Effect.gen(...Effect.addFinalizer...; Stream.runForEach(source, ...)))`, then `FiberSet.run(set, work)` and `Fiber.join`, with this signature:

```ts
<E, R>(…, source: Stream<Uint8Array, E, R>) =>
  Effect<Ref, E | TaskRuntimeError, Exclude<R, Scope.Scope>>
```

Results:

- **Source fact:** `Stream.fromEffect(Effect.acquireRelease(...))` does carry `Scope` in its `R`. `Stream.runDrain` and `Stream.runForEach` do not remove it (`Stream.d.ts:15717`, `:15962`). Running such a stream directly leaks `Scope`; the probe asserts this.
- A scoped source infers `R = never`.
- An `Http`-service source keeps `Http`, and assigning it to `never` is rejected.
- A mixed `Scope + Http` source infers `Http`.

So `Exclude<R, Scope>` is implementable only through the publication's own `Effect.scoped`, as the draft says. Untested: the real SDK `TaskContext` overload and `Task.make` replacement inference.

### P2. Close barrier inside `.provide` wrappers (tested, real `Task.make(...).provide(layer)` and `Task.test`)

**Source fact:** `.provide` wraps the raw `execute` closure (`task.ts:237–242`), and `make` calls the handler inside that closure (`task.ts:250–283`, handler call at `:270`). A barrier in the `make` body therefore sits inside every task-local Layer wrapper. No new composition point is needed.

`order.ts` simulates the barrier at the same position: a `FiberSet` plus a synchronous closing flag, closed in `Effect.ensuring` around the handler. The task-local Layer logs its finalizer. Observed orders:

- Detached publish, handler succeeds: `layer:acquire, barrier:close, pub1:finalizer(sourceOpen=true), barrier:done, layer:release`.
- Forked publish, handler dies: same order, and the source is still open in the publication finalizer.
- Publish captured and started after close: `PublicationConflict`, and `layer:release` comes first.
- In-flight non-detached publish, outer `timeoutOrElse` like the interpreter's: the barrier finalizer runs before `layer:release`.
- `FiberSet.run` from a `forkDetach`ed fiber saw the task-local `Source` service. "Registers a child … using the caller's Effect context" is therefore accurate.

## Remaining blockers (ranked)

### R1. The 512 MiB quota on existing JSON publication turns a backup failure into failing runs, with no recovery

**Source fact:** today a JSON publication has no total-size gate (`lake.ts:181–224`). Only backup fails at 1 GiB (`backup.ts:34–36`). Revision 3 gates **all** new immutable bytes, JSON included, at 512 MiB, and has no reclamation command.

**Counterexample:** a JSON-only repository that never declares a bytes output has a scheduled task publishing a unique 12 KiB JSON summary every minute. That is about 17 MiB a day, so about 30 days after upgrading, every JSON publication fails `LimitExceeded` and runs fail. Before the upgrade, the same repository kept running and only `backup` failed. The user cannot recover without deleting files by hand, and deleting files by hand breaks referenced artifacts.

The draft's stated reason, avoiding "an inaccurate distinction between JSON/binary ownership in a shared digest namespace", is about blob ownership. That does not require gating JSON admission.

**Smallest fix (untested proposal):** keep a single physical count of unique blobs, including orphans and JSON, but enforce the quota only when **admitting bytes publications**:

- A bytes publication must reserve its growth so that counted total plus reservation ≤ 512 MiB.
- JSON publications are counted but never rejected by the quota. They keep today's 1 MiB per-value cap.
- Binary growth stays bounded by the quota, there is still no ownership attribution, and JSON-only users see no change.
- Name the limit `limits.binaryAdmissionBlobBytes` (or keep `lakeBlobBytes` and document that only bytes admission is gated).

Present the hard total-gate variant to the user only as an alternative.

The binary arithmetic also needs to go in front of the user plainly: a nightly 16 MiB artifact exhausts the quota in about 32 days, and after that bytes publication fails until a future reclamation slice. Offer one cheap, safe option alongside it, rather than burying it:

- **Startup orphan sweep (untested proposal):** under exclusive startup ownership, delete blobs that no `lake_records.digest` references. No publication is in flight at that point, so this cannot race an install.
- It reclaims conflict and crash orphans only, not retained artifacts.
- The user may still decline it.

### R2. "Register a child, then await it" lets a publication that the caller abandoned commit later

**Tested (`joiner.ts`):** a caller runs `FiberSet.run(set, work).pipe(Effect.flatMap(Fiber.join))` under `Effect.timeoutOrElse(20 ms)`. The caller observes its timeout, and the child then **commits** 100 ms later, while the attempt is still active: `["caller:timedOut","child:COMMIT","attempt:end"]`. Interrupting a joiner does not interrupt the joined fiber.

**Counterexample:** a user writes `context.publish("archive", stream, { key: "a" }).pipe(Effect.timeout("5 seconds"), Effect.orElse(() => context.publish("archive", fallback, { key: "a" })))`. The first publication finishes in the background:

- If the first commits first, the fallback conflicts.
- If the fallback commits first, the first conflicts silently in a fiber nobody observes.

Either way the visible artifact is not the one the caller's control flow chose. The attempt fence does not help, because the attempt is still active.

**Smallest fix (tested):** link the joiner to the child's interruption:

```ts
Effect.uninterruptibleMask((restore) =>
  Effect.flatMap(FiberSet.run(set, work), (fiber) =>
    restore(Fiber.join(fiber)).pipe(
      Effect.onInterrupt(() => Fiber.interrupt(fiber))
    )
  )
);
```

The probe shows `["child:interrupted","caller:timedOut","attempt:end"]`, and the timeout returns only after the child's cleanup. Specify this in the draft: "interrupting the publish Effect interrupts and awaits its supervised child; the supervisor exists to catch detached or forgotten publishes, not to outlive an interrupted caller". Add it to the required proofs.

### R3. The "existing two-second NeedsAttention/quiescence policy" does not cover the barrier's normal paths

**Source facts:**

- `attentionIfOverdue` applies the 2-second rule only after a stop/cancel **fence request** (`runner.ts:61–79`, `interpreter.ts:433–465`).
- Normal completion, domain failure, retry and the attempt deadline go through `Effect.timeoutOrElse` (`interpreter.ts:229–244`).

**Tested (`hang.ts`):** `Effect.timeoutOrElse({ duration: 30 })` around an effect with an 800 ms interrupt finalizer returned after **836 ms**. Timeout waits for finalization.

**Counterexample:** the source of a detached publish has a finalizer that hangs, for example an HTTP body cancellation that never settles. The barrier waits forever inside the Layer wrapper, the attempt never records an outcome, and no NeedsAttention event fires, because no fence was requested.

This is the same behavior handler finalizers have today, so it is not a new class of failure. The draft states the opposite, though.

**Smallest fix (wording):** "Runtime-owned publication cleanup (temporary file close and unlink, permit release) is cooperative and bounded. Author source finalizers inherit today's handler-finalizer behavior: unbounded on completion, retry and deadline; under the 2-second NeedsAttention policy only after stop/cancel." If the user wants a bound, raise it as a separate runner decision, not as part of this slice.

### R4. The bytes overload must default `E` and `R` to `never`

**Tested (`overload.ts`):** `declare function f<E, R>(source: Uint8Array | Stream<Uint8Array, E, R>)` called with a `Uint8Array` infers `E` and `R` as `unknown`. The result `Effect<Ref, unknown, unknown>` would poison the handler's error and requirement channels. With `<E = never, R = never>`, a `Uint8Array` infers `Effect<Ref, TaskRuntimeError, never>`, and a failing stream keeps its literal error.

**Fix:** write the defaults into the proposed `context.publish` bytes overload, or split it into a `Uint8Array` signature and a `Stream` signature. Add the "Uint8Array infers never" case to the compile proofs.

### R5. One logical frame per RPC chunk needs an explicit `Stream.rechunk(1)` (or equivalent), or the 128 KiB line budget fails

**Source fact:** the server writes one `Chunk` message per array pulled from the handler stream (`Stream.runForEachArray(stream, values => writeChunk(values))`, `rpc/RpcServer.js:322`).

**Tested (`frames.ts`):**

- Three 64 KiB `Schema.Uint8Array` frames from `Stream.fromIterable` encode as **one 262,235-byte NDJSON line**. `makeNdjson({ maxBufferSize: 131_072 })` rejects a 2-frame line on decode with `MaxBufferSizeExceeded`.
- After `Stream.rechunk(1)`, each line is 87,441 bytes.

**Counterexample:** a server implementation that reads 256 KiB from the blob and splits it into four frames inside a single `Stream` emission makes every CLI download fail partway through. The draft says to "verify" this; it should specify the mechanism.

**Fix:** make `Stream.rechunk(1)` the final stage of the `LakeDownload` handler stream, after slicing to at most 64 KiB, and keep the line-size test in the proofs.

## Should fix

**S1. Drop the separate 1 MiB inline cap and the inline copy (simplify).**

- `context.publish(name, Stream.succeed(bigArray), …)` bypasses the 1 MiB cap in one line. It then gets the uncopied, do-not-mutate semantics anyway.
- The cap therefore buys only a bound on runtime copies, and the caller already holds the array.
- Smallest coherent rule: one 16 MiB `binaryArtifactBytes` cap for both inputs. Treat a `Uint8Array` as a single-element stream sliced into ≤64 KiB writes, with no copy, and apply one documented rule: "do not mutate a buffer you passed until its publish completes".
- This removes a public limit (`binaryInlineBytes`) and the 4 MiB copy accounting.
- If the user prefers copy isolation for arrays, keep the copy but apply the 16 MiB cap, and say that it costs up to 64 MiB of transient copies under the four-permit semaphore.

**S2. Token ownership and the unnecessary fallback.**

The draft says that every invocation "owns a private supervisor and an attempt-active token". It should state who owns which part:

- **Supervisor and admission flag:** SDK-private, in the `make` body (P2).
- **Commit fence:** a host-owned flag in the per-attempt `taskContext` closure (`interpreter.ts:65–107`). The host sets it false after `task.execute` exits and before it records the outcome, and checks it inside the synchronous commit transaction.

The host flag is defense in depth for adapters that call `RuntimeContext` directly. The SDK barrier already guarantees that no supervised child survives.

Drop the "outer cleanup fallback for Layer acquisition failure". If a task-local Layer fails to build, the `make` body never runs, no supervisor exists and no publication was admitted. Layers cannot reach `context`.

**S3. Transport placement details (untested proposal).**

- **Permit placement.** Acquire the download permit inside the `ContentPlane` handler stream, for example `Stream.unwrap` over an `Effect.acquireRelease` of `semaphore.take(1)`, not in the fetch wrapper.
  - With `streamBufferSize: 4` the handler fiber is suspended on the queue while the reader is slow. The permit then lives for the response lifetime, minus at most four queued frames and the socket buffer.
  - The request-scope finalizer (`RpcServer.js:769–781`) sends `Interrupt` on disconnect and releases the permit.
- **Request bound.** `RpcServer.toHttpEffect` reads the body with an unbounded `request.text` (`RpcServer.js:747`). Bun's global `maxRequestBodySize` is 1 MiB (`daemon.ts:204`). The 16 KiB bound and the single-request, single-method check must therefore run in the route wrapper:
  1. Read the body with a byte limit.
  2. Parse exactly one NDJSON line.
  3. Rebuild the `Request` for the handler.
- **Serialization.** The `ContentPlane` server needs its own `RpcSerialization` context. Today the shared `serviceContext` merges `layerJson` (`daemon.ts:149–150`).

**S4. Quota reservation timing.**

- If growth is reserved only at install, a writer can stage up to 16 MiB and then fail the quota. That is wasted but bounded I/O.
- If 16 MiB is reserved up front, four writers can spuriously fail within 64 MiB of the quota.

Pick one and state it. I recommend reservation at install with staging bounded by the four permits. Also say that startup reconciliation stats every blob once, an O(blob count) startup cost.

**S5. The two digests on a test record.** A bytes `TestPublication` has `reference.digest === "test-digest-N"` and a real `sha256`. Document that tests must compare `sha256`, not `reference.digest`. The fake reference stays for consistency with JSON (round-1 S3), and that choice is sound.

## The new deliberate choices

| Choice | Assessment |
| --- | --- |
| 16 MiB streamed / 1 MiB finite | 16 MiB is a reasonable first cap: 32 artifacts fill the quota, and the backup per-file limit (128 MiB) is comfortably above it. The split cap does not hold up (S1). |
| 512 MiB shared quota including orphans and existing JSON, no reclamation, 1 GiB backup caveat | Counting everything physically is right. Gating JSON is a regression (R1). Leaving a full quota without reclamation is acceptable only if the arithmetic is shown to the user, ideally with the optional startup orphan sweep. The backup caveat is honest: with R1's fix, JSON can push the lake past 512 MiB, and backup still fails explicitly at 1 GiB, as it does today. |
| Fake test references plus real sha256/size | Coherent and non-breaking for JSON. Document it (S5). |
| Sequential uncopied stream chunks, ≤64 KiB slices | Correct Effect idiom. `Stream.runForEach` pulls the next element only after the write effect completes, and `subarray` slicing allocates no copy. Source-owned read-ahead, such as `fs.stream`'s own chunking, is correctly excluded from the bound. |
| App-bundled `BunFileSystem.layer`, no host FileSystem service | Correct. The parent's probe (bundled `@effect/platform-bun@4.0.5`, exact non-UTF8 bytes, typed missing-file failure) is the right evidence. The dropped `Bun.file().stream()` idiom stays dropped. The daemon's internal FileSystem should be captured as a service value at Layer build; its scoped `open`/`makeTempFile` run inside the publication's own `Effect.scoped`, so nothing leaks into the author's `R` (consistent with P1). |

## Required-proof additions

- An interrupted publish caller interrupts and awaits its child; a publish abandoned by timeout never commits (R2).
- A bytes `Uint8Array` publish infers `never` for both error and requirements (R4).
- An NDJSON line stays at or below 128 KiB with a multi-element source array (R5).
- A JSON-only repository above the binary admission quota keeps publishing JSON, and bytes admission fails with a quota message (R1).
- A hanging source finalizer on the deadline path behaves as documented (R3).

## Not re-reviewed

- Swamp citations: verified in round 1 and unchanged.
- The CLI hard-link install, MIME grammar, descriptor drift and old-row compatibility: unchanged since the consumer review endorsed them.
- The existing CLI `RunWatch` buffering: tracked separately, as requested, and not expanded here.
