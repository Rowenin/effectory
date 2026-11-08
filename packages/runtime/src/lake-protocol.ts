/* oxlint-disable no-redeclare, oxc/no-barrel-file */
// Preserve the existing runtime schema exports and their shared object identity.
import {
  ContentType,
  Record,
} from "@offtree/effectory-sdk/internal/artifact-query-schema";
import { Schema } from "effect";

import { OperationError } from "./protocol.ts";

export * from "@offtree/effectory-sdk/internal/artifact-query-schema";

export const VersionListRequest = Schema.Struct({
  artifactId: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  includeReclaimed: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 1 }))
  ),
});
const Protection = Schema.Struct({
  consumerRunCount: Schema.Int,
  consumerRunIds: Schema.Array(Schema.String).check(Schema.isMaxLength(20)),
  producerRunId: Schema.NullOr(Schema.String),
  reportSourceRunId: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
});
export const VersionPage = Schema.Struct({
  cursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
  items: Schema.Array(
    Schema.Struct({
      ...Record.fields,
      protection: Schema.optionalKey(Protection),
      reclaimedAt: Schema.optionalKey(Schema.String),
      reclamationPlanId: Schema.optionalKey(Schema.String),
    })
  ).check(Schema.isMaxLength(200)),
  snapshot: Schema.Int,
});

const Positive = Schema.Int.check(Schema.isGreaterThan(0));
const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(200));
export const ReclamationRequest = Schema.Union([
  Schema.TaggedStruct("Policy", {
    schemaId: Schema.optionalKey(Identifier),
    schemaVersion: Schema.optionalKey(Positive),
  }).check(
    Schema.makeFilter(
      (value) =>
        value.schemaVersion === undefined || value.schemaId !== undefined
    )
  ),
  Schema.TaggedStruct("Selection", {
    artifactId: Schema.optionalKey(Identifier),
    keepLatest: Schema.optionalKey(Positive),
    olderThanMillis: Schema.optionalKey(Positive),
    schemaId: Identifier,
    schemaVersion: Schema.optionalKey(Positive),
  }).check(
    Schema.makeFilter(
      (value) =>
        value.olderThanMillis !== undefined || value.keepLatest !== undefined
    )
  ),
  Schema.TaggedStruct("Version", { artifactId: Identifier, version: Positive }),
]);
export type ReclamationRequest = typeof ReclamationRequest.Type;
export const ReclamationCandidate = Schema.Struct({
  artifactId: Identifier,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reason: Schema.Literals(["Age", "VersionCount", "Explicit"]),
  removesFinalVersion: Schema.Boolean,
  version: Positive,
});
export const ReclamationPlan = Schema.Struct({
  candidateVersions: Schema.Int,
  candidates: Schema.Array(ReclamationCandidate).check(
    Schema.isMaxLength(1000)
  ),
  emptiedArtifacts: Schema.Int,
  expiresAt: Schema.String,
  hasMore: Schema.Boolean,
  logicalBytes: Schema.Int,
  planId: Identifier,
  protectedBy: Schema.optionalKey(
    Schema.Struct({
      consumerVersions: Schema.Int,
      producerVersions: Schema.Int,
      reportVersions: Schema.Int,
    })
  ),
  protectedVersions: Schema.Int,
  reclaimableBlobBytes: Schema.Int,
});
export type ReclamationPlan = typeof ReclamationPlan.Type;
export const ReclamationApply = Schema.Struct({ planId: Identifier });
export const ReclamationReceipt = Schema.Struct({
  deletedVersions: Schema.Int,
  origin: Schema.optionalKey(Schema.Literals(["Manual", "Automatic"])),
  pendingBytes: Schema.Int,
  planId: Identifier,
  reclaimedBytes: Schema.Int,
  skippedVersions: Schema.Int,
});
export type ReclamationReceipt = typeof ReclamationReceipt.Type;

export const AutomaticReclamationSet = Schema.Struct({
  enabled: Schema.Boolean,
});
export const AutomaticReclamationStatus = Schema.Struct({
  changedAt: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  lastBatch: Schema.NullOr(
    Schema.Struct({ committedAt: Schema.String, receipt: ReclamationReceipt })
  ),
  lastError: Schema.NullOr(
    Schema.Struct({
      at: Schema.String,
      code: OperationError.fields.code,
      message: Schema.String,
      planId: Schema.optionalKey(Identifier),
    })
  ),
  lastSweepCompletedAt: Schema.NullOr(Schema.String),
  lastSweepStartedAt: Schema.NullOr(Schema.String),
});
export type AutomaticReclamationStatus = typeof AutomaticReclamationStatus.Type;

export const DownloadRequest = Schema.Struct({
  artifactId: Identifier,
  version: Positive,
});
export const DownloadMetadata = Schema.Struct({
  ...Record.fields,
  contentType: ContentType,
  kind: Schema.Literal("bytes"),
});
export const DownloadFrame = Schema.Union([
  Schema.TaggedStruct("Metadata", { metadata: DownloadMetadata }),
  Schema.TaggedStruct("Bytes", { bytes: Schema.Uint8Array }),
]);
export type DownloadFrame = typeof DownloadFrame.Type;
