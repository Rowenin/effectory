/* oxlint-disable unicorn/throw-new-error, max-classes-per-file */
import { Schema } from "effect";

export class VaultSecretNotFound extends Schema.TaggedError<
  VaultSecretNotFound,
  { readonly brand: unique symbol }
>()("VaultSecretNotFound", { key: Schema.String, vault: Schema.String }) {}
export class VaultSecretInvalid extends Schema.TaggedError<
  VaultSecretInvalid,
  { readonly brand: unique symbol }
>()("VaultSecretInvalid", {
  key: Schema.String,
  reason: Schema.Literals(["InvalidValue", "DecoderFailed", "DecodeTimedOut"]),
  vault: Schema.String,
}) {}
export class VaultUnavailable extends Schema.TaggedError<
  VaultUnavailable,
  { readonly brand: unique symbol }
>()("VaultUnavailable", {
  reason: Schema.Literals([
    "Unreachable",
    "Unauthorized",
    "KeyMissing",
    "NotInitialized",
  ]),
  vault: Schema.String,
}) {}
export class VaultFailure extends Schema.TaggedError<
  VaultFailure,
  { readonly brand: unique symbol }
>()("VaultFailure", {
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
}) {}
export const Errors = Schema.Union([
  VaultSecretNotFound,
  VaultSecretInvalid,
  VaultUnavailable,
  VaultFailure,
]);
export type ReadError = typeof Errors.Type;
