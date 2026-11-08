import { expect, test } from "bun:test";

import {
  certifiedStorageTransition,
  runtimeUpgradePolicy,
  upgradeRevisionDisposition,
} from "../src/upgrade-policy.ts";
import type { UpgradePolicy } from "../src/upgrade-policy.ts";

const source = { build: "a".repeat(64), storage: 1 };
// Synthetic matching rules only, never a release certificate or override of the production list.
const policy: UpgradePolicy = {
  architecture: "arm64",
  certified: [
    {
      architecture: "arm64",
      evidence: "synthetic-test-only",
      platform: "darwin",
      predecessorExecutable: "c".repeat(64),
      sourceBuild: source.build,
      sourceStorage: 1,
      targetContract: "test/v2",
      targetEffect: "4.0.5",
      targetStorage: 2,
    },
  ],
  execution: {
    certified: [],
    current: { build: "b".repeat(64), contract: "test/v2", effect: "4.0.5" },
  },
  platform: "darwin",
  storage: 2,
};
test("storage permission is exact and independent of executable revision compatibility", () => {
  expect(certifiedStorageTransition(policy, source)).toBe(policy.certified[0]);
  expect(
    certifiedStorageTransition(policy, { ...source, build: null })
  ).toBeUndefined();
  expect(
    certifiedStorageTransition(policy, {
      ...source,
      build: policy.execution.current.build,
    })
  ).toBeUndefined();
  expect(
    certifiedStorageTransition(policy, { ...source, storage: 2 })
  ).toBeUndefined();
  expect(
    certifiedStorageTransition({ ...policy, architecture: "x64" }, source)
  ).toBeUndefined();
  expect(
    certifiedStorageTransition({ ...policy, platform: "linux" }, source)
  ).toBeUndefined();
  expect(
    certifiedStorageTransition(
      {
        ...policy,
        execution: {
          ...policy.execution,
          current: { ...policy.execution.current, effect: "4.1.0" },
        },
      },
      source
    )
  ).toBeUndefined();
  expect(
    upgradeRevisionDisposition(
      { build: source.build, contract: null, effect: "4.0.5" },
      policy,
      true
    )
  ).toBe("Archived");
  expect(
    upgradeRevisionDisposition(
      { build: source.build, contract: null, effect: "4.0.5" },
      policy,
      false
    )
  ).toBe("Unavailable");
  expect(
    upgradeRevisionDisposition(policy.execution.current, policy, false)
  ).toBe("Executable");
  const release = runtimeUpgradePolicy();
  const certifiedPlatforms = ["darwin/arm64", "linux/x64"];
  expect(release.certified.length).toBe(
    certifiedPlatforms.includes(`${process.platform}/${process.arch}`) ? 1 : 0
  );
  for (const edge of release.certified) {
    expect(
      certifiedStorageTransition(release, {
        build: edge.sourceBuild,
        storage: edge.sourceStorage,
      })
    ).toBe(edge);
    expect(
      certifiedStorageTransition(
        { ...release, platform: "win32" },
        { build: edge.sourceBuild, storage: edge.sourceStorage }
      )
    ).toBeUndefined();
  }
});
