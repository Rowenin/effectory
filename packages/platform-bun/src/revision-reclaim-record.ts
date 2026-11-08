import { Digest } from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { RetirementInstant } from "./run-retirement.ts";

const Count = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })
);
export const RevisionReclaimId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u)
);
export const RevisionReclaimSelector = Schema.Union([
  Schema.TaggedStruct("Unreferenced", {}),
  Schema.TaggedStruct("Revision", { revision: Digest }),
]);
export const RevisionProtection = Schema.Struct({
  examplesTruncated: Schema.Boolean,
  reasons: Schema.Array(
    Schema.Struct({
      count: Count,
      examples: Schema.Array(Schema.String).check(Schema.isMaxLength(20)),
      kind: Schema.Literals([
        "Active",
        "Run",
        "Schedule",
        "Scheduler",
        "ExtensionOperation",
        "ExtensionActivation",
      ]),
    })
  ),
  revision: Digest,
});
export const RevisionReclaimCandidate = Schema.Struct({
  bundleDigest: Digest,
  bytes: Count,
  executionContract: Schema.NullOr(Schema.String),
  hostBuild: Digest,
  manifestDigest: Digest,
  revision: Digest,
});
export const RevisionReclaimPlan = Schema.Struct({
  candidates: Schema.Array(RevisionReclaimCandidate).check(
    Schema.isMaxLength(128)
  ),
  createdAt: RetirementInstant,
  expiresAt: RetirementInstant,
  hostBuild: Digest,
  logicalBytes: Count,
  planId: RevisionReclaimId,
  projectedRetainedCount: Count,
  protected: Schema.Array(RevisionProtection).check(Schema.isMaxLength(128)),
  repositoryId: Schema.String,
  retainedCount: Count,
  scannedBytes: Count,
  scannedRows: Count,
  selector: RevisionReclaimSelector,
  status: Schema.Literals(["Ready", "NoCandidates"]),
});
export const RevisionReclaimReceipt = Schema.Struct({
  completedAt: RetirementInstant,
  logicalBytes: Count,
  planId: RevisionReclaimId,
  removedFiles: Count,
  revisions: Schema.Array(Digest).check(Schema.isMaxLength(128)),
  startedAt: RetirementInstant,
});
export const RevisionReclaimInspection = Schema.Struct({
  completedRevisions: Count,
  phase: Schema.Literals(["Planned", "Applying", "Complete"]),
  plan: RevisionReclaimPlan,
  receipt: Schema.NullOr(RevisionReclaimReceipt),
});
export const revisionReclaimError = (
  code: OperationError["code"],
  message: string
) => new OperationError({ code, message });
