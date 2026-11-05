import { Schema } from "effect";

const canonicalInstant =
  "canonical UTC as produced by Date#toISOString, e.g. 2026-11-05T10:00:00.000Z";
const ScheduledFor = Schema.String.check(
  Schema.isPattern(
    /^(?:[0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/u,
    { expected: canonicalInstant }
  ),
  // JSON Schema advertises the pattern; actual date validity/canonicality is
  // intentionally a decoder-only refinement (including extended Date years).
  Schema.makeFilter(
    (value: string) => {
      const instant = new Date(value);
      return (
        Number.isFinite(instant.getTime()) && instant.toISOString() === value
      );
    },
    { expected: canonicalInstant }
  )
);

/** Immutable-at-the-handler metadata for one admitted scheduled occurrence. */
export const Occurrence = Schema.Struct({
  catchUp: Schema.Boolean,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  scheduleId: Schema.String.check(
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u)
  ),
  scheduledFor: ScheduledFor,
});
