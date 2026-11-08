import { Schema } from "effect";

export const UpgradeId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u)
);
export const UpgradeDigest = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/u)
);
const Count = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })
);
const Text = Schema.String.check(Schema.isMaxLength(4096));
const Name = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u)
);
export const UpgradeExecution = Schema.Struct({
  build: UpgradeDigest,
  contract: Schema.NullOr(Text),
  effect: Schema.String.check(Schema.isMaxLength(64)),
});
export const UpgradePlan = Schema.Struct({
  blockers: Schema.Array(Text).check(Schema.isMaxLength(128)),
  createdAt: Count,
  expiresAt: Count,
  format: Schema.Literal(1),
  migrations: Schema.Array(Name).check(Schema.isMaxLength(64)),
  planId: UpgradeId,
  recoveryCopy: Text,
  repositoryId: Schema.String.check(Schema.isMaxLength(256)),
  revisions: Schema.Array(
    Schema.Struct({
      disposition: Schema.Literals(["Executable", "Archived", "Unavailable"]),
      execution: UpgradeExecution,
      revision: UpgradeDigest,
    })
  ).check(Schema.isMaxLength(128)),
  source: Schema.Struct({
    build: Schema.NullOr(UpgradeDigest),
    dependencies: UpgradeDigest,
    identity: UpgradeDigest,
    storage: Count,
  }),
  status: Schema.Literals(["Ready", "Blocked", "Unsupported"]),
  target: Schema.Struct({ ...UpgradeExecution.fields, storage: Count }),
  work: Schema.Record(Schema.String, Count).check(
    Schema.isPropertyNames(Name),
    Schema.isMaxProperties(64)
  ),
  workByRevision: Schema.Array(
    Schema.Struct({
      counts: Schema.Struct({
        reportCancellations: Count,
        reportSources: Count,
        reports: Count,
        runs: Count,
        scheduledAdmissions: Count,
      }),
      examples: Schema.Array(Schema.Struct({ category: Name, id: Text })).check(
        Schema.isMaxLength(20)
      ),
      examplesTruncated: Schema.Boolean,
      revision: Text,
    })
  ).check(Schema.isMaxLength(128)),
});
/** The small active file is sufficient to recover acceptance before history publication. */
export const UpgradeAcceptance = Schema.Struct({
  acceptedAt: Count,
  architecture: Schema.String.check(Schema.isPattern(/^[a-z0-9_-]{1,32}$/u)),
  format: Schema.Literal(1),
  planDigest: UpgradeDigest,
  planId: UpgradeId,
  platform: Schema.String.check(Schema.isPattern(/^[a-z0-9_-]{1,32}$/u)),
  recoveryDigest: UpgradeDigest,
  targetBuild: UpgradeDigest,
});
export const UpgradePhase = Schema.Literals([
  "Protecting",
  "Fenced",
  "Migrating",
  "Publishing",
  "Aborting",
  "Complete",
  "Aborted",
]);
export const UpgradeTransition = Schema.Struct({
  abortReason: Schema.optionalKey(Schema.Literal("SourceChanged")),
  acceptance: UpgradeAcceptance,
  completedSteps: Schema.Array(Name).check(Schema.isMaxLength(64)),
  format: Schema.Literal(1),
  phase: UpgradePhase,
  plan: UpgradePlan,
  updatedAt: Count,
});
export const terminalUpgrade = (phase: typeof UpgradePhase.Type) =>
  phase === "Complete" || phase === "Aborted";
