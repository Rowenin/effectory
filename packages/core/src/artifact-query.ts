/* oxlint-disable oxc/no-barrel-file */
import { Effect, Option, Stream } from "effect";

import { readFailure } from "./artifact-read-errors.ts";
import type { ReadError } from "./artifact-read-errors.ts";
import { ArtifactReader } from "./artifact-reader.ts";
import type { QueryOptions, Row } from "./artifact-reader.ts";
import type * as Artifact from "./artifact.ts";

export * from "./artifact-query-schema.ts";

/** Traverse one live query snapshot; cursor failures never silently restart it. */
export function stream<A extends Artifact.Any>(
  artifact: A,
  options: Omit<QueryOptions, "cursor">
): Stream.Stream<Row<A>, ReadError, ArtifactReader> {
  return Stream.unwrap(
    Effect.gen(function* () {
      if ("cursor" in options) {
        return yield* readFailure("InvalidQuery");
      }
      const reader = yield* ArtifactReader;
      return Stream.paginate<string | undefined, Row<A>, ReadError>(
        undefined,
        (cursor) =>
          reader
            .query(artifact, {
              ...options,
              ...(cursor === undefined ? {} : { cursor }),
            })
            .pipe(
              Effect.map(
                (page) =>
                  [page.rows, Option.fromNullishOr(page.cursor)] as const
              )
            )
      );
    })
  );
}
