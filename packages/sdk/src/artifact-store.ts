import { Context } from "effect";
import type { Effect } from "effect";

import type { RuntimeError } from "./errors.ts";
import type { ArtifactRecord } from "./records.ts";

/**
 * Runtime-wide artifact persistence, shared by publication and inspection.
 * Publish must atomically accept identical retries and reject conflicting content
 * or schema versions for the same (runId, name), including concurrent callers.
 * Values are schema-encoded JSON; implementations own durable storage and indexing.
 */
export class ArtifactStore extends Context.Service<
  ArtifactStore,
  {
    readonly publish: (options: {
      readonly runId: string;
      readonly name: string;
      readonly value: unknown;
      readonly schemaVersion?: number;
    }) => Effect.Effect<ArtifactRecord, RuntimeError>;
    readonly get: (
      id: string
    ) => Effect.Effect<ArtifactRecord | undefined, RuntimeError>;
    readonly list: (
      runId?: string
    ) => Effect.Effect<ArtifactRecord[], RuntimeError>;
  }
>()("effectory/ArtifactStore") {}
