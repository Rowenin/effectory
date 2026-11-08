/* oxlint-disable max-classes-per-file, unicorn/throw-new-error */
import { Schema } from "effect";

export class ArtifactReadError extends Schema.TaggedError<
  ArtifactReadError,
  { readonly brand: unique symbol }
>()("ArtifactReadError", {
  artifactId: Schema.NullOr(Schema.String),
  message: Schema.String,
  reason: Schema.Literals([
    "NotFound",
    "Reclaimed",
    "KindMismatch",
    "SchemaMismatch",
    "DigestMismatch",
    "DecodeFailed",
    "Corrupt",
    "InvalidQuery",
    "InvalidCursor",
    "CursorExpired",
    "QueryBudget",
    "PinLimit",
    "ConcurrencyLimit",
    "Closed",
    "Unsupported",
  ]),
  version: Schema.NullOr(Schema.Int),
}) {}

export class ArtifactUnavailable extends Schema.TaggedError<
  ArtifactUnavailable,
  { readonly brand: unique symbol }
>()("ArtifactUnavailable", {
  message: Schema.String,
  reason: Schema.Literals(["Busy", "Storage"]),
}) {}

export type ReadError = ArtifactReadError | ArtifactUnavailable;

/** Only authorized identities or validated caller IDs may enter persisted errors. */
export function readFailure(
  reason: ArtifactReadError["reason"],
  reference?: { readonly artifactId?: unknown; readonly version?: unknown },
  synthetic = false
) {
  const id = reference?.artifactId;
  const version = reference?.version;
  return new ArtifactReadError({
    artifactId:
      typeof id === "string" &&
      (/^[a-f0-9]{64}$/u.test(id) ||
        (synthetic && /^test-artifact-[1-9][0-9]*$/u.test(id)))
        ? id
        : null,
    message: `Artifact read failed: ${reason}`,
    reason,
    version:
      typeof version === "number" &&
      Number.isSafeInteger(version) &&
      version > 0
        ? version
        : null,
  });
}
