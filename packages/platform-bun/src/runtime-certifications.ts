/**
 * Concrete release edges only. The release executable must pass the real
 * predecessor/target, offline-writer and rollback matrix before it ships.
 * A matching package version or execution label never adds an edge.
 */
// v0.1.0 release (Effect 4.0.5) to Effect 4.1.2. Edges that targeted Effect
// 4.0.5 cannot match this host; their records remain in docs/ as history.
const transitions = [
  {
    architecture: "arm64",
    evidence: "docs/runtime-effect-4.1-certification.json",
    platform: "darwin",
    predecessorExecutable:
      "56e37d0aa51edf257094f44d780b585f112fcd8f84505364971a88ed1824c69d",
    source: {
      build: "a8fa9264e18ea79615f9d7934ec510b8110d39ff305a9a2d8980aa1840baa7c9",
      contract: "effectory.execution/v1",
      effect: "4.0.5",
    },
    sourceStorage: 1,
    targetContract: "effectory.execution/v1",
    targetEffect: "4.1.2",
    targetStorage: 3,
  },
  {
    architecture: "x64",
    evidence: "docs/runtime-effect-4.1-certification.json",
    platform: "linux",
    predecessorExecutable:
      "d74c310dc1b38ff8c48510ea1f96d067092b1aa1979d59916d157cfe1a00f681",
    source: {
      build: "a8fa9264e18ea79615f9d7934ec510b8110d39ff305a9a2d8980aa1840baa7c9",
      contract: "effectory.execution/v1",
      effect: "4.0.5",
    },
    sourceStorage: 1,
    targetContract: "effectory.execution/v1",
    targetEffect: "4.1.2",
    targetStorage: 3,
  },
] as const;

/** Neither execution nor storage certification transfers to an untested platform. */
export function runtimeCertifications(
  platform: string = process.platform,
  architecture: string = process.arch
) {
  return transitions.filter(
    (edge) => edge.platform === platform && edge.architecture === architecture
  );
}
