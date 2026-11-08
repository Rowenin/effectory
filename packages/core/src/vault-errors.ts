/* oxlint-disable unicorn/throw-new-error, max-classes-per-file */
import { Schema } from "effect";

export class VaultSecretNotFound extends Schema.TaggedError<VaultSecretNotFound>()(
  "VaultSecretNotFound",
  { key: Schema.String, vault: Schema.String }
) {}
export class VaultSecretInvalid extends Schema.TaggedError<VaultSecretInvalid>()(
  "VaultSecretInvalid",
  {
    key: Schema.String,
    reason: Schema.Literals([
      "InvalidValue",
      "DecoderFailed",
      "DecodeTimedOut",
    ]),
    vault: Schema.String,
  }
) {}
export class VaultUnavailable extends Schema.TaggedError<VaultUnavailable>()(
  "VaultUnavailable",
  {
    reason: Schema.Literals([
      "Unreachable",
      "Unauthorized",
      "KeyMissing",
      "NotInitialized",
    ]),
    vault: Schema.String,
  }
) {}
export class VaultFailure extends Schema.TaggedError<VaultFailure>()(
  "VaultFailure",
  {
    key: Schema.optionalKey(Schema.String),
    reason: Schema.Literals([
      "Unsupported",
      "LimitExceeded",
      "InvalidDefinition",
      "Closed",
      "Corrupt",
      "KeyMismatch",
      "Unmanaged",
    ]),
    vault: Schema.String,
  }
) {}
export const Errors = Schema.Union([
  VaultSecretNotFound,
  VaultSecretInvalid,
  VaultUnavailable,
  VaultFailure,
]);
export type ReadError = typeof Errors.Type;
