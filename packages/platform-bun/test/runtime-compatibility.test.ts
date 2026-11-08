import { expect, test } from "bun:test";

import { Schema } from "effect";

import { hostAbi } from "../src/host-runtime.ts";
import { RevisionManifest } from "../src/revision-manifest.ts";
import { runtimeCertifications } from "../src/runtime-certifications.ts";
import {
  assertRevisionExecutable,
  executionCompatibility,
  executionContract,
  revisionExecutionIdentity,
  runtimeExecutionPolicy,
} from "../src/runtime-compatibility.ts";

const legacy = {
  digest: "d".repeat(64),
  effectVersion: "4.0.5",
  extensionDigests: [],
  format: 2,
  hostAbi: "a".repeat(64),
} as const;
const current = {
  build: "b".repeat(64),
  contract: executionContract,
  effect: "4.0.5",
};

test("execution identity is independent of build provenance but neither a shared label nor a package version certifies an edge", () => {
  const policy = { certified: [], current };
  expect(
    executionCompatibility(revisionExecutionIdentity(legacy), policy)
  ).toBe("Unavailable");
  const modern = Schema.decodeSync(RevisionManifest)({
    ...legacy,
    executionContract,
    format: 3,
  });
  expect(revisionExecutionIdentity(modern)).toEqual({
    build: legacy.hostAbi,
    contract: executionContract,
    effect: "4.0.5",
  });
  expect(
    executionCompatibility(revisionExecutionIdentity(modern), policy)
  ).toBe("Unavailable");
  expect(() => assertRevisionExecutable("retained", modern, policy)).toThrow(
    "no certified transition"
  );
  expect(executionCompatibility({ ...current, contract: null }, policy)).toBe(
    "ExactBuild"
  );
  expect(executionCompatibility(current, policy)).toBe("ExactBuild");
  expect(executionCompatibility({ ...current, effect: "4.0.6" }, policy)).toBe(
    "Unavailable"
  );
  expect(
    executionCompatibility({ ...current, contract: "future/v2" }, policy)
  ).toBe("Unavailable");
});

test("a release certification matches the complete predecessor identity and target contract, never a range of builds", () => {
  const source = revisionExecutionIdentity(legacy);
  // Synthetic policy fixture. This is not a certification of a shipped edge.
  const policy = {
    certified: [
      {
        evidence: "test fixture, not release evidence",
        predecessorExecutable: "c".repeat(64),
        source,
        targetContract: current.contract,
        targetEffect: current.effect,
      },
    ],
    current,
  };
  expect(executionCompatibility(source, policy)).toBe("Certified");
  expect(() =>
    assertRevisionExecutable("retained", legacy, policy)
  ).not.toThrow();
  for (const other of [
    { ...source, build: "e".repeat(64) },
    { ...source, contract: executionContract },
    { ...source, effect: "4.0.6" },
  ]) {
    expect(executionCompatibility(other, policy)).toBe("Unavailable");
  }
  expect(
    executionCompatibility(source, {
      ...policy,
      current: { ...current, contract: "future/v2" },
    })
  ).toBe("Unavailable");
  expect(
    executionCompatibility(source, {
      ...policy,
      current: { ...current, effect: "4.0.6" },
    })
  ).toBe("Unavailable");
});

test("production policy has no unproved predecessor mappings, and metadata decoding does not accept arbitrary format extensions", () => {
  const policy = runtimeExecutionPolicy();
  expect(policy.certified).toEqual(runtimeCertifications());
  expect(runtimeCertifications("linux", "arm64")).toEqual([]);
  expect(runtimeCertifications("darwin", "x64")).toEqual([]);
  // The v0.1.0 release executables, and only their fresh storage format.
  for (const [platform, architecture] of [
    ["darwin", "arm64"],
    ["linux", "x64"],
  ] as const) {
    const edges = runtimeCertifications(platform, architecture);
    expect(edges.map((edge) => edge.sourceStorage)).toEqual([1]);
    expect(edges[0]?.source).toEqual({
      build: "a8fa9264e18ea79615f9d7934ec510b8110d39ff305a9a2d8980aa1840baa7c9",
      contract: executionContract,
      effect: "4.0.5",
    });
    expect(runtimeExecutionPolicy().current.effect).toBe(
      edges[0]?.targetEffect ?? "missing"
    );
  }
  expect(() => assertRevisionExecutable("retained", legacy)).toThrow(
    "legacy host build"
  );
  expect(() =>
    assertRevisionExecutable("current", {
      ...legacy,
      effectVersion: runtimeExecutionPolicy().current.effect,
      hostAbi: hostAbi(),
    })
  ).not.toThrow();
  for (const manifest of [
    { ...legacy, format: 4 },
    { ...legacy, format: 3 },
    { ...legacy, executionContract, force: true, format: 3 },
    { ...legacy, executionContract: "bad contract", format: 3 },
  ]) {
    expect(() =>
      Schema.decodeUnknownSync(RevisionManifest)(manifest, {
        onExcessProperty: "error",
      })
    ).toThrow();
  }
});
