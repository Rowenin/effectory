import { Context, Effect, Layer, Schema, Stream } from "effect";

import {
  Application,
  Artifact,
  ArtifactQuery,
  ArtifactReader,
  ArtifactReadError,
  ArtifactUnavailable,
  Task,
} from "../src/index.ts";

const Json = Artifact.make({
  id: "typed-json",
  schema: Schema.Struct({ count: Schema.Int }),
  version: 1,
});
const Bytes = Artifact.make({
  contentType: "application/octet-stream",
  id: "typed-bytes",
  kind: "bytes",
  version: 1,
});
const Other = Artifact.make({
  id: "other-json",
  schema: Schema.String,
  version: 1,
});
const Dependency = Context.Service<string>("test/ReaderDependency");

/** Compile-only proof; deliberately invalid calls below are never executed. */
export function readerTypes(
  reference: typeof Json.refSchema.Type,
  bytesReference: typeof Bytes.refSchema.Type
) {
  const helper: Effect.Effect<
    { readonly count: number },
    ArtifactReadError | ArtifactUnavailable,
    ArtifactReader
  > = Effect.gen(function* () {
    const reader = yield* ArtifactReader;
    const value = reader.get(Json, reference);
    // @ts-expect-error A bytes definition cannot be decoded with get.
    const wrongGet = reader.get(Bytes, bytesReference);
    void wrongGet;
    // @ts-expect-error A JSON definition cannot be streamed as bytes.
    const wrongStream = reader.stream(Json, reference);
    void wrongStream;
    // @ts-expect-error Literal schema identifiers do not widen from the reference.
    const wrongSchema = reader.get(Other, reference);
    void wrongSchema;
    // @ts-expect-error Version selection is required for queries.
    const wrongQuery = reader.query(Json, {});
    void wrongQuery;
    const wrongCursor = ArtifactQuery.stream(Json, {
      // @ts-expect-error The stream helper owns pagination.
      cursor: "cursor",
      versions: "all",
    });
    void wrongCursor;
    const binary: Stream.Stream<
      Uint8Array,
      ArtifactReadError | ArtifactUnavailable
    > = reader.stream(Bytes, bytesReference);
    const verified: Effect.Effect<
      Uint8Array,
      ArtifactReadError | ArtifactUnavailable
    > = reader.bytes(Bytes, bytesReference);
    void binary;
    void verified;
    return yield* value;
  });
  const task = Task.make(
    {
      error: Schema.Union([ArtifactReadError, ArtifactUnavailable]),
      id: "typed-reader",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.String,
      version: 1,
    },
    () => Dependency
  );
  const provided = task.provide(
    Layer.effect(
      Dependency,
      helper.pipe(Effect.map((value) => String(value.count)))
    )
  );
  const application = Application.make({
    tasks: [provided],
  }) satisfies Application.Application<never>;
  // @ts-expect-error Fixtures accept decoded JSON values.
  const wrongFixture = Artifact.fixture(Json, { count: "wrong" });
  void wrongFixture;
  // @ts-expect-error Bytes fixtures accept arrays, not streams.
  const wrongBytes = Artifact.fixture(Bytes, Stream.succeed(new Uint8Array()));
  void wrongBytes;
  return { application, helper };
}
