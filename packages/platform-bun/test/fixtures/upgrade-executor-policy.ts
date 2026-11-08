import type { UpgradePolicy } from "../../src/upgrade-policy.ts";
import type { UpgradePlan } from "../../src/upgrade-record.ts";

/** Synthetic component policy only. It is never installed in the production certification list. */
export function executorTestPolicy(
  plan: typeof UpgradePlan.Type
): UpgradePolicy {
  if (plan.source.build === null) {
    throw new Error("Missing fixture build");
  }
  return {
    architecture: process.arch,
    certified: [
      {
        architecture: process.arch,
        evidence: "synthetic component fixture; not transition certification",
        platform: process.platform,
        predecessorExecutable: "a".repeat(64),
        sourceBuild: plan.source.build,
        sourceStorage: plan.source.storage,
        targetContract: plan.target.contract ?? "",
        targetEffect: plan.target.effect,
        targetStorage: plan.target.storage,
      },
    ],
    execution: {
      certified: plan.revisions.map((item) => ({
        evidence: "synthetic component fixture; not release evidence",
        predecessorExecutable: "a".repeat(64),
        source: item.execution,
        targetContract: plan.target.contract ?? "",
        targetEffect: plan.target.effect,
      })),
      current: {
        build: plan.target.build,
        contract: plan.target.contract,
        effect: plan.target.effect,
      },
    },
    platform: process.platform,
    storage: plan.target.storage,
  };
}
