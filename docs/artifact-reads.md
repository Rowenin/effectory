# Reading artifacts in tasks and reports

Yield `ArtifactReader` in an Effect program. The runner supplies it to the handler and task-local Layers. A reusable helper keeps `ArtifactReader` in its requirements; `Task.make`, `Task.implementation` and `.provide` remove that runner-owned requirement from the task exposed to the application.

```ts
import {
  ArtifactReader,
  ArtifactReadError,
  ArtifactUnavailable,
  Task,
} from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

const Read = Task.make(
  {
    id: "read-measurement",
    version: 1,
    input: Measurement.refSchema,
    success: Schema.Int,
    error: Schema.Union([ArtifactReadError, ArtifactUnavailable]),
    replay: "idempotent",
  },
  (reference) =>
    Effect.gen(function* () {
      const reader = yield* ArtifactReader;
      const value = yield* reader.get(Measurement, reference);
      return value.count;
    })
);
```

`Measurement` is the artifact definition in the [complete application](../examples/artifact-reads/effectory.ts). That example publishes and reads within a graph and declares retry only for `ArtifactUnavailable`.

| Method | Result |
| --- | --- |
| `get(JsonArtifact, ref)` | Schema-decoded JSON value |
| `stream(BytesArtifact, ref)` | Effect Stream of byte chunks; integrity checked at EOF |
| `bytes(BytesArtifact, ref)` | Entire verified `Uint8Array`, up to 16 MiB |
| `metadata(Artifact, ref)` | Exact version metadata and retention protection |
| `latest(Artifact, { taskId, output, key })` | Protected exact reference to the newest retained version of that publication identity |
| `query(Artifact, { versions, ... })` | One page containing references, metadata and optional projections |

`ArtifactQuery.stream(Artifact, options)` traverses query pages lazily. Query options reuse the lake grammar: `versions` is required (`"all"` or `"latest"`), `limit` defaults to 50 (maximum 200), with optional `where`, `orderBy`, `select` and `cursor`. The stream helper owns the cursor; it never silently restarts an expired query. Queries run fresh on each attempt. Save chosen references in an upstream durable task result when retries must use the same selection.

Definitions determine decoded types and literal schema IDs. Reads validate schema version, kind, MIME type and digest at runtime. `latest(V1, identity)` fails `SchemaMismatch` if the newest retained version has schema V2; a V1 query with `versions: "latest"` omits that identity. Neither falls back to an older V1. Query rows do not include the publication key.

`ArtifactUnavailable` has transient `Busy` and `Storage` reasons. Add it to a task's error schema and `retry.when` to retry. `ArtifactReadError` covers permanent read/query failures, including `Reclaimed`, `SchemaMismatch`, `DigestMismatch`, `DecodeFailed`, `PinLimit`, `ConcurrencyLimit` and `Closed`. Errors contain safe identifiers and fixed messages; codec defects and schema issue text are discarded. Asynchronous service-free JSON decoding is supported. Declared reader errors also remain typed during task-local Layer construction.

## Retention and lifetime

A successful exact resolution through get, metadata, latest or a binary read protects that version for the consumer run before exposing content. Protection survives retries, waits, NeedsAttention and daemon restart, and ends when the consumer run is terminal. The cap is 1,024 distinct external versions per run; repeat reads do not use another position. Same-run publications are already protected. Reporters reading their own source publications are exempt while an unsettled report obligation protects that source.

References in inputs and query results are **not** protected merely by being present. Acquire before a wait: have an upstream task call `metadata` and return the reference, then put the approval/input/signal node after that task. A version can disappear between discovery and first access. Failed decoding after a successful resolution retains a conservative pin.

Pending report obligations protect source publications before report runs are admitted. Settled reports release that protection. A later report retry cannot restore already reclaimed content. Reclamation plans show `protectedBy`; version pages show producer, consumer and report protection. Apply re-checks all protection in its write transaction, including pins created after the plan. There is no force-delete bypass. The later [automatic-retention feature](automatic-artifact-retention.md) applies the same protections when explicitly enabled; it remains off by default.

Reader handles and streams belong to an invocation. Shutdown rejects new reads, fails active streams with `Closed`, interrupts owned work and awaits cleanup before task-local Layers release. Taking only part of a stream does not verify its digest; use `bytes` when content must be verified before use.

## Binary scheduling

Binary readers and **every** binary publisher share four invocation slots across the daemon. A publication acquires its invocation slot before its writer permit, allowing its source stream to read using that same slot. This avoids read/write pool inversion during copies. Long reads can delay previously existing publish-only tasks, and queue time counts against attempt deadlines.

Each invocation has four concurrent binary read positions. Additional reads wait while a finite whole-bytes read or pending reservation can finish independently. If all four positions are open streams, another read fails `ConcurrencyLimit`; close a stream before requesting another. JSON reads, metadata, latest and queries do not use binary slots. Streams are not preempted. Arbitrary application dependency cycles, including nested writes consuming every writer permit, remain the author's responsibility.

## Tests

```ts
const example = Effect.gen(function* () {
  const fixture = yield* Artifact.fixture(
    Measurement,
    { count: 42 },
    { taskId: "collector", output: "measurement", key: "daily" }
  );
  return yield* Task.test(Read, {
    input: fixture.reference,
    artifacts: [fixture],
  });
});
```

Fixtures accept decoded JSON or `Uint8Array` and compute real content digests. `Task.test` exposes its own publications to the reader and returns an `artifacts` collection. Feed that collection to the next test, including when testing a second producer; do not concatenate independent collections with colliding synthetic references. Existing synthetic test publication references remain unchanged. `Report.test` forwards the same `artifacts` option; set fixture `runId` when testing source-run queries.

Fixture defaults are task `fixture`, output `value`, key equal to the artifact definition ID, version 1, empty tags and deterministic timestamps. Use distinct keys or increasing versions for multiple fixtures of one identity. Each default timestamp follows the greatest earlier timestamp by one millisecond. Explicit timestamps must be canonical ISO strings, and version histories cannot move backwards. Content is copied independently from public test publication records.

Tests share decoding, query semantics, local read limits and the four-writer bound with production. They do not simulate persistent pins, competing invocations, SQLite contention or restart. An ordinary `Task.provide(Layer.succeed(ArtifactReader, fake))` replaces the default reader; that fake is responsible for its own behavior.

Restart the daemon on the updated build to activate the new SDK modules and storage migration. CLI `lake get`, `lake download` and `lake query` remain operator interfaces. This adds no SQL/DuckDB, configured model names or remote content backend.
