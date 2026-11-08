# Binary artifact outputs — proposal for review

Status: **user-approved and implemented**. The user approved revision 8's authoring API, streaming RPC/CLI, size/concurrency limits, POSIX reclamation and backup behavior. The [Claude consumer review](binary-artifacts-review-consumer-round4.md) and [Claude Effect review](binary-artifacts-review-effect-round4.md) are resolved. The design and review history below are retained as the implementation contract; implementation evidence is recorded in [implementation status](implementation-status.md).

The user approved retention/reclamation and selected it as a prerequisite to binary shipping. That implementation passed typecheck, lint/format and all 209 tests. This revision keeps the reviewed bytes constructor, yielded storage service and exact-version download shape, but replaces the obsolete no-reclamation storage gate with manual reclamation and explicit backup limits. It specifies descriptor-owned downloads and crash-recoverable binary installations below. These are proposal decisions, not new authorizations.

## Authoring correction from the user

The user has replaced the proposed `context.publish` authoring surface with a yielded `ArtifactStorage` service. [The implemented DI contract](artifact-storage.md) defines the approved JSON call shape, declared-output checks and Layer lifetime. Publication opens during Layer acquisition and the handler, and closes before task-local finalizers. The examples below now use that service. The remaining binary/storage decisions are still proposals, not approved implementation scope.

## Implemented retention prerequisite

The user selected retention/reclamation before binary artifacts ship. The bounded binary version without a reclamation command is therefore not the selected shipping path. The [retention contract](artifact-retention-api-draft.md) is now approved and implemented for JSON artifacts. The byte limits and streaming ownership behavior below remain proposals to revisit before binary implementation.

Both JSON and bytes definitions accept the already-approved `retention: { maxVersions?, maxAge? }`. Binary publications capture the normalized policy in the same lake rows. Existing `lake reclaim plan/apply` and `lake versions --include-reclaimed` operate on either kind, with the same newest-version protection, unfinished-producer protection, whole-identity ranking and manual operator overrides.

The remaining streaming dependency is addressed under "Reclamation and live operations": active downloads own an open file descriptor through Effect Scope; merely holding a historical reference does not preserve content. No in-run storage reader or public pin/lease service is added.

## Source and gap

Swamp distinguishes schema-backed resources from file outputs: `vendor/swamp/src/domain/models/model.ts:68–104` declares file content type, lifetime, collection, streaming and tags. `MethodContext.createFileWriter` is at line 221. `vendor/swamp/src/domain/models/data_writer.ts:165–260` provides byte/text/stream writes. `vendor/swamp/design/primitives/data.md` describes immutable versions, file metadata and catalog queries.

Effectory's `Artifact.make` accepts JSON schemas and explicitly rejects binary options. `Task.contextFor` Schema-encodes publications and applies the JSON budget; `Lake.get` parses JSON. The content-addressed lake and publication receipts already provide immutable identity and tag/provenance queries. This slice adds arbitrary byte content and reuses the implemented manual reclamation path; it does not add automatic collection, live tailing or secret redaction. It is not complete Swamp file parity.

## Proposed consumer surface

Keep the spec constructor and existing JSON form. Add a discriminated binary overload:

```ts
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Artifact, ArtifactStorage, Task } from "@offtree/effectory-sdk";
import { Effect, FileSystem, Schema, Stream } from "effect";

class ArchiveFailed extends Schema.TaggedError<ArchiveFailed>()(
  "ArchiveFailed",
  { message: Schema.String }
) {}

const Archive = Artifact.make({
  id: "release/file",
  version: 1,
  kind: "bytes",
  contentType: "application/octet-stream",
  retention: { maxVersions: 3 },
});

const ArchiveFile = Task.make(
  {
    id: "archive-file",
    version: 1,
    input: Schema.Struct({ path: Schema.String }),
    success: Archive.refSchema,
    error: ArchiveFailed,
    replay: "idempotent",
    outputs: { archive: Archive },
  },
  ({ path }) =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      const fs = yield* FileSystem.FileSystem;
      const chunks = fs
        .stream(path)
        .pipe(
          Stream.mapError(
            (error) => new ArchiveFailed({ message: error.message })
          )
        );
      return yield* storage.publish(Archive, chunks, { key: "release" });
    })
).provide(BunFileSystem.layer);
```

This explicitly installs the source's FileSystem Layer at task scope. The application must install the pinned `@effect/platform-bun@4.0.5` dependency; its implementation is bundled, while `effect` is shared with the host. No implicit host FileSystem service is added. The same publication call accepts a finite `Uint8Array` instead of `chunks`, within the common byte limit below. Text sources can use `Stream.make("name,value\n", "a,42\n").pipe(Stream.encodeText)` for a `text/csv` output.

A file source's `PlatformError` must be mapped into the task's declared error (as above), or deliberately handled. Otherwise the inferred error appears in the handler and `Task.make` rejects it. Publication preserves the source error and requirements: `Stream<Uint8Array, E, R>` produces `Effect<Reference, E | TaskRuntimeError, R>`.

Keep `Artifact.Artifact<Id, S>` as the existing JSON shape, adding `kind: "json"`; introduce `Artifact.Bytes<Id>` with a validated string `contentType`, and widen output collections to their union. Do not turn the existing `Artifact` generic itself into a union. JSON construction retains `{ id, version, schema, fields?, retention? }`, with optional `kind: "json"`. Bytes construction requires `kind: "bytes"` and forbids `schema` and JSON `fields`. Both retain the existing reference schema and the same optional retention declaration. The single conditional `storage.publish` signature uses the artifact argument to infer its input and reference type. `NoInfer` may guard the JSON value branch only; the bytes branch must infer E and R from the value, including a failing stream source. It uses `<E = never, R = never>` so a finite Uint8Array infers no source error or service requirement; the stream case still infers its E and R. Task output membership is checked at runtime, with an explicit output alias needed only for duplicate artifact aliases. The low-level stream-only hook may use the same defaults for consistency. A generic byte source returns `Effect<Reference, E | TaskRuntimeError, R>`: source requirements, including any Scope, remain inferred as with ordinary Stream runners. Authors can use `Stream.scoped`/`Stream.unwrap` to own source resources or explicitly scope the enclosing Effect. The writer has a separate private Scope. The actual SDK types and replacements still need a feasibility proof.

The file example copies an existing, unchanged byte source; it does not generate a new timestamped archive. Retry identity excludes the attempt, so changed bytes under the same publication key within one invocation (including retries) fail `PublicationConflict`. A later run using the same output/key publishes a new version of that artifact identity. Compression headers, timestamps and changed input files must be made deterministic or captured beforehand. Re-running a single-shot stream/queue can produce empty content; recreate sources inside each attempt and avoid wrapping a previously consumed source in `Effect.retry`. Zero bytes remain valid, so the runner cannot infer that an empty retry was accidental.

A publication accepts a finite Uint8Array or Stream<Uint8Array,E,R>, never a local path, URL, promise or web ReadableStream directly. Consumers explicitly supply ordinary Effect source adapters and their Layers. The verified file-source idiom above uses FileSystem; other adapters need their own error/cleanup handling. The stream is consumed once per publication evaluation and only when the returned Effect runs. Stream errors and requirements remain inferred; schema/runtime failures are TaskRuntimeError. JSON output calls retain their current inference. A finite Uint8Array is normalized to `Stream.succeed(bytes)`, with the same 16 MiB cap and no whole-array snapshot. The caller must keep input buffers unchanged until consumption finishes. Each active writer owns one reusable 64 KiB buffer: copy a source slice into it, hash that owned slice, await writing those exact bytes, then reuse the buffer. Never hash producer-owned memory and asynchronously write from it later. Even a producer that violates the immutability rule may change which bytes get consumed, but cannot make the committed blob disagree with its recorded digest. Retain no source-chunk reference after that chunk is consumed. No silent JSON/base64 reinterpretation in authoring.

The tag work established required per-invocation DI and task-local Layer scopes. ArtifactStorage follows that direction: explicit artifact definitions preserve value/reference types, while membership in the task's declared outputs is checked at runtime before consuming content. Existing JSON `context.publish` remains a legacy adapter to the same active service; binary authoring uses ArtifactStorage. Inject source services through ordinary Layers. A temporary writer is scoped to one publish operation within one task attempt, released on success/failure/interruption; no writer is held across durable suspension. Application Layers must not capture invocation storage.

## Bounded behavior and durability

Proposed limit: **16 MiB per binary artifact**, whether supplied as a Uint8Array or a Stream; JSON retains its current 1 MiB cap. Advertise `limits.binaryArtifactBytes: 16_777_216`. Zero-byte content is valid. Chunk/frame sizes are internal, not separate author limits. The lake Layer owns an Effect Semaphore allowing at most four active binary publications. Acquire a permit before opening a writer; release it on every outcome. Four reusable 64 KiB write buffers bound the runtime's copy workspace to 256 KiB, excluding caller allocations, source buffers, protocol queues and harness records; this is not a whole-process memory bound. Write, hash and count incrementally without collecting streams, and verify existing blobs incrementally on deduplication. Exceeding the artifact cap fails LimitExceeded and removes staging content. A task/global deadline remains necessary for a stream that never produces or completes; this API adds no timeout setting.

Publication becomes visible only after the stream completes, content is fsynced, the blob is installed, and metadata plus publication receipt commit. The stable publication key is run/invocation/output/key. Bytes fingerprints include content digest, schema id/version, tags and the fixed kind/MIME descriptor. Keep existing JSON fingerprints byte-for-byte unchanged, including for old receipts without kind/MIME fields. Descriptor drift is checked independently. Identical retry returns the same reference and changed content or metadata conflicts. Artifact identity remains principal/task/output/key across runs. Changing kind or MIME for an existing schema id/version is rejected independently, as described below. Run tag inheritance and explicit publication precedence remain unchanged. An interrupted publication leaves no visible partial version. Binary staging and installation recovery use persisted intents as described below; Scope cleanup alone is not crash recovery. General discovery of historical JSON orphan blobs remains deferred.

Retries recreate the stream from task code. Byte streams, filesystem handles and scopes are not serialized or replay journals. Only the immutable artifact reference crosses graph/RPC boundaries. `Task.test` accepts the same source and the same 16 MiB byte cap. It consumes the stream through Effect, records copied bytes, and records real sha256 and byteLength fields for binary publications; fake artifact IDs and reference digests stay synthetic for both kinds, preserving the harness convention. Its publication record becomes a discriminated union: common `output`, `reference` and `tags`, then either `{ kind: "json", value: Schema.Json }` or `{ kind: "bytes", value?: never, contentType: string, bytes: Uint8Array, sha256: string, byteLength: number }`. `reference` remains synthetic in Task.test; use `sha256` and `byteLength` for byte-content assertions, not `reference.digest`. The bytes harness fingerprint is `{ sha256, contentType, tags }` under the same output/key, so changed content or metadata conflicts despite synthetic references. The `value?: never` member keeps basic `.value` access compiling, with possible undefined for bytes; code requiring a JSON value must narrow on kind. Adding kind changes whole-record equality assertions. This is an explicit proposed public test-record change. The harness retains bytes for assertions, so 16 MiB is a per-publication bound, not a total-memory bound. Large transfer/resource tests use the real lake.

## Additional authoring and test examples (proposed)

The following is a complete finite/CSV example using the proposed bytes constructor; it is not binary implementation evidence:

```ts
import { Artifact, ArtifactStorage, Task } from "@offtree/effectory-sdk";
import { Effect, Schema, Stream } from "effect";

const Csv = Artifact.make({
  id: "report/csv",
  version: 1,
  kind: "bytes",
  contentType: "text/csv",
  retention: { maxVersions: 3 },
});

const ExportCsv = Task.make(
  {
    id: "report/export",
    version: 1,
    input: Schema.Boolean,
    success: Csv.refSchema,
    error: Schema.Never,
    replay: "idempotent",
    outputs: { csv: Csv },
  },
  (empty) =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      const content = empty
        ? new Uint8Array(0)
        : Stream.make("name,count\n", "sample,42\n").pipe(Stream.encodeText);
      return yield* storage.publish(Csv, content, { key: "summary" });
    })
);

const check = Effect.gen(function* () {
  const result = yield* Task.test(ExportCsv, { input: false });
  const publication = result.publications[0];
  if (publication?.kind !== "bytes") throw new Error("Expected bytes");
  // In a test, assert exact bytes, byteLength and the real sha256.
  return {
    text: new TextDecoder().decode(publication.bytes),
    bytes: publication.byteLength,
    sha256: publication.sha256,
  };
});
```

Zero bytes are valid. MIME parameters such as `text/csv; charset=utf-8` are rejected with a diagnostic saying parameters are unsupported and to use `text/csv`. The source is responsible for text encoding.

**Service fake compatibility:** widening ArtifactStorage also widens every substitute. A contextually typed JSON-only fake may still compile while ignoring byte streams, their errors and their finalizers; an explicitly JSON-constrained generic fake stops compiling. Prefer Task.test for publication tests. A complete substitute must branch on artifact.kind, consume byte streams through ordinary Stream runners, preserve E/R, and decode its synthetic reference with the supplied artifact.refSchema. It replaces persistence and harness recording, including their checks. See the fake example below; do not claim generic method assignment alone proves a substitute is correct.

### A substitute that consumes byte sources (proposed)

This models a standalone fake, not persistence or a digest-verifying test harness. The generic conditional signature and source-error/finalizer preservation were checked with stand-in bytes types against Effect 4.0.5; the real bytes SDK does not exist yet. The two source casts narrow a generic conditional value after the runtime kind check. They do not erase E/R from the returned Effect.

```ts
import {
  Artifact,
  ArtifactStorage,
  TaskRuntimeError,
} from "@offtree/effectory-sdk";
import type { PublishOptions } from "@offtree/effectory-sdk/ArtifactStorage";
import { Effect, Layer, Schema, Stream } from "effect";

type AnyArtifact = Artifact.Artifact | Artifact.Bytes;
type Value<A extends AnyArtifact, E, R> = A extends Artifact.Bytes
  ? Uint8Array | Stream.Stream<Uint8Array, E, R>
  : A extends Artifact.Artifact
    ? A["schema"]["Type"]
    : never;

function fakePublish<A extends AnyArtifact, E = never, R = never>(
  artifact: A,
  value: Value<A, E, R>,
  options: PublishOptions
): Effect.Effect<A["refSchema"]["Type"], E | TaskRuntimeError, R> {
  const consume: Effect.Effect<void, E, R> =
    artifact.kind === "bytes"
      ? Stream.runDrain(
          Stream.isStream(value)
            ? (value as Stream.Stream<Uint8Array, E, R>)
            : Stream.succeed(value as Uint8Array)
        )
      : Effect.void;
  const reference = Schema.decodeUnknownEffect(artifact.refSchema)({
    artifactId: `fake/${options.key}`,
    digest: "fake-digest",
    schemaId: artifact.id,
    schemaVersion: artifact.version,
    version: 1,
  }).pipe(
    Effect.mapError(
      (error) =>
        new TaskRuntimeError({
          code: "InvalidBoundary",
          message: error.message,
        })
    )
  );
  return Effect.andThen(consume, reference);
}

const TestStorage = Layer.succeed(
  ArtifactStorage,
  ArtifactStorage.of({ publish: fakePublish })
);
```

A fake can still be wrong; generic assignment is not proof of correct stream consumption or reference identity. This example deliberately does not implement task-output membership, JSON value validation, limits, persistence or recorded content. Use Task.test for those publication assertions.

## Runtime boundary and attempt ownership

The approved implementation allows publication during task-local Layer acquisition and the handler, then closes before the first task-local Layer releases. Reuse `publicationLifetime` and the per-invocation MemoMap in `task.ts`; do not replace them with a handler-only supervisor. Failed/parallel Layer acquisition, caller interruption and legacy JSON adapter behavior are already covered by tests and remain part of the contract.

Keep the JSON runtime hook and add an optional bytes hook on exported `Task.RuntimeContext`: `publishBytes<E = never, R = never>(name, artifact: Artifact.Bytes, source: Stream<Uint8Array, E, R>, options): Effect<Reference, E | TaskRuntimeError, R>`. This is an additive public runtime-adapter contract. Existing JSON-only adapters remain valid; attempting bytes publication without the hook fails `TaskRuntimeError` with `InvalidBoundary` and explicit binary-runtime guidance. The SDK normalizes finite input to `Stream.succeed(bytes)`; production and Task.test provide the hook. This does not add a second public authoring service.

Build host filesystem services in the daemon Layer and capture their values for internal file operations. Do not provide them around the author's source stream or override its DI. A publication Scope owns staging file handles, the incremental writer and its permit. Convert internal filesystem errors at their own call sites to TaskRuntimeError; preserve the author's stream error E. Keep the metadata/receipt transaction synchronous and small, after asynchronous writing and hashing. Verify existing blobs incrementally.

The existing SDK owner registers publication fibers atomically and links awaiting-caller interruption to child interruption and cleanup. A timeout/race must finish writer cleanup before its caller observes interruption and begins a fallback; a commit that already happened remains durable. Closing rejects new calls, interrupts unfinished children and awaits finalizers before task-local services release. Calls after closure fail InvalidBoundary with `Invocation closed`. The bytes path must use that same owner during Layer setup as well as handler execution. Manually nested source scopes still require authors to await publication within them.

Add a host-owned attempt-active fence to the low-level hooks, closed after task.execute exits and before recording the outcome. Check it with the existing run/lease fence in the metadata transaction. This is defense in depth for custom adapters; it is not a new author capability. Preserve the implemented supervision of JSON publications. Normal completion, domain failure, retry and deadline processing wait for finalizers without a separate finalizer deadline; the existing two-second NeedsAttention policy applies only to stop/cancel fences. Do not promise bounded completion for arbitrary author finalizers.

## Reclamation and live operations — revised recommendation

**Proposed user choice:** on the supported macOS/Linux targets, use POSIX open-file lifetime instead of adding digest leases or changing reclamation receipts. Windows is not currently distributed; this assumption must be revisited before adding it.

A download checks actor ownership and retained metadata and opens the exact blob synchronously in the same non-yielding store section used by reclamation's final reference check/unlink. Effect.acquireRelease owns the opened descriptor in the RPC handler stream Scope, with finalizer registration protected against interruption. Stream from that descriptor, never by reopening the pathname later. Validate the file is regular and its length agrees with metadata; hash and count while streaming. This requires a small native descriptor operation at admission; asynchronous reading and Effect-scoped cleanup follow it.

If reclamation commits first, a new download gets NotFound. If the download opens first, its descriptor continues reading the same bytes after unlink. Subsequent get/query/download calls see the tombstone. Reclamation does not wait for readers and pendingBytes keeps its approved meaning: unresolved cleanup after I/O failure or interruption. No lease outcome, lease-release worker, new receipt field or lease-dependent success behavior is added.

`reclaimedBytes` counts files actually unlinked, as the approved contract defines it. **Disk blocks held by an open download are released only when that descriptor closes.** It is not a measurement of instantly available filesystem space. A stalled download whose producer has not finished can hold its descriptor and reclaimed blocks until the client disconnects or the daemon stops. Four stalled active producers make new downloads fail LimitExceeded until capacity is released. No download idle timeout is added in this slice; ensure an implicit HTTP-server idle timer does not silently contradict this contract on the content route. A fully produced response can instead remain socket-buffered after its descriptor and permit are released. Stopping the daemon interrupts active downloads and closes their descriptors. Test both the file's removal and the reader's byte-identical completion. This observable behavior and POSIX assumption must be presented for user approval, alongside the alternative lease-based receipt amendment from revision 6.

The descriptor belongs to the handler stream Scope, not an outer application Scope or a request-lifetime callback that can outlive the lake. Shutdown interrupts RPC handlers and waits for their file finalizers before releasing repository services. No in-run reader is added. Historical references held by another run do not keep content alive before an actual read opens it; manual collection and unfinished-producer protection stay as approved.

## Binary installation recovery — revised recommendation

Keep a private staged file until the publication metadata/receipt outcome is durable. Its bytes are fully written, hashed and fsynced before installation. Persist an installation intent identifying the exact owned staging file, expected digest/length and enough filesystem identity to determine whether an installed blob came from that file. The intent row commits with synchronous = FULL after staging is written and fsynced, before any link(staging, blob). A staging file without an intent is handled by the dedicated naming-rule cleanup; an installation must never link a blob before its intent is durable. This durable intent is internal; no new administration API or general orphan collector is added.

Verify a preexisting blob incrementally through a descriptor opened in a synchronous store section. Reclamation may unlink that path during verification; the open descriptor remains readable. Keep the verification descriptor open until the final commit section completes, so its inode cannot be reused. At final commit, compare the pathname's lstat (device, inode and regular-file status) with that descriptor's fstat under the non-yielding store section. If missing, install the verified staged file with a no-overwrite hard link and sync the directory. If it still identifies the previously verified file, use it. If it identifies a different file, reopen and verify that file outside the transaction before retrying the commit; do not trust a changed path solely because its name looks like the digest. Re-verification has a finite internal retry bound; exhaustion fails Unavailable. Keep staging until this finishes. A missing path after verification is therefore recoverable without blocking reclamation or pinning a digest.

The final path check/link, run/attempt fences and metadata/receipt transaction occur without yielding, so JSON publication, byte publication and reclamation cannot interleave inside that boundary. Commit the publication record and intent outcome together. Preserve old JSON fingerprints exactly; use a separate bytes fingerprint builder. Name columns in the existing lake_schemas INSERT when adding kind/contentType columns.

On failure or restart, recovery removes an installed blob only if no retained record of either kind references its digest and the staging and blob pathnames are currently the same file: equal device and inode from lstat, both regular files, and link count at least two. A stored inode number alone is never ownership proof. Recheck and unlink without yielding. Preserve an existing shared or unproven blob; never delete it merely because one attempt failed.

Failure cleanup orders operations as **unlink the proven blob → durably resolve the intent → unlink staging**. If ownership cannot be proven, preserve the blob, durably resolve the intent, then unlink only the owned staging file. Successful publication commits the record and intent outcome together before unlinking staging. Thus an unresolved intent always retains its staging file, and each crash point can be retried. A raw filesystem copy that breaks hard-link identity uses the conservative preserve rule; it can leave an unreferenced blob outside this slice's general-GC scope, but must not permanently block startup or backup. A cleanup I/O failure remains retryable. A metadata commit stays authoritative after housekeeping failure; receipt replay must not publish a second version.

Recovery runs on daemon startup under exclusive ownership. It resolves all recorded binary installation intents and abandoned binary staging files, in bounded batches, before daemon start reports ready. If binary installation recovery fails, startup fails and reports the cause; fix permissions or free space and retry, or use the offline-copy fallback below. This rule concerns binary installation recovery only; it does not change the implemented warning-and-continue behavior of ordinary reclamation recovery. Ordinary Scope finalizers close handles and follow the durable cleanup ordering on completion/failure/interruption. Clean regular abandoned files only in the dedicated binary-staging location/naming rule; reject unexpected paths or symlinks. This does not widen cleanup to arbitrary legacy JSON pending files/orphans.

**Proposed backup choice:** builtin backup remains a non-mutating copy. Under exclusive repository ownership, before inventory and source-copy creation, it refuses with Conflict if the dedicated binary-staging directory contains any entry. The recovery invariant covers every unresolved installation intent. This check reads the directory only: backup does not open SQLite, including read-only, and must create or change no -shm or -wal file. Backup reports unfinished installation work and directs the operator to daemon start followed by daemon stop. Daemon startup reports recovery failure and its cause; backup stays refused while staging remains. Ordinary unresolved reclamation intents continue to copy as before; they do not rely on hard-link identity.

Raw offline copies may contain unfinished installation work. Restored recovery compares the current staging/blob paths, never recorded inode numbers. Prefer rsync -aHS to preserve hard links and sparse files, or finish recovery with a clean daemon start/stop before copying. Copies that break hard-link identity can duplicate staging/blob storage and invoke conservative recovery; this caveat applies to raw copies, since builtin backup refuses staging entirely.

Hard-link support is required for bytes publication in the repository as well as final download installation. Unsupported filesystems fail Unavailable with guidance; no unsafe overwrite fallback is added. Native ENOSPC/EDQUOT and SQLite-full failures must become StorageFull. When internal operations use Effect FileSystem, inspect the nested PlatformError cause instead of assuming errno is at the top level; the current mapper needs that internal fix or native errno-preserving adapters.

## Storage and backup limits

Keep the proposed **16 MiB per binary artifact** limit and four active byte writers. JSON keeps its 1 MiB publication limit. Advertise `limits.binaryArtifactBytes: 16_777_216`; stream frame sizes and concurrency implementation details are not additional author limits. Four writers bound their active staging to 64 MiB, excluding already stored blobs and caller buffers. A fifth byte publication waits interruptibly for a daemon-wide permit, and that wait counts against its task deadline. Four stalled sources can therefore block bytes publication for every run until interruption or a deadline releases a slot.

**Revised recommendation for user approval: no new 512 MiB binary-admission gate.** Now that operators can reclaim retained content, an arbitrary fixed lake threshold would add a second disk-full condition and could disable bytes immediately on a healthy, large JSON repository. This revision proposes using ordinary disk-capacity errors (`StorageFull`) and the approved manual policy/selection plans. There is no total storage quota or automatic collector in this slice; neither JSON nor bytes receive a promise of bounded long-term disk usage. Remove the earlier proposed `binaryAdmissionBlobBytes` capability field, usage scanner and incremental quota reservations. Keep per-artifact and concurrency bounds. If reclamation itself fails StorageFull, free space outside the repository first: planning/applying reclamation needs free space for SQLite metadata. Require a byte-write ENOSPC probe proving staged content is released and reclamation succeeds once space is available.

This changes a previous unapproved proposal and must be called out during review/presentation. The alternative remains a fixed bytes-only gate with explicit reclamation guidance, but is not the recommendation. A configurable repository quota would be a separate API rather than a hidden implementation constant.

Backup retains its existing **1 GiB total / 128 MiB per-file / 50,000-entry** limits. Approximately 64 distinct full-size 16 MiB blobs alone reach 1 GiB; databases, bundles and other files reduce that capacity. Reclamation can free content but does not compact historical metadata or extend the backup limit. Repositories above the builtin backup limits can use a verified offline filesystem copy without deleting retained content. Recommendation: retain the builtin limits and document that procedure for this slice. Alternative user choices are a separately reviewed configurable backup/restore limit API or a smaller artifact cap. Do not imply that data deletion is required to make any backup, or that the per-artifact cap guarantees builtin backups succeed. Backup/restore must handle bytes without JSON decoding and include publication, reclamation and installation-recovery state. Verify both a successful binary restore and an honest backup-budget failure without mutation of the source repository.

## Query, RPC and CLI

Add `kind: "json" | "bytes"` and `contentType` to new artifact metadata/description. Persisted/wire schemas accept these as optional keys because old `lake_records` and `ArtifactPublished` event payloads omit them; normalize absent fields to `json` / `application/json` at read edges. New publications always write both. Reject malformed present fields. Assert that old clients tolerate the added fields and new clients read old rows, events and replies. No content predicates for binary data; existing tag/provenance/size filters work. Add kind/contentType columns to `lake_schemas`, defaulting existing rows to JSON/application-json while preserving the current fieldsJson array. Check the complete `{ kind, contentType, fields }` descriptor per schema id/version. Reject kind or MIME changes without a version bump, even when both field sets are empty. No kind/MIME query selectors are added because this descriptor fixes them for each query's schema id/version. MIME is lowercased ASCII, at most 127 characters total, with one `type/subtype` pair whose components match `[a-z0-9][a-z0-9!#$&^_.+-]*`; reject wildcards, whitespace and parameters. A parameter diagnostic names the unsupported parameters and gives a parameter-free example. It describes the bytes rather than validating their file format or encoding. UTF-8 text comes from `Stream.encodeText`, not from assuming a MIME type guarantees UTF-8. Preserve old JSON `LakeGet` shape; a bytes reference passed to it fails InvalidInput **from metadata, before any content read**, naming `effectory lake download <artifactId> --version <n> --output <path>` and saying it requires an upgraded CLI supporting lake.bytes.v1. Add task describe `outputs: { name: { id, version, kind, contentType } }`, since it currently omits outputs. Find a reference in the task success value (`run outputs`) or query lake provenance by runId, then download its exact version.

Propose `LakeDownload({ artifactId, version })` on a separate `ContentPlane` RPC group, served at authenticated **`POST /rpc/content`** with Effect NDJSON framing. The existing `/rpc` ControlPlane remains JSON for compatibility; do not put download there or silently switch its serializer. The client first checks `lake.bytes.v1` through its existing connection, derives the content URL on the same validated loopback origin, and supplies the same bearer/protocol/repository headers. There is no fallback to buffered `/rpc` download.

The proposed public response is a Schema union: `{ _tag: "Metadata", metadata: ArtifactRecord }` followed by `{ _tag: "Bytes", bytes: Uint8Array }` frames, with ordinary RPC success/error completion. `LakeDownload({ artifactId, version })` returns this Stream with OperationError. ArtifactRecord is the existing lake metadata shape; the content metadata frame additionally requires kind = bytes and a valid contentType, with no legacy omissions. The method accepts bytes artifacts only; a JSON artifact fails InvalidInput with guidance to use lake get. The client rejects missing/repeated metadata or byte frames before metadata, verifies final length/digest, and treats an error or incomplete transport as an unsuccessful download.

The content endpoint accepts one bounded request (at most 16 KiB), validates its NDJSON/RPC envelope, method, payload and identity before opening content, and rejects batching/other methods. The route wrapper itself must enforce the 16 KiB byte limit while reading the body, then parse exactly one NDJSON request line, validate it and rebuild a bounded Request for the RPC handler. The RPC server's own `request.text` read is unbounded, so checking after it would be too late. Its middleware must not run the legacy whole-body `.json()` parser, and its dedicated service context must supply NDJSON instead of inheriting the ControlPlane JSON serializer. The stream contains one metadata frame followed by ordered byte frames. Use `Schema.Uint8Array` with Effect's JSON/base64 codec; slice raw bytes to at most 64 KiB and end the handler stream with **`Stream.rechunk(1)`** so each RPC Chunk message contains one logical frame. Without rechunking, three frames can encode as a single 262 KiB line and exceed the parser budget; the reviewer measured approximately 87 KiB lines after rechunking. Use `RpcSerialization.makeNdjson({ maxBufferSize: 131_072 })` on both ends, provided through its ordinary Layer, and `RpcServer.toHttpEffect(..., { streamBufferSize: 4 })`. Verify that metadata and RPC envelopes fit that 128 KiB line budget and that source chunk batching cannot bypass it.

A smaller transport alternative for user discussion is a raw-byte HTTP content response with length/digest metadata, schema-validated request/errors before streaming, connection abort on mid-stream failure, and mandatory client verification. It avoids base64 and NDJSON envelope costs, but introduces a separate HTTP client/response/error contract instead of reusing Effect RPC. The current recommendation remains framed Effect RPC, consistent with the library's RPC-first surface. Neither alternative may use the existing buffered JSON response path; do not implement both in v1.

A four-download admission permit belongs to the HTTP request Scope until its content body stream completes, fails or is aborted. Use Effect's existing scope-transfer behavior; the fetch wrapper's finally is too early. The permit bounds active producers and Effect-side queues, not bytes already handed to Bun/kernel socket buffers or bytes a remote client has yet to consume. Do not claim an end-to-end four-frame memory bound. Open file descriptors separately belong to handler stream Scopes so server shutdown waits for their finalizers before lake shutdown.

A fifth valid download fails promptly with the typed RPC OperationError LimitExceeded (`4 downloads active; retry later`), before opening a file; it does not queue behind stalled clients. The refusal must use the content RPC's error framing, not a mismatched plain-JSON body. An aborted producer closes its file and releases its permit, but the request permit may release before the handler descriptor finishes closing. Tests await both events without assuming their relative order. Required real-socket proofs cover four active producers, fifth-request refusal, cancellation/finalizer ordering, framing and memory under slow readers. Measure queued/socket bytes honestly; a fully produced download may remain buffered in the network after its permit is released.

Hash and count in one server pass; fail on length/digest mismatch. RPC consumers must treat all bytes as provisional until successful stream completion and compare them with announced metadata. The CLI verifies independently before installation. No latest fallback or remote filesystem paths.

Propose CLI `effectory lake download <artifactId> --version <n> --output <path>`, matching the existing `lake` command family and requiring an exact positive version and explicit path. Create a same-directory temporary file exclusively (`wx`, mode 0600), stream and verify it, then fsync it. Install using **hard-link(temp, destination), then unlink(temp)**, not check-then-rename. A concurrent destination creation yields the existing `Conflict` error with a destination-exists message; never overwrite even identical content. Unsupported hard links fail with `Unavailable` and guidance to choose a supported destination filesystem; no unsafe rename fallback and no new AlreadyExists error code. Fsync the directory after installation. The operation's Effect Scope owns temporary-file cleanup on failure/interruption; process death can leave a temporary file, and cleanup is not promised after a crash. If the destination was installed before a late error/reply loss, report honestly; repeating the command finds the existing destination and fails safely.

No binary stdout in this slice. CLI JSON output is a receipt (metadata, path, bytes), never base64 file content. Gate the operation on `lake.bytes.v1` before creating a temporary file. Old JSON commands continue to work against old daemons; a new binary declaration on an old host fails during definition loading under the existing SDK-skew warning. The per-artifact and backup limits above are part of this proposal; the existing manual reclamation commands apply to bytes as well.

### Operator path (proposed bytes commands)

```sh
effectory run outputs <run-id> --json
# Read artifactId and version from the returned task reference.
effectory lake download <artifact-id> --version <n> --output ./release.bin --json
effectory lake reclaim plan --schema release/file --older-than "30 days" --json
# Inspect the exact candidate versions before applying.
effectory lake reclaim apply <plan-id> --json
```

Under the revised recommendation, an already-open download finishes after reclamation unlinks its file. The receipt counts that unlink, while disk blocks remain allocated until the reader closes. New downloads of the reclaimed version fail NotFound. pendingBytes retains its existing failure/interruption meaning. A stalled active producer can retain the descriptor and reclaimed blocks until disconnect or daemon shutdown; a socket-buffered completed response does not. A new CLI is required for lake download; old JSON commands remain supported.

## Source feasibility evidence

A scratch probe on 2026-11-05 loaded an application through the real `revisionCatalogLayer`, with an application-bundled `@effect/platform-bun/BunFileSystem` and host-shared Effect 4.0.5. An existing `Task.make(...).provide(BunFileSystem.layer)` read non-UTF8/NUL bytes exactly via `fs.stream`, and a missing file produced its mapped declared error. A separate `Stream.encodeText` check preserved CSV UTF-8 text. The probe collected bytes only to assert a tiny fixture; it did not implement or test the proposed publisher, compiled executable or memory bounds. Scratch script: `/tmp/effectory-binary-source-probe.mts` (not a permanent project artifact).

The initially suggested `Stream.fromReadableStream({ evaluate: () => Bun.file(path).stream(), onError })` failed the missing-file probe: acquiring its reader threw a defect before the error mapper. It is not the documented file-source path. The consumer review's stand-in TypeScript test demonstrated overload feasibility; the real Task/Artifact types still need validation.

The Effect reviewer reproduced full buffering with `RpcSerialization.layerJson` on pinned Effect 4.0.5, and incremental delivery/cancellation with NDJSON. Local source confirms unframed HTTP uses `Queue.collect` on the server and `response.text` on the client. This is why a genuinely streaming content endpoint is mandatory; the proposed NDJSON implementation and the raw-byte alternative both avoid the buffered ControlPlane path. The related current RunWatch behavior is tracked separately in the runtime research queue; it is not silently changed by this feature.

## Explicit Swamp gaps

This slice omits incremental line writes/live tailing, per-write MIME overrides, automatic lifetime/garbage collection, deferred writes, vault/sensitive-output processing and default-to-latest reads. Manual version/age reclamation is reused from the implemented retention feature. Visibility is only after complete publication; exact-version download follows the existing Effectory lake model.

## Required proofs before implementation acceptance

- Compile positive/negative mixed JSON/bytes declarations, the conditional publish signature, stream errors/services, references and task replacement inference; no hidden `any` leakage. In particular, finite Uint8Array calls must infer E/R as never, not unknown, and unowned source Scope requirements remain visible. A failing stream must infer its own error through publish, with NoInfer applied only to the JSON branch.
- Real Stream acquisition/finalization on success, source failure, cancellation, deadline and retry; one run cannot close another run's resources. A detached publish is interrupted and awaited before its source Layer releases, and both JSON/bytes commits after attempt close fail. Verify source Scope requirements remain visible and can be satisfied with ordinary scoped Stream construction. A caller timeout/race must interrupt and await its writer before a fallback begins; completed commits remain durable.
- Empty/NUL/non-UTF8 content and chunk boundaries preserve exact bytes; byte cap enforcement and bounded-memory behavior.
- Interrupted/crashed publication exposes no partial version; completed publication survives restart and deduplicates; conflicts keep current semantics.
- Shared extension/app binary declarations remain canonical; typed run tags propagate.
- Old JSON rows, published events, replies, fingerprints, queries and backup/restore remain compatible. Bytes work in a JSON repository already larger than 512 MiB. Real disk exhaustion maps to StorageFull. Backup of bytes within budget restores exactly; over-budget backup fails clearly. Recover installation intents after crashes before install, after install and after metadata commit; preserve existing shared blobs and legacy untracked orphans.
- Downloads racing reclamation: an opened descriptor completes byte-identically after unlink, new reads after tombstoning fail NotFound, and pendingBytes/receipt semantics stay unchanged. Test re-linking after reclaim during writer verification, changed-inode re-verification and identical JSON/bytes content. Test crashes before link, after link and after metadata commit, plus conservative recovery after inode identity changes in a raw copy. Run the verification identity race on Linux as well as macOS while retaining the descriptor, and prove finite re-verification failure. Test each recovery crash point: intent committed before link, link before metadata commit, blob unlink before intent resolution, and resolution before staging unlink. Builtin backup must refuse any binary-staging entry without opening SQLite or creating/changing -shm or -wal; normal reclamation intents remain copyable. A backup → restore → daemon-start sequence resolves copied pending reclamation once. Raw copies with and without preserved hard links exercise binary intent recovery separately.
- Download authorization on the separate endpoint, malformed/oversized NDJSON requests and replies, old `/rpc` compatibility, corrupt content with no successful terminal completion, bounded frame sizes including multi-frame upstream chunks after `Stream.rechunk(1)`, real-socket slow-reader backpressure and interruption. Verify the request-Scope permit bounds active producers, the fifth request gets a typed LimitExceeded, and abort closes the file and releases capacity. Prove stopping the daemon during an active download finishes descriptor cleanup before the lake Layer releases. Measure socket buffering separately from Effect queues. Race destination creation against the hard-link install; assert neither an existing file nor symlink is replaced and unsupported hard links fail safely.
- Reject kind/MIME drift for a fixed schema id/version, including JSON→bytes with empty fields; old JSON migration remains readable. `lake get` rejects bytes without reading the blob.
- Test finite arrays and streams at the same 16 MiB boundary, four-publication permit ownership and release, reuse of owned write buffers, and incremental dedup verification. Mutate a producer buffer while a write is pending and assert stored digest/content agreement. Account for producer-owned memory separately.
- Compile the discriminated test-publication record and document necessary narrowing in existing consumers; run the mapped FileSystem source inside a compiled daemon end to end.
- CLI round trip from a real task through daemon restart to byte-identical local file. Document exact limits and the gap from Swamp streaming/live-file capabilities.

Reviewers: resolve contradictions and recommend the smallest coherent API before presentation. Do not change production code, tag implementation, or other agents' files. This draft is not approval to ship the public surface.

## Review history and revision-8 resolution

Earlier reviews agreed on the constructor/publication shape, 16 MiB cap, source-error mapping, explicit author FileSystem Layer and interruption propagation. They evaluated a bytes-only gate before retention was selected; revision 6 deliberately asks for review of removing that gate now that reclamation exists. The remaining Effect corrections are incorporated: generic defaults, rechunking, bounded route reads, separate serialization context, SDK/host ownership and honest finalizer timing.

Two deliberate choices resolve reviewer preferences without widening the public API: retain source R (including Scope), as ordinary Stream runners do, instead of implicitly providing a Scope around author code; and reuse a fixed owned write buffer, rather than hash producer memory before an async write. The latter bounds copying while making content/digest agreement independent of producer mutation. The publication's private file Scope is separate from any author Scope. These remain implementation proof obligations; successful sketches are not tests of a binary implementation.

Round 3 accepted the authoring direction and quota removal for presentation, subject to corrections. Revision 7 applies the consumer compatibility/examples/limits corrections and the Effect transport/error-mapping corrections. It proposes the Effect reviewer's smaller POSIX option, keeping the approved retention receipts unchanged, and chooses non-mutating backup refusal for unfinished binary installations. Both narrow round-4 re-checks are complete. Revision 8 applies consumer R1–R4 (stalled producers, startup readiness/failure, offline-copy instructions and NoInfer) and Effect R1–R3 (held verification descriptor, durable intent/cleanup ordering and filesystem-only backup refusal), plus the optional shutdown/race proofs. The consumer stalled-reader wording is qualified by the Effect review's measured distinction between active producers and completed socket-buffered responses. These are reviewed proposal contracts; their production proofs remain implementation work after user approval.

## Decisions to present to the user

- Bytes authoring and adapters: `Artifact.make({ kind: "bytes", contentType, retention? })`, ArtifactStorage.publish with Uint8Array/Stream, optional low-level RuntimeContext.publishBytes, widened service fakes and a tagged Task.test record with value?: never on bytes.
- Limits: 16 MiB per bytes artifact, four daemon-wide byte writers (wait; task deadline includes wait), four active download producers (fail fast), strict MIME without parameters. No total quota; remove the previously unapproved 512 MiB gate, with honest disk-full recovery guidance.
- Download API: exact-version lake download and framed Effect RPC on the separate content route; raw-byte HTTP remains the smaller transport alternative. No overwrite or stdout. Required hard-link support and POSIX platform assumption must be visible.
- Reclamation: recommend open readers finish after unlink, no receipt amendment. Alternative: digest leases with successful pendingBytes receipts (would amend the approved retention contract and require the revision-6 worker/CLI semantics).
- Backup: recommend refusing unfinished binary installations, keeping the builtin 1 GiB cap and documenting verified offline copying for larger repositories. Alternatives are backup-time recovery (mutating), a separate backup-limit API or a smaller bytes cap.

## Offline filesystem copy procedure

Use the same Effectory build when starting the copy, since pinned revisions depend on the host ABI. Keep the source quiescent throughout copying and verification. Choose a fresh destination outside the source, with a private parent directory. First stop any running daemon; where possible, complete binary installation recovery with a successful start followed by stop:

```sh
effectory daemon stop --repository /path/repo
effectory daemon start --repository /path/repo
effectory daemon stop --repository /path/repo
```

If startup recovery fails, fix the reported cause and retry. An offline copy remains available as a fallback once no daemon owns the source; the copied repository must still recover successfully before it can start. Never copy a running repository.

```sh
mkdir -m 700 /path/copy
printf 'Manual copy incomplete\n' > /path/copy/effectory.snapshot-incomplete
rsync -aHS --exclude=.git --exclude=node_modules \
  --exclude=/.effectory/daemon.json --exclude=/.effectory/daemon.json.tmp \
  --exclude=/.effectory/daemon.log --exclude='/.effectory/state.sqlite.owner*' \
  --exclude=/.effectory/state.sqlite-shm --exclude=/effectory.snapshot.json \
  /path/repo/ /path/copy/
```

Verify the complete included file inventory, SHA-256 and byte length against the unchanged source, excluding the destination-only incomplete marker. Only after successful verification, remove that marker:

```sh
rm /path/copy/effectory.snapshot-incomplete
```

Reinstall application dependencies from the lockfile before starting the copied application or deploying new revisions when it uses packages beyond the host SDK. Start the copied repository directly with --repository /path/copy; this raw copy is not a builtin snapshot manifest for the restore command. This is a privileged, unencrypted copy containing credentials, like builtin backup; verification is the operator's responsibility. Retain the incomplete marker if copying or verification fails.

## Offline-copy feasibility evidence

A scratch probe on 2026-11-05 used a current source daemon, 65 sparse 16 MiB opaque fixture files (1,090,519,040 bytes), real JSON publications, a waiting workflow and a deliberately pending reclamation intent. Builtin backup rejected the 1 GiB budget without changing inventoried source contents. With the daemon stopped, rsync -aS copied the repository excluding runtime endpoint/lock/shared-memory files and generated dependencies; all 74 copied files were checked by SHA-256 and length. The source was moved away, then the copy started on the same host build, resumed the same wait and pinned revision, read its retained artifact, and completed the copied reclamation intent without changing the source. Script: /tmp/effectory-offline-copy-proof.mts; result: /tmp/effectory-offline-copy-proof.log. This validates an offline-copy fallback on current macOS JSON/runtime state, not future binary installation recovery or a Windows procedure.
