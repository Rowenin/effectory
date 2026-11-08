import type { Database } from "bun:sqlite";

import {
  Digest,
  ExtensionChange,
  ExtensionOperation,
  ResolutionSnapshot,
} from "@effectory/runtime/extension-protocol";
import { Effect, Schema } from "effect";

import { lockRevision, validateLock } from "./extension-cache.ts";
import type { InspectionBudget } from "./inspection-budget.ts";
import { binaryLimit } from "./lake-binary.ts";
import { RetirementSummarySchema } from "./run-retirement-store.ts";
import { RetirementInstant, RetirementReceipt } from "./run-retirement.ts";
import { unsupportedUpgradeWork, upgradeScanner } from "./upgrade-scan.ts";

const OperationRow = Schema.Struct({
  actor: Schema.String,
  candidateJson: Schema.NullOr(Schema.String),
  operationId: Schema.String,
  position: Schema.Int,
  requestJson: Schema.String,
  requestKey: Schema.String,
  resolutionsJson: Schema.String,
  snapshotJson: Schema.String,
  status: ExtensionOperation.fields.status,
});
const ActivationRow = Schema.Struct({
  afterJson: Schema.String,
  applicationRevision: Digest,
  beforeJson: Schema.String,
  operationId: Schema.String,
  owner: Schema.String,
  position: Schema.Literal(1),
});
const RetirementRow = Schema.Struct({
  createdAt: RetirementInstant,
  expiresAt: Schema.Finite,
  format: Schema.Literal(1),
  planId: Schema.String.check(Schema.isPattern(/^[\da-f-]{36}$/u)),
  position: Schema.Int,
  principal: Schema.String,
  receiptJson: Schema.NullOr(Schema.String),
  repositoryId: Schema.String,
  startedAt: Schema.NullOr(RetirementInstant),
  state: Schema.Literals(["Building", "Planned", "Applying", "Complete"]),
  summaryJson: Schema.String,
});
const InstallRow = Schema.Struct({
  bytes: Schema.Int.check(
    Schema.isBetween({ maximum: binaryLimit, minimum: 0 })
  ),
  digest: Digest,
  position: Schema.Int,
  stage: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}\.stage$/u)),
});
const decode = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  value: unknown
) => Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" });

/** Validate maintenance formats without calling any mutation-capable recovery. */
export function inspectUpgradeMaintenance(
  database: Database,
  budget?: InspectionBudget
) {
  return Effect.gen(function* () {
    const present = yield* Effect.try({
      catch: () => unsupportedUpgradeWork("maintenance journal inventory"),
      try: () => {
        const names = [
          "extension_registry",
          "extension_operations",
          "extension_activation",
          "host_retirement_plans",
          "lake_binary_installs",
        ];
        return new Set(
          names.filter(
            (name) =>
              database
                .query(
                  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
                )
                .get(name) !== null
          )
        );
      },
    });
    const scanner = upgradeScanner(database, budget);
    const counts = { activation: 0, extensions: 0, installs: 0, retirement: 0 };
    const extensionCount = [
      "extension_registry",
      "extension_operations",
      "extension_activation",
    ].filter((name) => present.has(name)).length;
    if (extensionCount !== 0 && extensionCount !== 3) {
      return yield* Effect.fail(
        unsupportedUpgradeWork("partial extension journals")
      );
    }
    if (extensionCount === 3) {
      yield* scanner.scan(
        "extension registry",
        `SELECT singleton position,revision,lockJson FROM extension_registry WHERE /* after */ ORDER BY singleton LIMIT ?`,
        (raw) => {
          const row = decode(
            Schema.Struct({
              lockJson: Schema.String,
              position: Schema.Literal(1),
              revision: Digest,
            }),
            raw
          );
          if (
            lockRevision(validateLock(JSON.parse(row.lockJson))) !==
            row.revision
          ) {
            throw unsupportedUpgradeWork("extension registry fingerprint");
          }
        }
      );
      yield* scanner.scan(
        "extension operations",
        `SELECT sequence position,operationId,actor,requestKey,status,snapshotJson,requestJson,resolutionsJson,candidateJson
        FROM extension_operations WHERE /* after */ ORDER BY sequence LIMIT ?`,
        (raw) => {
          const row = decode(OperationRow, raw);
          const snapshot = decode(
            ExtensionOperation,
            JSON.parse(row.snapshotJson)
          );
          const request = decode(ExtensionChange, JSON.parse(row.requestJson));
          decode(ResolutionSnapshot, JSON.parse(row.resolutionsJson));
          if (row.candidateJson !== null) {
            validateLock(JSON.parse(row.candidateJson));
          }
          if (
            row.position !== snapshot.sequence ||
            row.operationId !== snapshot.operationId ||
            row.actor !== snapshot.actor ||
            row.requestKey !== snapshot.requestKey ||
            row.status !== snapshot.status ||
            request.requestKey !== row.requestKey ||
            request.kind !== snapshot.kind ||
            request.expectedRevision !== snapshot.expectedRevision
          ) {
            throw unsupportedUpgradeWork("extension operation identity");
          }
          if (row.status === "Queued" || row.status === "Running") {
            counts.extensions += 1;
          }
        }
      );
      yield* scanner.scan(
        "extension activation",
        `SELECT a.singleton position,a.operationId,a.beforeJson,a.afterJson,a.applicationRevision,o.operationId owner
        FROM extension_activation a LEFT JOIN extension_operations o ON o.operationId=a.operationId
        WHERE /* after */ ORDER BY a.singleton LIMIT ?`,
        (raw) => {
          const row = decode(ActivationRow, raw);
          validateLock(JSON.parse(row.beforeJson));
          validateLock(JSON.parse(row.afterJson));
          counts.activation += 1;
        }
      );
    }
    if (present.has("host_retirement_plans")) {
      yield* scanner.scan(
        "run retirement plans",
        `SELECT rowid position,planId,repositoryId,principal,format,createdAt,expiresAt,state,summaryJson,startedAt,receiptJson
        FROM host_retirement_plans WHERE /* after */ ORDER BY rowid LIMIT ?`,
        (raw) => {
          const row = decode(RetirementRow, raw);
          if (row.state !== "Building") {
            const summary = decode(
              RetirementSummarySchema,
              JSON.parse(row.summaryJson)
            );
            if (summary.planId !== row.planId) {
              throw unsupportedUpgradeWork("run retirement plan identity");
            }
          }
          if (row.state === "Complete") {
            if (row.receiptJson === null) {
              throw unsupportedUpgradeWork("run retirement receipt");
            }
            const receipt = decode(
              RetirementReceipt,
              JSON.parse(row.receiptJson)
            );
            if (
              receipt.planId !== row.planId ||
              receipt.startedAt !== row.startedAt
            ) {
              throw unsupportedUpgradeWork("run retirement receipt identity");
            }
          } else if (row.receiptJson !== null) {
            throw unsupportedUpgradeWork("unfinished run retirement receipt");
          }
          if (row.state === "Applying") {
            if (row.startedAt === null) {
              throw unsupportedUpgradeWork("run retirement start");
            }
            counts.retirement += 1;
          }
        }
      );
    }
    if (present.has("lake_binary_installs")) {
      yield* scanner.scan(
        "binary installation intents",
        `SELECT rowid position,stage,digest,bytes FROM lake_binary_installs WHERE /* after */ ORDER BY rowid LIMIT ?`,
        (raw) => {
          decode(InstallRow, raw);
          counts.installs += 1;
        }
      );
    }
    return { ...scanner.totals, counts };
  });
}
