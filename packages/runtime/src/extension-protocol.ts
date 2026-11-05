import { Schema } from "effect";

import { OperationError } from "./protocol.ts";

export const extensionLimits = Object.freeze({
  archiveBytes: 16_777_216,
  expandedBytes: 67_108_864,
  files: 512,
  lockBytes: 4_194_304,
  manifestBytes: 262_144,
  packages: 128,
});
export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const ExtensionId = Schema.String.check(
  Schema.isPattern(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9._/-]{0,98}$/u
  )
);
export const ExportName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/u)
);
const ContractId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u)
);
const Version = Schema.Int.check(Schema.isGreaterThan(0));
export const ArchivePath = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u)
);
export const Repository = Schema.String.check(
  Schema.isPattern(
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u
  )
);
export const GitHubSource = Schema.Struct({
  assetName: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.tgz$/u)
  ),
  ref: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  repository: Repository,
});
export const ResolvedSource = Schema.Struct({
  ...GitHubSource.fields,
  assetId: Schema.Int.check(Schema.isGreaterThan(0)),
  commit: Schema.String.check(
    Schema.isPattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u)
  ),
  publisherDigest: Schema.NullOr(Digest),
  releaseId: Schema.Int.check(Schema.isGreaterThan(0)),
  size: Schema.Int.check(
    Schema.isBetween({ maximum: extensionLimits.archiveBytes, minimum: 1 })
  ),
});
const Entry = Schema.Struct({
  export: ExportName,
  file: ArchivePath,
  types: ArchivePath,
});
const NamedContract = Schema.Struct({
  id: ContractId,
  name: ExportName,
  version: Version,
});
const Target = Schema.Struct({ id: ContractId, version: Version });
const Replacement = Schema.Struct({ id: ContractId, target: Target });
const ImportName = Schema.String.check(
  Schema.isPattern(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
  Schema.isMaxLength(200)
);
const BoundedText = Schema.NonEmptyString.check(Schema.isMaxLength(200));
export const ExtensionManifest = Schema.Struct({
  capabilities: Schema.Array(
    Schema.Literals(["filesystem", "network", "process", "environment"])
  ).check(Schema.isMaxLength(4)),
  contracts: Entry,
  contributions: Schema.Struct({
    artifacts: Schema.Array(NamedContract).check(Schema.isMaxLength(256)),
    implementations: Schema.Array(Replacement).check(Schema.isMaxLength(256)),
    patches: Schema.Array(Replacement).check(Schema.isMaxLength(256)),
    tasks: Schema.Array(NamedContract).check(Schema.isMaxLength(256)),
    workflows: Schema.Array(NamedContract).check(Schema.isMaxLength(256)),
  }),
  dependencies: Schema.Record(ImportName, GitHubSource),
  dependencyInventory: Schema.Array(
    Schema.Struct({ name: BoundedText, version: BoundedText })
  ).check(Schema.isMaxLength(256)),
  effectVersion: Schema.Literal("4.0.5"),
  entrypoint: Entry,
  files: Schema.Record(ArchivePath, Digest),
  id: ExtensionId,
  manifestVersion: Schema.Literal(1),
  sdkVersion: Schema.Literal("0.0.0"),
  version: Schema.String.check(
    Schema.isPattern(/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u),
    Schema.isMaxLength(100)
  ),
});

export const LockedPackage = Schema.Struct({
  archiveDigest: Digest,
  dependencies: Schema.Record(ImportName, ExtensionId),
  manifest: ExtensionManifest,
  manifestDigest: Digest,
  source: ResolvedSource,
});
export const ExtensionLock = Schema.Struct({
  format: Schema.Literal(1),
  packages: Schema.Record(ExtensionId, LockedPackage),
  roots: Schema.Record(
    ExtensionId,
    Schema.Struct({
      bindingName: Schema.optionalKey(ExportName),
      source: GitHubSource,
    })
  ),
});

const RequestKey = Schema.NonEmptyString.check(Schema.isMaxLength(200));
const Mutation = { expectedRevision: Digest, requestKey: RequestKey };
export const ExtensionAdd = Schema.Struct({
  ...Mutation,
  bindingName: Schema.optionalKey(ExportName),
  kind: Schema.Literal("Add"),
  source: GitHubSource,
  trust: Schema.Boolean,
});
export const ExtensionUpdate = Schema.Struct({
  ...Mutation,
  id: ExtensionId,
  kind: Schema.Literal("Update"),
  ref: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  trust: Schema.Boolean,
});
export const ExtensionRemove = Schema.Struct({
  ...Mutation,
  id: ExtensionId,
  kind: Schema.Literal("Remove"),
});
export const ExtensionChange = Schema.Union([
  ExtensionAdd,
  ExtensionUpdate,
  ExtensionRemove,
]);
export const ResolutionSnapshot = Schema.Record(Schema.String, ResolvedSource);

export const ExtensionOperation = Schema.Struct({
  acceptedAt: Schema.String,
  actor: RequestKey,
  baseApplicationRevision: Digest,
  error: Schema.NullOr(OperationError),
  expectedRevision: Digest,
  kind: Schema.Literals(["Add", "Update", "Remove"]),
  operationId: RequestKey,
  requestKey: RequestKey,
  result: Schema.NullOr(
    Schema.Struct({ applicationRevision: Digest, installedRevision: Digest })
  ),
  sequence: Schema.Int,
  status: Schema.Literals(["Queued", "Running", "Succeeded", "Failed"]),
  updatedAt: Schema.String,
});

export const ExtensionSummary = Schema.Struct({
  bindingName: Schema.NullOr(ExportName),
  digest: Digest,
  id: ExtensionId,
  root: Schema.Boolean,
  selected: Schema.Boolean,
  source: ResolvedSource,
  version: Schema.String,
});
export const ExtensionInventory = Schema.Struct({
  applicationRevision: Digest,
  extensions: Schema.Array(ExtensionSummary).check(Schema.isMaxLength(128)),
  installedRevision: Digest,
});

export const ExtensionOutdatedRequest = Schema.Struct({
  afterId: Schema.optionalKey(ExtensionId),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ maximum: 20, minimum: 1 }))
  ),
  revision: Schema.optionalKey(Digest),
});
export const ExtensionUpdatePage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      changed: Schema.NullOr(Schema.Boolean),
      current: GitHubSource,
      error: Schema.NullOr(OperationError),
      id: ExtensionId,
      latest: Schema.NullOr(GitHubSource),
    })
  ).check(Schema.isMaxLength(20)),
  nextAfterId: Schema.NullOr(ExtensionId),
  revision: Digest,
});

export const OperationListRequest = Schema.Struct({
  afterSequence: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  kind: Schema.optionalKey(ExtensionOperation.fields.kind),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 1 }))
  ),
  status: Schema.optionalKey(ExtensionOperation.fields.status),
});
export const OperationPage = Schema.Struct({
  cursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
  items: Schema.Array(ExtensionOperation).check(Schema.isMaxLength(200)),
  snapshot: Schema.Int,
});
