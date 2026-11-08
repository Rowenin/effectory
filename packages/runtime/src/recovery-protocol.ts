import { Schema } from "effect";

import { RunStatus } from "./protocol.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(200));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Positive = Schema.Int.check(Schema.isGreaterThan(0));
export const RecoveryState = Schema.Literals([
  "Recoverable",
  "NotHeld",
  "Pending",
  "Stopping",
  "Terminal",
  "FinalizationStalled",
  "ExecutionActive",
  "RevisionUnavailable",
  "DeadlineElapsed",
  "AuthorizationLimit",
]);
export const RecoveryEntry = Schema.Struct({
  absoluteDeadline: Schema.NullOr(Schema.String),
  attempt: Positive,
  attemptTimeoutMillis: Schema.NullOr(Schema.Finite),
  entry: Positive,
  firstStartedAt: Schema.String,
  invocationId: Id,
  lastEnteredAt: Schema.String,
  observedAt: Schema.String,
  pathPreview: Schema.String,
  pathTruncated: Schema.Boolean,
  priorAuthorizations: Count,
  publicationCount: Count,
  taskId: Schema.String,
  taskVersion: Positive,
});
export const RecoveryAssessmentRequest = Schema.Struct({
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 1 }))
  ),
  runId: Id,
});
export const RecoveryAssessment = Schema.Struct({
  entries: Schema.Array(RecoveryEntry).check(Schema.isMaxLength(200)),
  latestAuthorization: Schema.NullOr(
    Schema.Struct({
      acceptedAt: Schema.String,
      actor: Schema.String,
      authorizationId: Id,
      authorized: Count,
      consumedEntries: Count,
      continuationPending: Schema.Boolean,
      pendingEntries: Count,
      requestKey: Id,
      supersededEntries: Count,
    })
  ),
  nextCursor: Schema.NullOr(Schema.String),
  reason: Schema.String,
  revision: Schema.String,
  runId: Id,
  state: RecoveryState,
  status: RunStatus,
  token: Schema.NullOr(Id),
  total: Count,
});
export const RecoveryRequest = Schema.Struct({
  acknowledgeReexecution: Schema.Literal(true),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
  requestKey: Id,
  runId: Id,
  token: Id,
});
export const RecoveryReceipt = Schema.Struct({
  acceptedAt: Schema.String,
  actor: Schema.String,
  authorizationId: Id,
  authorized: Count,
  outcome: Schema.Literal("Accepted"),
  reason: Schema.NullOr(Schema.String),
  requestKey: Id,
  runId: Id,
});
