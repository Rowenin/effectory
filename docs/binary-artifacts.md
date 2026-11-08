# Binary artifacts

Declare a bytes artifact, list it as a task output, and publish through the runner-provided Effect service:

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

export const ExportCsv = Task.make(
  {
    id: "report/export",
    version: 1,
    input: Schema.Void,
    success: Csv.refSchema,
    error: Schema.Never,
    replay: "idempotent",
    outputs: { csv: Csv },
  },
  () =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      const rows = Stream.make("name,count\n", "example,42\n").pipe(
        Stream.encodeText
      );
      return yield* storage.publish(Csv, rows, { key: "summary" });
    })
);
```

A finite Uint8Array uses the same call. Zero bytes are valid. Streams preserve their error and service requirements; task handlers must handle source failures or map them into their declared error. Provide file or HTTP sources through ordinary Layers. An application's FileSystem adapter, for example `BunFileSystem.layer` from `@effect/platform-bun/BunFileSystem`, belongs on `Task.provide`. The host does not supply an implicit FileSystem to author code.

Each publication consumes its source when its Effect runs. Recreate the source inside each attempt and keep supplied buffers unchanged during consumption. A retry using the same invocation/output/key must produce identical bytes and tags; changed content fails PublicationConflict. A later run using the same task/output/key creates another version. Publication is available during task-local Layer acquisition and the handler, and closes before Layer finalizers. Interruption awaits writer cleanup.

Bytes are capped at 16 MiB, JSON at 1 MiB. Four daemon-wide writers can be active; additional writers wait within their task deadline. There is no total storage quota. [Automatic policy collection](automatic-artifact-retention.md) is available as an explicit repository opt-in and is off by default. Retention and operator reclamation apply to either kind. Kind and content type are fixed per artifact schema id/version. MIME types are normalized to lowercase and must be ASCII type/subtype without whitespace, wildcards or parameters; use `text/csv`, not `text/csv; charset=utf-8`.

## Reading and reclaiming

```sh
effectory run outputs <run-id> --json
# Use artifactId/version from the task's returned reference.
effectory lake download <artifact-id> --version 1 --output ./report.csv
effectory lake reclaim plan --schema report/csv --older-than "30 days" --json
# Inspect the plan, then apply its ID.
effectory lake reclaim apply <plan-id> --json
```

The download command requires an exact version and an output file. It verifies length and SHA-256 before installing with a hard link. Existing files and symlinks are never overwritten; stdout is unsupported. Repositories and download destinations require hard-link support. JSON continues to use `lake get`.

The capability `lake.bytes.v1` advertises `LakeDownload({ artifactId, version })`: a stream of one Metadata frame followed by Bytes frames, over authenticated NDJSON Effect RPC at `/rpc/content`. All bytes are provisional until successful completion and digest/length verification. Four active download producers are allowed; another request fails LimitExceeded. There is no download idle timeout. Permits bound producers, not bytes already buffered by the socket.

On supported macOS/Linux systems, an already-open download finishes after reclamation unlinks its content. New reads fail NotFound. Disk blocks remain allocated until the open descriptor closes; a stalled active download can hold them until disconnect or daemon shutdown. Reclamation receipt semantics are unchanged.

## Tests and adapters

```ts
const inspect = Effect.gen(function* () {
  const result = yield* Task.test(ExportCsv, { input: undefined });
  const publication = result.publications[0];
  if (publication?.kind !== "bytes") throw new Error("Expected bytes");
  return {
    text: new TextDecoder().decode(publication.bytes),
    byteLength: publication.byteLength,
    sha256: publication.sha256,
  };
});
```

JSON records have `kind: "json"` and `value`; bytes records have `kind: "bytes"`, `bytes`, `contentType`, `sha256`, and `byteLength`. Narrow on kind before reading JSON values. Test reference digests remain synthetic: assert binary content against sha256 instead. The same per-artifact size cap applies, but the harness retains publications in memory for assertions.

A custom ArtifactStorage Layer replaces both persistence and Task.test recording. It must consume byte sources and preserve errors and finalizers; a fake that ignores its value may still typecheck. Low-level RuntimeContext adapters can add the optional publishBytes hook. Existing JSON-only adapters remain valid and reject bytes with an explicit InvalidBoundary error.

## Recovery and limits

New content becomes visible only after the complete stream, content fsync, installation and metadata commit. Persisted intents recover failed installations without deleting retained or unproven shared content. Startup finishes binary recovery before readiness, and fails with the cause if recovery cannot finish. Builtin backup refuses staging without mutating the source; start then stop the daemon before retrying.

The builtin snapshot limit remains 1 GiB across the whole repository. See [backup and offline-copy instructions](backup-restore.md) for larger repositories. If the disk is completely full, free space outside Effectory first: reclamation itself needs SQLite write space. No general orphan sweep is included. Explicitly enabled automatic retention can collect policy-eligible older versions. Windows, live tailing, incremental file visibility and implicit latest-version reads remain outside this slice.
