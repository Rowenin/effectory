/* oxlint-disable oxc/no-barrel-file */
import { Context } from "effect";
import type { Effect, Schema, Stream } from "effect";

import type * as Query from "./artifact-query-schema.ts";
import type { ReadError } from "./artifact-read-errors.ts";
import type * as Artifact from "./artifact.ts";

export {
  ArtifactReadError,
  ArtifactUnavailable,
} from "./artifact-read-errors.ts";
export type { ReadError } from "./artifact-read-errors.ts";

export interface Identity {
  readonly taskId: string;
  readonly output: string;
  readonly key: string;
}
export interface Metadata extends Query.Record {
  readonly kind: "json" | "bytes";
  readonly contentType: string;
}
export interface Row<A extends Artifact.Any> {
  readonly ref: A["refSchema"]["Type"];
  readonly metadata: Metadata;
  readonly projection?: Readonly<Record<string, Schema.Json>>;
}
export interface QueryOptions {
  readonly versions: "all" | "latest";
  readonly limit?: number;
  readonly where?: Query.Expression;
  readonly orderBy?: Query.Query["orderBy"];
  readonly select?: Query.Query["select"];
  readonly cursor?: string;
}
export interface Page<A extends Artifact.Any> {
  readonly rows: readonly Row<A>[];
  readonly cursor: string | null;
  readonly snapshot: number;
  readonly matched: number;
  readonly scanned: number;
  readonly scannedBytes: number;
}
export interface Service {
  readonly get: <A extends Artifact.Artifact>(
    artifact: A,
    ref: NoInfer<A["refSchema"]["Type"]>
  ) => Effect.Effect<A["schema"]["Type"], ReadError>;
  readonly stream: <A extends Artifact.Bytes>(
    artifact: A,
    ref: NoInfer<A["refSchema"]["Type"]>
  ) => Stream.Stream<Uint8Array, ReadError>;
  readonly bytes: <A extends Artifact.Bytes>(
    artifact: A,
    ref: NoInfer<A["refSchema"]["Type"]>
  ) => Effect.Effect<Uint8Array, ReadError>;
  readonly metadata: <A extends Artifact.Any>(
    artifact: A,
    ref: NoInfer<A["refSchema"]["Type"]>
  ) => Effect.Effect<Metadata, ReadError>;
  readonly latest: <A extends Artifact.Any>(
    artifact: A,
    identity: Identity
  ) => Effect.Effect<A["refSchema"]["Type"], ReadError>;
  readonly query: <A extends Artifact.Any>(
    artifact: A,
    options: QueryOptions
  ) => Effect.Effect<Page<A>, ReadError>;
}

/** Per-invocation reads, supplied by the host or an ordinary test Layer. */
export class ArtifactReader extends Context.Service<ArtifactReader, Service>()(
  "@offtree/effectory-sdk/ArtifactReader"
) {}
