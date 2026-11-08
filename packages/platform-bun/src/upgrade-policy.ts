import { runtimeCertifications } from "./runtime-certifications.ts";
import type {
  ExecutionIdentity,
  ExecutionPolicy,
} from "./runtime-compatibility.ts";
import {
  executionCompatibility,
  runtimeExecutionPolicy,
} from "./runtime-compatibility.ts";

export interface StorageCertification {
  readonly sourceBuild: string;
  readonly sourceStorage: number;
  readonly targetStorage: number;
  readonly targetContract: string;
  readonly targetEffect: string;
  readonly platform: string;
  readonly architecture: string;
  readonly predecessorExecutable: string;
  readonly evidence: string;
}
export interface UpgradePolicy {
  readonly execution: ExecutionPolicy;
  readonly storage: number;
  readonly certified: readonly StorageCertification[];
  readonly platform: string;
  readonly architecture: string;
}
// This is a shipping gate, not inferred from package versions or contract names.
// Populate only after the exact target executable passes the approved old/new
// replay, offline-writer, partial-fence, migration and rollback proof gates.
export function runtimeUpgradePolicy(): UpgradePolicy {
  return {
    architecture: process.arch,
    certified: runtimeCertifications().map(({ source, ...edge }) => ({
      ...edge,
      sourceBuild: source.build,
    })),
    execution: runtimeExecutionPolicy(),
    platform: process.platform,
    storage: 3,
  };
}
export function certifiedStorageTransition(
  policy: UpgradePolicy,
  source: { readonly build: string | null; readonly storage: number }
) {
  return policy.certified.find(
    (edge) =>
      edge.sourceBuild === source.build &&
      edge.sourceStorage === source.storage &&
      edge.targetStorage === policy.storage &&
      edge.targetContract === policy.execution.current.contract &&
      edge.targetEffect === policy.execution.current.effect &&
      edge.platform === policy.platform &&
      edge.architecture === policy.architecture
  );
}
export function upgradeRevisionDisposition(
  identity: ExecutionIdentity,
  policy: UpgradePolicy,
  storageSupported: boolean
) {
  if (executionCompatibility(identity, policy.execution) !== "Unavailable") {
    return "Executable" as const;
  }
  return storageSupported ? ("Archived" as const) : ("Unavailable" as const);
}

export const runtimeUpgradeSteps = [
  "credentials-envelope-v2",
  "vault-format-v2",
  "extension-lock-v2",
  "runtime-storage-v2",
] as const;

/** Keep completed format-2 receipts readable; format 3 is an explicit predecessor writer fence. */
export function runtimeUpgradeStepsFor(storage: number): readonly string[] {
  if (storage === 2) {
    return runtimeUpgradeSteps;
  }
  if (storage === 3) {
    return [...runtimeUpgradeSteps.slice(0, 3), "runtime-storage-v3"];
  }
  return [];
}
