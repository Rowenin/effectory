/* oxlint-disable eslint/no-redeclare -- Effect schemas share their value and type names. */
import { Schema } from "effect";

import { Source } from "./report-history.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(200));
const Positive = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 })
);
export const SourceIdentity = Schema.Struct({
  ...Source.fields,
  status: Schema.NullOr(Source.fields.status),
});
export type SourceIdentity = typeof SourceIdentity.Type;
export const RecordStatus = Schema.Literals([
  "WaitingSource",
  "Queued",
  "Running",
  "NeedsAttention",
  "Succeeded",
  "Failed",
  "Cancelled",
  "NotApplicable",
]);
export type RecordStatus = typeof RecordStatus.Type;
export const Execution = Schema.Struct({
  attemptTimeout: Schema.String,
  retry: Schema.optionalKey(
    Schema.Struct({
      attempts: Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 1 })),
      delay: Schema.String,
      when: Schema.Array(Id).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(32)
      ),
    })
  ),
  timeout: Schema.String,
});
export const Provenance = Schema.Struct({
  attachmentId: Id,
  execution: Execution,
  generation: Positive,
  reportId: Id,
  sourceInvocationId: Schema.NullOr(Id),
  sourceRunId: Id,
});
