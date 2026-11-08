import {
  Digest,
  ExtensionOperation,
} from "@effectory/runtime/extension-protocol";
import { Effect, Schema } from "effect";

import { lockRevision, validateLock } from "./extension-cache.ts";
import { reclaimDecode } from "./revision-reclaim-scan.ts";
import type {
  ProtectRevision,
  ReclaimScanner,
} from "./revision-reclaim-scan.ts";
import { unsupportedUpgradeWork } from "./upgrade-scan.ts";

/** Maintenance validation runs first; these scans add application dependencies. */
export function inspectReclaimExtensions(
  scanner: ReclaimScanner,
  tables: ReadonlySet<string>,
  active: string | null,
  protect: ProtectRevision
) {
  return Effect.gen(function* () {
    if (!tables.has("extension_operations")) {
      return;
    }
    yield* scanner.scan(
      "extension application dependencies",
      `SELECT sequence position,snapshotJson FROM extension_operations WHERE /* after */ ORDER BY sequence LIMIT ?`,
      (raw) => {
        const row = reclaimDecode(
          Schema.Struct({ position: Schema.Int, snapshotJson: Schema.String }),
          raw
        );
        const operation = reclaimDecode(
          ExtensionOperation,
          JSON.parse(row.snapshotJson)
        );
        if (operation.status === "Queued" || operation.status === "Running") {
          protect(
            operation.baseApplicationRevision,
            "ExtensionOperation",
            operation.operationId
          );
        }
      }
    );
    yield* scanner.scan(
      "extension activation dependencies",
      `SELECT a.singleton position,a.operationId,a.applicationRevision,a.beforeJson,a.afterJson,o.snapshotJson,o.candidateJson,r.revision registryRevision FROM extension_activation a LEFT JOIN extension_operations o ON o.operationId=a.operationId LEFT JOIN extension_registry r ON r.singleton=1 WHERE /* after */ ORDER BY a.singleton LIMIT ?`,
      (raw) => {
        const row = reclaimDecode(
          Schema.Struct({
            afterJson: Schema.String,
            applicationRevision: Digest,
            beforeJson: Schema.String,
            candidateJson: Schema.String,
            operationId: Schema.String,
            position: Schema.Literal(1),
            registryRevision: Digest,
            snapshotJson: Schema.String,
          }),
          raw
        );
        const operation = reclaimDecode(
          ExtensionOperation,
          JSON.parse(row.snapshotJson)
        );
        if (
          operation.operationId !== row.operationId ||
          operation.status !== "Running" ||
          operation.expectedRevision !== row.registryRevision ||
          lockRevision(validateLock(JSON.parse(row.beforeJson))) !==
            operation.expectedRevision ||
          lockRevision(validateLock(JSON.parse(row.afterJson))) !==
            lockRevision(validateLock(JSON.parse(row.candidateJson))) ||
          (active !== operation.baseApplicationRevision &&
            active !== row.applicationRevision)
        ) {
          throw unsupportedUpgradeWork(
            "extension activation ownership or active pointer"
          );
        }
        protect(
          row.applicationRevision,
          "ExtensionActivation",
          row.operationId
        );
      }
    );
  });
}
