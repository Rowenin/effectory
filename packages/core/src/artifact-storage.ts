import type { Effect, Stream } from "effect";
import { Context } from "effect";

import type * as Artifact from "./artifact.ts";
import type { TaskRuntimeError } from "./errors.ts";
import type * as Tag from "./tag.ts";

export interface PublishOptions {
  readonly key: string;
  readonly output?: string;
  readonly tags?: Tag.Input;
}

type PublishValue<A extends Artifact.Any, E, R> = A["kind"] extends "bytes"
  ? Uint8Array | Stream.Stream<Uint8Array, E, R>
  : NoInfer<(A & Artifact.Artifact)["schema"]["Type"]>;

/** Invocation-owned storage. Tasks and their local Layers receive it automatically. */
export class ArtifactStorage extends Context.Service<
  ArtifactStorage,
  {
    readonly publish: <A extends Artifact.Any, E = never, R = never>(
      artifact: A,
      value: PublishValue<A, E, R>,
      options: PublishOptions
    ) => Effect.Effect<A["refSchema"]["Type"], E | TaskRuntimeError, R>;
  }
>()("@offtree/effectory-sdk/ArtifactStorage") {}
