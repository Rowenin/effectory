import { Schema } from "effect";

const Name = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u)
);
const Id = Schema.NonEmptyString.check(Schema.isMaxLength(200));
const Version = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9][0-9]{0,15})$/u)
);
export const VaultRevision = Schema.Struct({
  revision: Schema.optionalKey(Id),
});
export const VaultRequest = Schema.Struct({
  ...VaultRevision.fields,
  vault: Name,
});
export const VaultKeyRequest = Schema.Struct({
  ...VaultRequest.fields,
  key: Name,
});
export const VaultDeleteRequest = Schema.Struct({
  ...VaultKeyRequest.fields,
  expectedVersion: Version,
  requestKey: Id,
});
export const VaultPutRequest = Schema.Struct({
  ...VaultDeleteRequest.fields,
  value: Schema.String.check(Schema.isMaxLength(65_536)),
});
export const VaultKeyState = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literals(["Present", "Deleted", "Absent"]),
    version: Version,
  }),
  Schema.TaggedStruct("Unknown", {}),
]);
export const VaultUsage = Schema.Struct({
  ciphertextBytes: Schema.Int,
  ciphertextLimit: Schema.Int,
  receiptLimit: Schema.Int,
  receipts: Schema.Int,
  vaultLimit: Schema.Int,
  vaults: Schema.Int,
});
export const VaultList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      local: Schema.Boolean,
      providerId: Schema.NullOr(Id),
      registered: Schema.Boolean,
      vault: Name,
    })
  ).check(Schema.isMaxLength(256)),
  revision: Id,
  usage: VaultUsage,
});
export const VaultDescription = Schema.Struct({
  capabilities: Schema.Array(Id),
  hint: Schema.NullOr(Schema.String),
  keyDirectory: Schema.NullOr(Schema.String),
  keyId: Schema.NullOr(Id),
  keys: Schema.Array(
    Schema.Struct({
      declared: Schema.Boolean,
      key: Name,
      schema: Schema.optionalKey(Schema.Json),
      state: VaultKeyState,
    })
  ).check(Schema.isMaxLength(512)),
  providerId: Id,
  revision: Id,
  state: Schema.Literals([
    "NotInitialized",
    "Ready",
    "KeyMissing",
    "KeyMismatch",
    "Unknown",
  ]),
  vault: Name,
});
export const VaultInitReceipt = Schema.Struct({
  keyId: Id,
  revision: Id,
  state: Schema.Literal("Ready"),
  vault: Name,
});
export const VaultMutationReceipt = Schema.Struct({
  current: VaultKeyState,
  key: Name,
  operation: Schema.Literals(["Put", "Delete"]),
  replayed: Schema.Boolean,
  revision: Id,
  vault: Name,
  version: Version,
});
export const VaultReveal = Schema.Struct({
  key: Name,
  revision: Id,
  value: Schema.String.check(Schema.isMaxLength(65_536)),
  vault: Name,
});
