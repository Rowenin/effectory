import { Effect, Schema } from "effect";

import { TaskRuntimeError } from "./errors.ts";
import { Occurrence } from "./schedule-occurrence.ts";

/** Kept separate so task context declarations depend only on the schema type. */
export const decodeTestOccurrence = (value: unknown) =>
  Schema.decodeUnknownEffect(Occurrence)(value, {
    onExcessProperty: "error",
  }).pipe(
    Effect.map((occurrence) => Object.freeze({ ...occurrence })),
    Effect.mapError(
      (cause) =>
        new TaskRuntimeError({
          code: "InvalidBoundary",
          message: `Invalid occurrence fixture: ${cause.message.slice(0, 1800)}`,
        })
    )
  );
