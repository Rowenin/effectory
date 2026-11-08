/* oxlint-disable unicorn/consistent-function-scoping -- Queue shutdown callback belongs to each stream scope. */
import { Cause, Effect, Fiber, Option, Queue, Schema, Stream } from "effect";

import {
  ArtifactReadError,
  ArtifactUnavailable,
  readFailure,
} from "./artifact-read-errors.ts";
import type { ReadError } from "./artifact-read-errors.ts";
import type {
  Identity,
  Metadata,
  Page,
  QueryOptions,
  Service,
} from "./artifact-reader.ts";
import type * as Artifact from "./artifact.ts";
import type { BinaryOwner } from "./binary-admission.ts";

export interface ReaderBackend {
  readonly resolve: (
    artifact: Artifact.Any,
    reference: Artifact.Reference
  ) => Effect.Effect<Metadata, ReadError>;
  readonly latest: <A extends Artifact.Any>(
    artifact: A,
    identity: Identity
  ) => Effect.Effect<A["refSchema"]["Type"], ReadError>;
  readonly query: <A extends Artifact.Any>(
    artifact: A,
    options: QueryOptions
  ) => Effect.Effect<Page<A>, ReadError>;
  readonly json: (metadata: Metadata) => Effect.Effect<Schema.Json, ReadError>;
  readonly stream: (metadata: Metadata) => Stream.Stream<Uint8Array, ReadError>;
}
export const referenceFor = (record: Metadata): Artifact.Reference => ({
  artifactId: record.artifactId,
  digest: record.digest,
  schemaId: record.schemaId,
  schemaVersion: record.schemaVersion,
  version: record.version,
});
export function checkReference(
  artifact: Artifact.Any,
  ref: Artifact.Reference,
  record: Metadata,
  synthetic = false
) {
  if (
    record.artifactId !== ref.artifactId ||
    record.version !== ref.version ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 0 ||
    record.bytes > (record.kind === "json" ? 1_048_576 : 16_777_216) ||
    (!/^[a-f0-9]{64}$/u.test(record.digest) &&
      !(synthetic && /^test-digest-[1-9][0-9]*$/u.test(record.digest)))
  ) {
    throw readFailure("Corrupt", ref, synthetic);
  }
  if (record.kind !== artifact.kind) {
    throw readFailure("KindMismatch", record, synthetic);
  }
  if (
    record.schemaId !== artifact.id ||
    record.schemaVersion !== artifact.version ||
    record.contentType !== artifact.contentType ||
    ref.schemaId !== record.schemaId ||
    ref.schemaVersion !== record.schemaVersion
  ) {
    throw readFailure("SchemaMismatch", record, synthetic);
  }
  if (record.digest !== ref.digest) {
    throw readFailure("DigestMismatch", record, synthetic);
  }
}

/** Isolated owned children prevent codec defects from reaching durable task exits. */
export function readerRuntime(backend: ReaderBackend, owner: BinaryOwner) {
  let closed = false;
  const children = new Set<Fiber.Fiber<unknown, unknown>>();
  const streams = new Set<() => void>();
  const run = <A, E>(
    body: Effect.Effect<A, E>,
    decoding = false
  ): Effect.Effect<A, ReadError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (closed) {
          return yield* readFailure("Closed");
        }
        const child = yield* Effect.forkDetach(restore(body));
        children.add(child);
        const result = yield* restore(Fiber.await(child)).pipe(
          Effect.onInterrupt(() => Fiber.interrupt(child).pipe(Effect.asVoid)),
          Effect.ensuring(Effect.sync(() => children.delete(child)))
        );
        if (closed) {
          return yield* readFailure("Closed");
        }
        if (result._tag === "Success") {
          return result.value;
        }
        if (!decoding) {
          const error = Cause.findErrorOption(result.cause);
          if (
            Option.isSome(error) &&
            (error.value instanceof ArtifactReadError ||
              error.value instanceof ArtifactUnavailable)
          ) {
            return yield* error.value;
          }
        }
        return yield* readFailure(decoding ? "DecodeFailed" : "Corrupt");
      })
    );
  const content = (
    artifact: Artifact.Bytes,
    ref: Artifact.Reference,
    finite: boolean
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (artifact.kind !== "bytes") {
          return yield* readFailure("KindMismatch", ref);
        }
        const record = yield* backend.resolve(artifact, ref);
        // The potentially blocking wait is interruptible; only finalizer registration is masked.
        const reservation = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const acquired = yield* restore(owner.read(finite));
            yield* Effect.addFinalizer(() => Effect.sync(acquired.release));
            acquired.open();
            return acquired;
          })
        );
        void reservation;
        return backend.stream(record);
      })
    );
  const service: Service = {
    bytes: (artifact, ref) =>
      run(
        Effect.gen(function* () {
          const chunks = yield* Stream.runCollect(content(artifact, ref, true));
          const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
          const result = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
          }
          return result;
        })
      ),
    get: (artifact, ref) =>
      run(
        Effect.gen(function* () {
          if (artifact.kind !== "json") {
            return yield* readFailure("KindMismatch", ref);
          }
          const record = yield* backend.resolve(artifact, ref);
          const value = yield* backend.json(record);
          return yield* run(
            Effect.suspend(() =>
              Schema.decodeUnknownEffect(artifact.schema)(value, {
                onExcessProperty: "error",
              })
            ),
            true
          );
        })
      ),
    latest: (artifact, identity) =>
      run(Effect.suspend(() => backend.latest(artifact, identity))),
    metadata: (artifact, ref) =>
      run(Effect.suspend(() => backend.resolve(artifact, ref))),
    query: (artifact, options) =>
      run(Effect.suspend(() => backend.query(artifact, options))),
    stream: (artifact, ref) =>
      Stream.callback<Uint8Array, ReadError>(
        (queue) =>
          Effect.gen(function* () {
            if (closed) {
              return yield* readFailure("Closed");
            }
            const stop = () => {
              Queue.failCauseUnsafe(queue, Cause.fail(readFailure("Closed")));
            };
            streams.add(stop);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => streams.delete(stop))
            );
            yield* Effect.forkScoped(
              run(
                Stream.runForEach(content(artifact, ref, false), (chunk) =>
                  Queue.offer(queue, chunk)
                )
              ).pipe(
                Effect.matchEffect({
                  onFailure: (error) => Queue.fail(queue, error),
                  onSuccess: () => Queue.end(queue),
                })
              )
            );
          }),
        { bufferSize: 1 }
      ),
  };
  return {
    close: Effect.uninterruptible(
      Effect.suspend(() => {
        closed = true;
        for (const stop of streams) {
          stop();
        }
        return owner.close.pipe(
          Effect.andThen(Fiber.interruptAll([...children]))
        );
      })
    ),
    owner,
    reader: service,
  };
}
