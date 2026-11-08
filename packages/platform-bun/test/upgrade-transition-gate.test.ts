import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";

import { assertUpgradeIdle } from "../src/upgrade-transition-gate.ts";

const hash = (name: string) =>
  createHash("sha256").update(readFileSync(name)).digest("hex");
const planId = "f086cd4e-ad6f-4823-9777-3447372d1bf4";
const targetBuild = "b".repeat(64);
test("unfinished intent refuses normal writers without acknowledging or changing it", () => {
  const repository = mkdtempSync(
    path.join(tmpdir(), "effectory-upgrade-gate-")
  );
  try {
    expect(() => assertUpgradeIdle(repository)).not.toThrow();
    const directory = path.join(repository, ".effectory/upgrades");
    mkdirSync(directory, { recursive: true });
    expect(() => assertUpgradeIdle(repository)).not.toThrow();
    const filename = path.join(directory, "active.json");
    for (const phase of [
      "Protecting",
      "Migrating",
      "Publishing",
      "Aborting",
      "Complete",
      "UnknownFuturePhase",
    ]) {
      writeFileSync(
        filename,
        JSON.stringify({ format: 1, phase, planId, targetBuild })
      );
      const before = hash(filename);
      let failure: unknown;
      try {
        assertUpgradeIdle(repository);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(OperationError);
      if (!(failure instanceof OperationError)) {
        throw new TypeError("Expected an OperationError");
      }
      expect(failure.code).toBe("RevisionUnavailable");
      expect(failure.message).toContain(planId);
      expect(failure.message).toContain(targetBuild);
      expect(hash(filename)).toBe(before);
    }
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});
test.each([
  "future-format",
  "corrupt",
  "oversized",
  "symlink",
  "hardlink",
  "directory",
  "parent-symlink",
])(
  "unsupported transition %s refuses without exposing contents or modifying another file",
  (kind) => {
    const repository = mkdtempSync(
      path.join(tmpdir(), "effectory-upgrade-gate-")
    );
    try {
      const directory = path.join(repository, ".effectory/upgrades");
      mkdirSync(directory, { recursive: true });
      const victim = path.join(repository, "unrelated");
      writeFileSync(victim, "CANARY-not-in-error");
      const before = hash(victim);
      const filename = path.join(directory, "active.json");
      if (kind === "symlink") {
        symlinkSync(victim, filename);
      } else if (kind === "hardlink") {
        linkSync(victim, filename);
      } else if (kind === "directory") {
        mkdirSync(filename);
      } else if (kind === "parent-symlink") {
        rmSync(directory, { recursive: true });
        symlinkSync(victim, directory);
      } else {
        let contents = "CANARY-not-in-error";
        if (kind === "future-format") {
          contents = JSON.stringify({ format: 2, planId, targetBuild });
        } else if (kind === "oversized") {
          contents = "x".repeat(65_537);
        }
        writeFileSync(filename, contents);
      }
      let failure: unknown;
      try {
        assertUpgradeIdle(repository);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(OperationError);
      if (!(failure instanceof OperationError)) {
        throw new TypeError("Expected an OperationError");
      }
      expect(failure.code).toBe("RevisionUnavailable");
      expect(failure.message).not.toContain("CANARY");
      expect(hash(victim)).toBe(before);
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  }
);
