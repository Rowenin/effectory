# Binary artifacts — Effect review, round 1

Reviewed: [binary-artifacts-api-draft.md](binary-artifacts-api-draft.md) (unapproved, not yet presented). Scope: Effect 4.0.5 Stream/Scope/FileSystem ownership, typed mixed JSON/bytes publication, runtime boundaries, durability, RPC/CLI transport and compatibility. This approves nothing for the user. No production code, tag implementation or other review was changed.

## Verdict: REQUEST CHANGES

The consumer direction is sound: one `Artifact.make` with a `kind` discriminant, `context.publish` overloaded per declared output, inputs limited to `Uint8Array | Stream<Uint8Array, E, R>`, nothing but a reference crossing graph/RPC boundaries, and no binary stdout. Four parts of the draft are wrong or unspecified against the current sources, though, and one of them is a hidden memory collection that a probe reproduced.

Evidence labels used below:

- **Source fact**: read in this checkout or in `node_modules/effect` 4.0.5.
- **Tested**: a scratch probe outside the checkout, run with this checkout's Effect 4.0.5 and Bun 1.4.3.
- **Untested proposal**: a reviewer suggestion that has not been probed.

## Verified Effect 4.0.5 names (source facts)

| Need | Exact 4.0.5 surface |
| --- | --- |
| Bytes field in an RPC schema | `Schema.Uint8Array` (its default JSON serializer writes Base64); `Schema.Uint8ArrayFromBase64` when an explicit string codec is wanted |
| Streaming RPC | `Rpc.make(tag, { payload, success, error, stream: true })`, already used by `RunWatch` |
| Wire framing | `RpcSerialization.layerJson` (`includesFraming: false`) and `RpcSerialization.layerNdjson` (`includesFraming: true`) |
| Server buffer | `RpcServer.toHttpEffect(group, { streamBufferSize })`. This only bounds the queue when serialization is framed (`dist/rpc/RpcServer.js:750`) |
| File I/O | `FileSystem.FileSystem` with `stream(path, { chunkSize, offset, bytesToRead })` and `sink(path, …)`. Core `effect` ships only the interface, `make`, `makeNoop` and `layerNoop`. A live implementation needs `@effect/platform-bun` |

The daemon and the client both use `RpcSerialization.layerJson` (`packages/platform-bun/src/daemon.ts:150`, `client.ts:54`). The HTTP fetch wrapper parses every request body with `request.clone().json()`, enforces `inFlight < 32`, and sets `maxRequestBodySize` to 1 MiB (`daemon.ts:174–204`).

## Blockers (ranked)

### B1. `LakeDownload` as an RPC stream on the current transport collects the whole artifact in memory

**Source fact.** With an unframed serialization, `makeProtocolWithHttpEffect` creates an unbounded queue and returns `HttpServerResponse.text(parser.encode(yield* Queue.collect(queue)))`, so the response is sent only after the stream ends (`RpcServer.js:748–800`). The client's `makeProtocolHttp` also reads `response.text` in full before decoding (`RpcClient.js:526–548`).

**Tested.** I ran a probe of `RpcServer.toHttpEffect` + `Bun.serve` + `RpcClient.layerProtocolHttp` with a stream of one metadata frame and three `Schema.Uint8Array` frames, 300 ms apart:

- `layerJson`: every frame arrived at about 978 ms, together. The wire body was one JSON array (`"data":"AP8K"`).
- `layerNdjson`: frames arrived at 16, 319, 620 and 932 ms, and decoded back to `Uint8Array`.

In a second probe, the server produced 2,000 × 64 KiB frames (128 MiB) to a reader that pulled five times at 200 ms intervals:

- `layerJson`: the server produced all 2,000 frames before the client had about 2 MiB, and the probe process's RSS grew by about 5.8 GiB.
- `layerNdjson` with `streamBufferSize: 4`: the server produced only 65 frames. After the client aborted, it stopped at 161 frames and the stream finalizer ran.

**Counterexample.** One `effectory lake download` of a 64 MiB artifact over today's `/rpc` makes the daemon build about 87 MiB of Base64 plus per-frame envelopes, and the CLI then holds and parses the whole thing. A few concurrent downloads can push the daemon out of memory. Under this transport, the draft's "slow-reader backpressure" and "raw chunks capped at 64 KiB" give no bound at all.

Side observation, outside this draft's scope: by the same mechanism, today's `RunWatch` cannot deliver heartbeats or events before the run ends. It deserves its own check.

**Smallest fix.**

1. Do not add `LakeDownload` to the existing `ControlPlane` group on `/rpc`. Switching `/rpc` to ndjson would break old clients, and the fetch wrapper's `.json()` pre-parse rejects multi-line bodies.
2. Mount a separate framed endpoint instead, for example `/rpc/content`, served by its own `RpcServer.toHttpEffect(ContentPlane, { streamBufferSize: 4 })` with `layerNdjson`. Apply the same bearer/repository authorization, gate it on `binary-artifacts.v1`, and give it its own download limit. `docs/daemon-rpc.md:51` already allows "bounded streaming or a separate authenticated content endpoint".
3. Required proofs:
   - Bun keeps backpressure on a real socket, not just in-process.
   - The `inFlight` counter: today the `finally` block runs when the `Response` is returned, before a streamed body finishes, so downloads would escape the 32-request limit. This is a source fact for the code path; its effect on streams is untested.
   - Bun's default `idleTimeout` against a slow reader (untested).
   - The client has a bounded decode buffer per line.

### B2. Backup and storage growth break within about a gigabyte, and the draft claims "backup still works"

**Source fact.** `backup.ts:34–36` caps a snapshot at **1 GiB total**, 128 MiB per file and 50,000 files over the whole repository. The draft proposes 64 MiB artifacts with no retention, deletion or GC. Every publish attempt that conflicts writes its blob before the commit transaction (`lake.ts:224`) and leaves it orphaned. `.pending-*` files from crashes are not excluded by `excluded()`.

**Counterexample.** A nightly task publishes a 64 MiB archive. On about day 16, `backup` starts failing `LimitExceeded` and nothing in this slice can recover it. A second counterexample: a non-deterministic gzip (the draft's own example; the gzip header carries an MTIME) retried three times leaves about 192 MiB of orphaned blobs.

**Smallest fix (untested proposal).** Pick one of these before presenting:

- **(a)** Lower the initial binary cap (for example 16 MiB), and add a repository-wide binary byte quota, counting orphans, that is checked before content is admitted and reported in `ServerHello.limits`. Document that backup fails beyond its 1 GiB limit.
- **(b)** Ship minimal reference-aware orphan GC and backup limits that scale in the same slice.

Either way:

- The startup `.pending-*` sweep must cover JSON blobs as well, and must run before backup inventory.
- The draft should state the backup budget as a user-visible limit.
- The required proof "binary blob backup/restore verifies hashes" must include one test at the quota boundary.

### B3. The runtime and author boundary for bytes is unspecified, and "ordinary Effect FileSystem" is not available on either side

**Source facts.**

- `Task.RuntimeContext.publish` takes `value: Schema.Json` (`task.ts:56–65`).
- `lake.publish` is one synchronous `Effect.try` over `node:fs` sync calls: `writeFileSync`, `fsyncSync`, `renameSync`, and a SHA-256 over a string held in memory (`lake.ts:56–85, 181–224`).
- When a blob already exists, `atomicBlob` reads the **entire** blob with `readFileSync` to re-hash it, and `lake.get` does the same.
- No daemon Layer provides `FileSystem`.
- Host modules export only `effect/*` and the SDK (`host-modules.generated.ts`, `docs/binary-distribution.md:11–15`). Core `effect` has no live FileSystem.

**Counterexamples.**

- Reusing the lake helpers for a 64 MiB dedupe or retry blocks the daemon fiber, and with it every RPC, scheduler tick and lease heartbeat, for the length of a full synchronous read and hash. It also allocates the whole blob.
- The draft's headline consumer example gets `chunks` from "ordinary Effect FileSystem adapters". A task author has no `FileSystem` in `R` unless they bundle `@effect/platform-bun` into `application.mjs` and `.provide(BunFileSystem.layer)` it themselves. The draft is silent on whether that is supported for apps and extensions, or whether the host provides `FileSystem`.

**Smallest fix (untested proposal).**

1. Specify a second internal runtime capability, kept separate from the JSON one so its signature and mapping stay untouched:
   - Shape: `publishBytes: <E, R>(name, artifact, source: Stream<Uint8Array, E, R>, options) => Effect<Reference, E | TaskRuntimeError, R>`.
   - The finite `Uint8Array` input is normalized in the SDK to `Stream.succeed(copy)`.
   - The lake's `mapError` must convert only lake `OperationError`s, so the producer's `E` passes through untouched. Today's `lake.publish` maps every failure (`lake.ts:360–372`).
2. Implement byte ingestion with a daemon-owned `FileSystem` Layer, built once at the host Layer and not per invocation:
   - Use `Effect.acquireUseRelease` (or `Effect.scoped` with `fs.makeTempFile` / `open`) for the temporary file.
   - Hash and count incrementally in a `Stream.runForEach` / `Sink`, write asynchronously, then fsync the file and directory.
   - Rename, then run the existing synchronous SQLite commit.
   - Deduplicate by comparing stored length and digest metadata, and verify content with a streaming hash. Never use `readFileSync`.
3. State the author story explicitly. Either the host provides `FileSystem` to tasks as a runner-owned service, as it does for `Tag.Values`, which means a new decision on the public DI surface; or authors provide `BunFileSystem.layer`, which needs a host-module/SDK decision and a test that this works inside a compiled binary and an extension.

### B4. An in-flight publication is not owned by the attempt Scope

**Source facts.**

- `definition` gives every `execute` a fresh `Layer.CurrentMemoMap` (`task.ts:226–235`), and `.provide` builds task Layers inside that invocation (verified by the tag work). Layers provided at task level are therefore released when the handler returns. Application-level Layers (`Application.provide`) are built at registry time and are daemon-scoped.
- The commit-time admission check verifies the run fence, `host_attempts.owner == lease.token`, and the run status (`lake.ts:228–260`). It does not check that the attempt is still executing.

**Counterexample.** A handler does `yield* Effect.forkDetach(context.publish("archive", slowStream, …))` and returns. Three things go wrong:

1. The task-level Layer that supplies `slowStream`'s resources closes under the stream, which fails or is interrupted mid-write.
2. If that Layer is application-level instead, the publish keeps running and can **commit after the attempt has succeeded**, attaching an `ArtifactPublished` event to a finished node. The same thing happens with a sibling retry attempt.
3. A 64 MiB stream makes this window long. JSON publication has the same flaw, but the window is microseconds.

**Smallest fix (untested proposal).** The runner creates one attempt `Scope` (or `FiberSet`) and passes it into the runtime publish capability. Every publish runs as a child of that scope. When the attempt closes, the runner interrupts outstanding publishes and waits for their finalizers before recording the attempt outcome. A publish that starts after close fails `PublicationConflict`. Add "publish forked past handler completion" to the required proofs. Do not hand out the writer or the scope to user code, which matches the draft's "Application Layers must not capture it".

## Should fix before presentation

**S1. Type surface (tested feasibility, standalone sketch).** I typechecked a sketch with separate `JsonArtifact<Id, S>` / `BytesArtifact<Id, C>` interfaces and a two-signature `publish` overload under `strict` + `exactOptionalPropertyTypes`. Results:

- `Uint8Array` infers `Effect<Ref<"a">, TaskRuntimeError, never>`.
- `Stream<Uint8Array, PlatformError, FileSystem>` infers `Effect<Ref<"a">, PlatformError | TaskRuntimeError, FileSystem>`.
- JSON keeps its current inference.
- These are rejected: bytes into a JSON output, a JSON value into a bytes output, a web `ReadableStream`, `Stream<string>`, and a union key `"archive" | "report"`. There was no `any` leakage.

The sketch did not use the real SDK types. Specific changes to make:

- **Keep `Artifact.Artifact<Id, S>` as the JSON shape and add `kind: "json"` to it.** Add a separate `Artifact.Bytes<Id>` and widen `Outputs` to `Record<string, Artifact | Bytes>`. Turning `Artifact` itself into a union breaks every internal and consumer reader of `.schema`, `.fields`, `.queryFields` and `O[K]["schema"]["Type"]`: `lake.ts:87–106` and `:181–189`, the canonical artifact map in `extension-registry.ts:171–180`, and describe/plan.
- **Correct "stream errors remain inferred".** `Task.make` constrains the handler's error type to `NoInfer<S["error"]["Type"]> | TaskRuntimeError`. A `PlatformError` from `FileSystem.stream` therefore fails to compile unless the author maps it to a declared domain error. That is good, because retries apply only to tagged domain errors (`interpreter.ts:275–286`), but the draft should say so and show a `Stream.mapError` in the example.
- **Address `Scope` in `R`.** A stream whose `R` includes `Scope` reaches `Definition` `R`, and no Task path provides `Scope`. Either exclude it by running the source in the publish's own scope, or document `Effect.scoped`.
- **Make the content type a validated `string`, not a literal generic.** Nothing consumes `C` at the type level.

**S2. Retry with non-deterministic bytes.** The publication identity excludes the attempt, so a retry that produces different bytes is a `PublicationConflict`. Today that is correct; with archives, timestamps and compression it becomes common. The `application/gzip` example is exactly that trap. Fix: state it in the consumer surface, use deterministic content in the example, and test a conflicting retry plus the orphan it leaves (see B2).

**S3. `Task.test` claims a "same digest".** The current harness issues fake `test-digest-N` digests and fake artifact IDs even for JSON (`task.ts:368–378`). Smallest coherent fix: keep fake references for both kinds, and give the bytes `TestPublication` variant `{ kind: "bytes", contentType, bytes, sha256, byteLength }`, with `TestPublication` discriminated by `kind`. Making references real for JSON would change existing users' test output.

**S4. CLI naming.** The existing command group is `lake` (`lake versions`, `lake get`, …; `packages/cli/src/main.ts:607–640`), not `data`. Use `effectory lake download <artifactId> --version <n> --output <path>`. Keep the draft's rules: temporary file in the same directory, digest and length check, `link`/`O_EXCL`-style install with no overwrite, cleanup on interruption, and a JSON receipt with no content.

**S5. Download verification cost.** Verifying before streaming reads 64 MiB twice and still cannot rule out a change between the check and the read. The metadata frame already carries `digest` and `bytes`, and the CLI verifies them before it installs the file. Prefer a single server pass that hashes while it streams and fails the stream at the end on a mismatch, plus mandatory client verification. Keep "never install known-corrupt content" as the guarantee, not "never send".

**S6. Compatibility of persisted and wire metadata.**

- `ArtifactRecord` is persisted in `lake_records.metadataJson` **and** in `host_events` `ArtifactPublished` payloads, and both are decoded later. `kind` and `contentType` must be `Schema.optionalKey`, with the default applied at the read edge, or old rows fail to decode.
- On the wire, old clients receiving the extra fields probably decode fine, since RPC decoding uses default excess-property handling, but that is untested and needs one assertion.
- Adding `kind` or `contentType` to the `Field.metadata` literal list makes new queries fail against old daemons. Defer it, or gate it on the capability.
- `LakeGet` must reject a bytes reference based on its metadata `kind` **before** opening content. The content-addressed namespace is shared, so a bytes blob can happen to be valid JSON.

**S7. Copying and re-running streams.**

- If the ingestion sink waits for each write before pulling the next chunk, the producer cannot reuse a buffer under a write in progress. Copying every chunk then doubles allocation for no gain. Specify "the runtime holds no reference to a chunk once that chunk's write completes", and copy only the finite `Uint8Array` input.
- A single-shot source (a `Stream.fromReadableStream` over one `ReadableStream`, or a `Queue`) re-run by a user's `Effect.retry` around `publish` yields zero bytes. Zero bytes is valid content, so this is a silent empty publication under a new key, or a conflict under the same key. Document this; it is not a reason to forbid empty content.

## What holds up

- Source fact: tasks run in the daemon process (`interpreter.ts:104`), so bytes never need to cross a worker or process boundary inside a run. Only the reference crosses graph and RPC.
- Fresh per-invocation memo maps (the tag work) give the right isolation for author-provided source Layers: one run cannot close another run's FileSystem or HTTP resources.
- Keeping `context.publish` instead of adding a publication service is correct. Typing is driven by declared outputs, and a DI service could not carry the per-task output table without reinventing it. This is the same conclusion as the typed run tags DI review.
- Swamp citations checked: `FileOutputSpec` and its schema are at `model.ts:68–92`, `createFileWriter` at `:221`, and `writeAll` / `writeStream` / `finalize` in `data_writer.ts:165–325`. Swamp's `getFilePath`, `writeLine`, lifetime and GC have no counterpart here. The draft says so honestly, and the parity gap table should repeat it.

## Required changes to the draft before the next round

1. Replace the `LakeDownload`-on-`/rpc` design with a framed content endpoint, and record the tested `layerJson` collection behavior (B1).
2. Choose either a cap plus repository quota, or GC, and state the backup limit (B2).
3. Specify `publishBytes`, async ingestion through a daemon `FileSystem`, streaming dedupe, and the author FileSystem story (B3).
4. Bind publication to an attempt Scope and add a proof for a forked publish (B4).
5. Apply S1–S7: separate `Artifact` / `Bytes` types, the corrected error-channel statement, a deterministic example, an honest `Task.test` digest claim, the `lake download` name, optional metadata keys, and the copying rule.
