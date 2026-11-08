import { Digest } from "@effectory/runtime/extension-protocol";
import { Schema } from "effect";

import {
  RevisionReclaimId,
  RevisionReclaimPlan,
  RevisionReclaimReceipt,
  revisionReclaimError,
} from "./revision-reclaim-record.ts";
import { RetirementInstant } from "./run-retirement.ts";

const Platform = Schema.String.check(Schema.isPattern(/^[a-z0-9_-]{1,32}$/u));
export const ReclaimPreview = Schema.Struct({
  architecture: Platform,
  // Digest of the complete captured repository/dependency/file binding.
  binding: Digest,
  format: Schema.Literal(1),
  plan: RevisionReclaimPlan,
  platform: Platform,
});
export const ReclaimAcceptance = Schema.Struct({
  acceptedAt: RetirementInstant,
  architecture: Platform,
  format: Schema.Literal(2),
  kind: Schema.Literal("RevisionReclaim"),
  planDigest: Digest,
  planId: RevisionReclaimId,
  platform: Platform,
  targetBuild: Digest,
});
export const ReclaimProgress = Schema.Literals([
  "Pending",
  "Quarantined",
  "BundleRemoved",
  "ManifestRemoved",
  "Complete",
]);
export const ReclaimTransition = Schema.Struct({
  acceptance: ReclaimAcceptance,
  format: Schema.Literal(1),
  phase: Schema.Literals(["Applying", "Complete"]),
  preview: ReclaimPreview,
  progress: Schema.Array(
    Schema.Struct({ phase: ReclaimProgress, revision: Digest })
  ).check(Schema.isMaxLength(128)),
  receipt: Schema.NullOr(RevisionReclaimReceipt),
});

export const invalidReclaimRecord = () =>
  revisionReclaimError(
    "RevisionUnavailable",
    "Revision reclamation records are unsupported or inconsistent; preserve them for the accepting host"
  );

export function validateReclaimPreview(preview: typeof ReclaimPreview.Type) {
  const { plan } = preview;
  const { selector } = plan;
  const ids = plan.candidates.map((candidate) => candidate.revision);
  const protectedIds = plan.protected.map((group) => group.revision);
  if (
    new Set(ids).size !== ids.length ||
    ids.join(",") !== ids.toSorted().join(",") ||
    new Set(protectedIds).size !== protectedIds.length ||
    protectedIds.some((id) => ids.includes(id)) ||
    plan.retainedCount > 128 ||
    plan.retainedCount < ids.length + protectedIds.length ||
    plan.projectedRetainedCount !== plan.retainedCount - ids.length ||
    plan.logicalBytes !==
      plan.candidates.reduce((n, candidate) => n + candidate.bytes, 0) ||
    (plan.status === "Ready") !== ids.length > 0 ||
    Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) !== 900_000 ||
    (selector._tag === "Revision" && ids.some((id) => id !== selector.revision))
  ) {
    throw invalidReclaimRecord();
  }
  return preview;
}
