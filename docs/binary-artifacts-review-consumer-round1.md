# Binary artifacts — consumer review, round 1

Reviewer: Claude, as the consumer-DX review subagent. Subject: [binary-artifacts-api-draft.md](binary-artifacts-api-draft.md), first revision (not user-approved, not yet presented). This is a review only. I made no production edits, no commits and spawned no subagents. Typed run tags were not touched. Reviewer approval is not user approval.

## Verdict

**REQUEST CHANGES before presenting.** The core shape is right: one `Artifact.make` with a `kind: "bytes"` discriminant, a single `context.publish` that accepts `Uint8Array | Stream<Uint8Array, E, R>`, an immutable reference as the only thing that crosses boundaries, and visibility only after completion. A type probe shows the publish typing is feasible. However, the draft endorses a CLI command that does not exist, specifies a no-overwrite install that the obvious implementation violates, misses a schema-drift hole in the lake, and its headline example cannot compile or run as written. Five blockers (B1–B5) follow, then should-fixes (S1–S9), then recommended resolutions of the draft's open questions.

## Evidence

**Source facts** (current checkout, pinned `effect` 4.0.5):

- `Artifact.make` accepts only `id/version/schema/fields` and throws "retention and binary outputs are not implemented" on any other key (`packages/core/src/artifact.ts:36–41`). `Artifact` requires `schema` (`artifact.ts:22–27`).
- `TaskContext.publish` types its value as `O[K]["schema"]["Type"]` and returns `Effect<Ref, TaskRuntimeError>` with no `R` (`packages/core/src/task.ts:72–76`). The handler's error channel is `NoInfer<S["error"]["Type"]> | TaskRuntimeError` (`task.ts:255–259`).
- `Task.test` records `value: Schema.Json` and fake digests `test-digest-N` (`task.ts:287–292, 372–378`).
- Tasks run in-process in the daemon. `RuntimeContext.publish` calls `lake.publish` directly (`packages/platform-bun/src/interpreter.ts:104–105`). The lake is entirely synchronous `node:fs` plus SQLite inside `Effect.try` (`lake.ts:145–152`).
- `atomicBlob`: when the blob already exists, it verifies by `readFileSync` of the whole file (`lake.ts:58–62`). `Lake.get` does `readFileSync` and then JSON-parses (`lake.ts:166–179`).
- `publicationKey = [runId, invocationPath, output, key]`. The fingerprint is `{digest, schemaId, schemaVersion, tags}` (`lake.ts:202–213`). `artifactId = sha256(principal, taskId, output, key)`, so it is stable across runs and the version increments (`lake.ts:290–299`).
- `lake_schemas` stores only `fieldsJson` per `(schemaId, version)`. Drift detection compares query fields only (`lake.ts:271–289`).
- Extension and application artifact canonicality is object identity per `id@version` (`packages/core/src/extension-registry.ts:171–179`).
- **CLI:** there is no `data` command. Artifact commands are `effectory lake versions <id>`, `lake get <id> --version <n>` and `lake query --file` (`packages/cli/src/main.ts:607–662`). `run outputs <runId>` lists task results, not publications (`history-protocol.ts:155–169`).
- `task describe` returns input/success/error schemas, replay and providerId. It does **not** list outputs (`control-plane.ts:105–134`).
- Hello advertises `limits.artifactBytes: 1_048_576` (`control-plane.ts:28–31`) and string capabilities such as `lake.ast.v1` (`control-plane.ts:182–193`).
- The RPC uses `RpcSerialization.layerJson` (`daemon.ts:150`, `client.ts:54`). Its codec is `Schema.toCodecJson` (`effect/src/rpc/RpcSerialization.ts:41`, `RpcServer.ts:1581`). `Schema.Uint8Array`'s `toCodecJson` is base64 (`effect/src/Schema.ts:10611–10626`). So no custom serializer is needed. `RunWatch` is an existing `stream: true` RPC.
- App bundles externalize only `effect/*` and the SDK (`application-bundle.ts:52–57`). The host module table contains `effect/FileSystem` (interface only) and `effect/Stream`, but **no** Bun FileSystem implementation (`host-modules.generated.ts`). Nothing in the repo provides `FileSystem.FileSystem` to handlers.
- Swamp `DataWriter` offers `writeAll`, `writeText`, incremental `writeLine` with an `onLine` live callback, and `writeStream(ReadableStream)` with line callbacks. `FileOutputSpec` carries `lifetime`, `garbageCollection` and `streaming`. `FileWriterOverrides.contentType` allows per-write MIME (`vendor/swamp/src/domain/models/model.ts:67–79, 210–216`; `data_writer.ts:165–260`). `swamp data get` defaults to the latest version.

**Scratch probes** (in the session scratchpad, against the pinned toolchain, not committed):

- _Type probe (tsc, strict, `exactOptionalPropertyTypes`)._ I modelled `Artifact.make` overloads (`{schema, kind?: "json"}` | `{kind: "bytes", contentType}`) and two `publish` designs: (A) one signature with a conditional value type, (B) two overloads filtered by JSON-keys/bytes-keys. **Both** infer `Effect<Ref<"release/archive">, PlatformError | TaskRuntimeError, "Fs">` from `Stream<Uint8Array, PlatformError, "Fs">`, and `Effect<Ref, TaskRuntimeError, never>` from a `Uint8Array`. Both reject a JSON value on a bytes output and bytes on a JSON output. A bytes spec carrying `schema` is rejected. A deliberate wrong expectation fails, so the probe is live. This was a model, not the real `Task.make`.
- _Install probe (bun, APFS)._ `renameSync(tmp, dest)` **silently replaced** an existing `dest`. `linkSync(tmp, dest)` failed `EEXIST` and left `dest` intact.

**Untested:** real `Task.make` inference with mixed outputs and handler diagnostics; whether an app can bundle `@effect/platform-bun` against the host's externalized `effect`; `Bun.file().stream()` inside app code under the daemon; RPC base64 frame sizes in practice; backpressure on the socket transport; hover quality.

## Blockers

### B1 — `data download` endorses a command family that doesn't exist (must fix)

Effectory's artifact verbs live under `lake`. Adding `data` would create a second noun for the same store and split discoverability (`effectory lake --help` would not show download).

Fix: `effectory lake download <artifactId> --version <n> --output <path>`. The positional id and `--version` match `lake get` exactly. Also, `lake get` on a bytes artifact must fail **before reading content** (see S3) with a message that contains the literal next command, e.g. `Artifact is binary (application/gzip, 12.3 MiB); use: effectory lake download <id> --version 3 --output <path>`. Keep the exact-version requirement. It matches `lake get`, and Swamp's default-to-latest is a deliberate divergence worth one sentence.

### B2 — "Install atomically; refuse an existing destination" is not what `rename` does (must fix)

Counterexample (probed): the CLI checks that `out.tgz` is absent, streams into `.out.tgz.tmp-…`, and meanwhile another process creates `out.tgz`. `renameSync` then replaces it with no error. A check-then-rename sequence cannot provide no-overwrite on POSIX.

Smallest fix: specify the install step as `link(temp, destination)`, which fails `EEXIST` atomically, followed by `unlink(temp)`. Map `EEXIST` to `AlreadyExists` and keep the destination untouched. On filesystems without hard links (`EPERM`/`ENOTSUP`, e.g. some network or FUSE mounts), fail with guidance rather than silently falling back to `rename`. Create the temp file in the destination directory with `wx` and `0o600`, and remove it on failure, interrupt or SIGINT via `Effect.acquireRelease`. Add this race to the required proofs explicitly; today the proof list says "must not permit overwrite" without naming the mechanism.

Optional but consumer-friendly: if the destination already exists **and** its length and sha256 match the artifact, succeed with `{ existing: true }`. Re-running a script is then idempotent while overwrite stays impossible. If adopted, the check reads the existing file and is still never a write.

### B3 — Changing an artifact's kind or MIME without a version bump goes undetected (must fix)

Counterexample (from source): revision 1 declares `Artifact.make({ id: "report", version: 1, schema: Csvish })`. Revision 2 changes it to `{ id: "report", version: 1, kind: "bytes", contentType: "text/csv" }`. `lake_schemas` compares only `fieldsJson`, and both are `[]` when no fields are declared, so publication succeeds. `lake query` on `report@1` now returns rows of mixed kinds, and `lake get` succeeds or fails per row. The same applies to `contentType` drift (`text/csv` → `application/gzip`). That breaks the draft's own premise that a query is "already scoped to schemaId/version".

Fix: store a descriptor `{kind, contentType, fields}` in `lake_schemas` (legacy rows are `{json, application/json, fields}`) and reject a change without a version bump, with the same message pattern as today. This also settles the draft's open question: kind/contentType **query selectors are unnecessary**, because `(schemaId, schemaVersion)` then fixes both. Return them in `Record` and describe output only.

### B4 — The headline example doesn't compile, and its stream source isn't available (must fix)

Three separate problems with the example:

1. **Formatting.** `yield * context.publish(...)` (draft lines 25 and 32) is multiplication. The formatter has mangled a top-level `yield*`. Put examples inside a complete `Task.make(..., (input, context) => Effect.gen(function* () { … }))`.
2. **Error channel.** The draft says stream errors "remain inferred". That is correct, and the probe confirms it, but the handler may only fail with `spec.error | TaskRuntimeError`. So `yield* context.publish("archive", fs.stream(path))` is a **compile error** until the author maps `PlatformError`. That is the right typed outcome, but the doc must show the mapping (`Stream.mapError(e => new ArchiveFailed({ … }))`, or `Effect.mapError` on the publish) and say that the resulting diagnostic lands on the handler, not on the publish call.
3. **Missing FileSystem.** "Consumers use ordinary Effect FileSystem adapters" suggests that `FileSystem.FileSystem` exists for handlers. It does not. The host provides no implementation, and only `effect/*` is externalized. An author must either bundle `@effect/platform-bun` and `.provide(BunFileSystem.layer)`, which is untested against the host's externalized `effect`, or use `Stream.fromReadableStream({ evaluate: () => Bun.file(p).stream(), onError })`, which is also untested in-daemon.

Fix: pick one supported, runnable source idiom for the presentation and mark it tested only after a probe. Recommendation: do **not** add a host-provided `FileSystem` in this slice; that is a capability decision for the user, separate from binary outputs. Show (a) the `Uint8Array` case, (b) the `Stream.fromReadableStream` case with an explicit error mapping, and (c) text output via `Stream.encodeText`, since CSV/log text will be the most common consumer case.

### B5 — `Task.test`'s publication record shape is unspecified (must fix)

"Provides a copied byte value on its publication record" leaves the public type open, and every task test reads it. Today `TestPublication.value: Schema.Json`.

Fix: make `TestPublication` discriminated on `kind`:

```ts
// PROPOSED
type TestPublication =
  | { kind: "json"; output; reference; tags; value: Schema.Json }
  | {
      kind: "bytes";
      output;
      reference;
      tags;
      contentType: string;
      bytes: Uint8Array;
    };
```

Use `bytes`, not an overloaded `value`, so that `toEqual(publication.value, …)` cannot accidentally compare a buffer against JSON. Existing JSON tests keep compiling only if they narrow; say so honestly (a TS break for code that reads `.value` without checking `output`). Alternatively, keep `value` and type it `Schema.Json | Uint8Array`, which is less breaking and less clear. Recommend the discriminant. Use a real sha256 digest for bytes. The test's JSON digest remains fake, so state that difference rather than implying "same digest" for both. Keep the same 64 MiB cap: a smaller harness cap would make a passing production task fail in tests, which is the worse mismatch.

## Should fix

- **S1 — Daemon memory bound for finite `Uint8Array`.** Copying at evaluation start doubles peak memory. With `activeTaskHandlers: 32`, worst case is about 32 × 64 MiB × 2 = 4 GiB resident. Either gate concurrent binary publications with a small permit (e.g. a `Semaphore` scoped to the lake Layer), or cap the finite-array path lower and steer large content to streams. State the bound in the doc.
- **S2 — The dedupe path re-reads whole blobs into memory.** On an identical retry or shared content, existing `atomicBlob` does `readFileSync` plus a hash of the existing blob. For 64 MiB that is a hidden full read into memory per dedupe. Specify streaming verification, or trust digest-named immutable blobs (verified at install) and verify only on download.
- **S3 — `lake get` must check kind from metadata before `readFileSync`.** Otherwise a 64 MiB read precedes the InvalidInput error. Call it out because the current code reads content first.
- **S4 — Drop server-side pre-verification before streaming.** The CLI must verify digest and length anyway before installing, and pre-verification is TOCTOU and costs a second full read. Hash while streaming on the server and fail the stream at the end on mismatch. Document for RPC consumers that content is valid only when the stream completes successfully. This roughly halves download I/O and simplifies the server.
- **S5 — Advertise the new limit.** Add `limits.binaryArtifactBytes: 67_108_864`, keep `artifactBytes` meaning JSON, and name the download frame size. Use a capability name consistent with existing ones: `lake.bytes.v1` rather than `binary-artifacts.v1`.
- **S6 — Discoverability.** `task describe` does not list outputs at all, so "describe/plan distinguish JSON and bytes" has nothing to extend for tasks. Add `outputs: { name: { id, version, kind, contentType? } }` to task describe. This is small and highly useful. Document the find-then-download path: return the reference in the task's success value (`run outputs` shows `artifactId`/`version`), or `lake query` with `metadata: runId`, then `lake download`. No new "artifacts of a run" command.
- **S7 — `contentType` grammar.** Specify validation (RFC 6838 `type/subtype`, lower-cased, ≤127 chars) and whether parameters such as `; charset=utf-8` are allowed. Recommend disallowing parameters in v1; `text/csv` implies UTF-8 by convention. MIME is part of the B3 descriptor, so normalization matters.
- **S8 — Old host, new SDK.** At runtime the SDK comes from the host. A project on the new SDK running on an old daemon hits "binary outputs are not implemented" at definition load. That is acceptable, but the doc should name it and rely on the existing SDK-skew warning.
- **S9 — Disk growth.** At 64× the JSON cap and with no GC, a loop publishing 1,000 keys can write 64 GiB. Don't expand into retention, but state plainly that lake growth is unbounded in this slice. Consider a per-attempt publication count cap if one doesn't exist (I found none).

## Recommended resolutions of the draft's open questions

- **`Artifact.make({ kind: "bytes", … })` vs `Artifact.bytes` vs a content descriptor:** keep one `make` with a required literal `kind: "bytes"` for bytes, and allow an optional `kind: "json"` in the JSON form for symmetry. A second constructor name adds no type safety; the probe shows the overloads discriminate cleanly. I considered discriminating on the presence of `contentType` vs `schema` (less syntax) and rejected it: an explicit literal yields clearer overload diagnostics and reads unambiguously in describe output and diffs. A nested content descriptor (`content: { kind, type }`) is extra nesting with no current second field. Extension reuse works unchanged, since canonicality is object identity and a bytes definition exported by an extension is shared exactly like a JSON one. With B3 in place, drift across revisions is caught in the lake as well.
- **One `publish` vs `publishBytes`:** keep one method. Both typing designs worked in the probe. Prefer the overload form (B): its diagnostics name the expected value type per output kind, while the conditional form can collapse to `never` in messages. That claim is untested and should be confirmed on hover in the real `Task.make`.
- **Explicit context vs DI:** keep `context.publish`. A `Publisher` service from DI cannot be parameterized by the specific task's `outputs` without a per-task tag, so it would trade compile-time "this output exists and takes bytes" for ambient access. DI remains right for **sources** (FileSystem, HTTP), which is where B4 lands. Scope ownership of the temporary writer per publish call, with no writer across suspension, is correct as drafted.
- **Kind/contentType selectors:** don't add them (see B3).
- **Binary stdout:** agree to defer it. Receipt-only JSON output is right.
- **No-overwrite:** keep it, with the B2 mechanism and the optional identical-content success.
- **Streaming errors:** source errors stay typed through `publish`. A cap overrun is `TaskRuntimeError("LimitExceeded")`. Interrupt or a deadline cleans up the temp file. Download stream errors are `OperationError`, and the CLI never installs on any error. All as drafted, plus B4 item 2.

## Honest Swamp comparison (for the doc's gap statement)

What this slice matches: declared file outputs with a static content type; whole-content and streamed writes; immutable versions with digest and size; tag and provenance metadata; and retrieval by version, plus a real download path with integrity checks that Swamp's `data get` does not emphasize.

What it does not match: incremental `writeLine` and live `onLine` tailing (visibility here is only at completion); per-write `contentType` override; `lifetime`/`garbageCollection`; deferred writes; vault/sensitive output; default-to-latest reads. The doc should list these in one place, as it already partly does, without promising them.

## Required-proof additions

Add the B2 destination race, the B3 kind/MIME drift rejection, the S1 concurrent-array memory bound, the B5 discriminated test record, the `lake get` on bytes failure without a content read, and one compiled end-to-end handler using the chosen B4 source idiom with a mapped error.
