import { OperationError } from "@effectory/runtime/protocol";

import { effectVersion } from "./host-modules.generated.ts";
import { hostAbi } from "./host-runtime.ts";
import type { RevisionManifest } from "./revision-manifest.ts";
import { runtimeCertifications } from "./runtime-certifications.ts";

/** Independent of the provenance hash; advances for incompatible execution semantics. */
export const executionContract = "effectory.execution/v1";

export interface ExecutionIdentity {
  readonly build: string;
  readonly contract: string | null;
  readonly effect: string;
}

export interface ExecutionCertification {
  readonly source: ExecutionIdentity;
  readonly targetContract: string;
  readonly targetEffect: string;
  /** Digest of the actual predecessor executable retained with the replay evidence. */
  readonly predecessorExecutable: string;
  readonly evidence: string;
}

export interface ExecutionPolicy {
  readonly current: ExecutionIdentity;
  readonly certified: readonly ExecutionCertification[];
}

export function runtimeExecutionPolicy(): ExecutionPolicy {
  return {
    certified: runtimeCertifications(),
    current: {
      build: hostAbi(),
      contract: executionContract,
      effect: effectVersion,
    },
  };
}

export function revisionExecutionIdentity(
  manifest: typeof RevisionManifest.Type
): ExecutionIdentity {
  return {
    build: manifest.hostAbi,
    contract: manifest.format === 3 ? manifest.executionContract : null,
    effect: manifest.effectVersion,
  };
}

export function executionCompatibility(
  source: ExecutionIdentity,
  policy: ExecutionPolicy
) {
  const target = policy.current;
  if (
    source.build === target.build &&
    source.effect === target.effect &&
    (source.contract === null || source.contract === target.contract)
  ) {
    return "ExactBuild" as const;
  }
  const edge = policy.certified.find(
    (candidate) =>
      candidate.source.build === source.build &&
      candidate.source.contract === source.contract &&
      candidate.source.effect === source.effect &&
      candidate.targetContract === target.contract &&
      candidate.targetEffect === target.effect
  );
  return edge === undefined ? ("Unavailable" as const) : ("Certified" as const);
}

/** Pure, metadata-only check shared by startup and execution admission. */
export function assertRevisionExecutable(
  revision: string,
  manifest: typeof RevisionManifest.Type,
  policy: ExecutionPolicy = runtimeExecutionPolicy()
) {
  const source = revisionExecutionIdentity(manifest);
  if (executionCompatibility(source, policy) === "Unavailable") {
    const required =
      source.contract === null
        ? `legacy host build ${source.build}`
        : `execution contract ${source.contract} from host build ${source.build}`;
    throw new OperationError({
      code: "RevisionUnavailable",
      message: `Revision ${revision} requires ${required} with Effect ${source.effect}; this host (${policy.current.build}, ${policy.current.contract}, Effect ${policy.current.effect}) has no certified transition for it. Use the compatible host to recover pending work.`,
    });
  }
}
