/**
 * Concrete release edges only. The release executable must pass the real
 * predecessor/target, offline-writer and rollback matrix before it ships.
 * A matching package version or execution label never adds an edge.
 */
const transitions = [
  {
    architecture: "arm64",
    evidence: "docs/runtime-http-disconnect-certification.json",
    platform: "darwin",
    predecessorExecutable:
      "a69d21b724f053b90453e29d9dd408523c4cfc40b76974bdebcc4ff302a286bf",
    source: {
      build: "fe46ad3fa836f61192ee29d76695082ced3d571857716442a22031e45eef79a2",
      contract: "effectory.execution/v1",
      effect: "4.0.5",
    },
    sourceStorage: 3,
    targetContract: "effectory.execution/v1",
    targetEffect: "4.0.5",
    targetStorage: 3,
  },
  {
    architecture: "arm64",
    evidence: "docs/runtime-http-disconnect-certification.json",
    platform: "darwin",
    predecessorExecutable:
      "a69d21b724f053b90453e29d9dd408523c4cfc40b76974bdebcc4ff302a286bf",
    source: {
      build: "fe46ad3fa836f61192ee29d76695082ced3d571857716442a22031e45eef79a2",
      contract: "effectory.execution/v1",
      effect: "4.0.5",
    },
    sourceStorage: 1,
    targetContract: "effectory.execution/v1",
    targetEffect: "4.0.5",
    targetStorage: 3,
  },
  {
    architecture: "arm64",
    evidence: "docs/runtime-upgrade-certification.json",
    platform: "darwin",
    predecessorExecutable:
      "a17138f58bb9f1514d12e4bbcb54fa610067f993bd87f14caca0edf5cc55f13f",
    source: {
      build: "9f1797ddc28f42ceb77fa8dac1c8806da9207d00a568a792874216237b965f97",
      contract: null,
      effect: "4.0.5",
    },
    sourceStorage: 1,
    targetContract: "effectory.execution/v1",
    targetEffect: "4.0.5",
    targetStorage: 3,
  },
  {
    architecture: "arm64",
    evidence: "docs/runtime-upgrade-format2-certification.json",
    platform: "darwin",
    predecessorExecutable:
      "02c99046b503871a62a6b50c579ad83ba8e2ade44ae3ad78b80ce72029a058d0",
    source: {
      build: "677f3350bff79f245d1fe4f76ef98610767981875529cf5948949bbefd507cdc",
      contract: "effectory.execution/v1",
      effect: "4.0.5",
    },
    sourceStorage: 2,
    targetContract: "effectory.execution/v1",
    targetEffect: "4.0.5",
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
