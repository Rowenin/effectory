import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as BunServices from "@effect/platform-bun/BunServices";
import { Engine, State, Test } from "@effectory/core";
import { Effect, Layer } from "effect";

import collection from "../effectory.ts";
import { implement } from "./implement.ts";
import { reviewBranch } from "./review-branch.ts";
import { verifyPr } from "./verify-pr.ts";

const layer = collection.layer.pipe(Layer.provideMerge(BunServices.layer));
const fake = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(effect);

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** A package whose `test` script exits with `testExit`. */
const project = (testExit: number) => {
  const dir = mkdtempSync(path.join(tmpdir(), "effectory-implement-"));
  temporary.push(dir);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { check: "true", test: `exit ${testExit}` },
    })
  );
  return dir;
};

const statusOf = (result: Test.RunResult, fqn: string): string | undefined =>
  result.nodes.find((node) => node.fqn === fqn)?.status;

describe("verify-pr", () => {
  test("runs every check, asserts each, and keeps one summary comment", async () => {
    const result = await fake(
      Test.run(verifyPr, {
        pr: 7,
        repo: {
          checks: [
            { args: ["-c", "echo ok"], command: "sh", name: "ok" },
            {
              args: ["-c", "exit 4"],
              command: "sh",
              name: "broken",
              severity: "medium",
            },
          ],
          clone: ".",
          name: "app",
          owner: "acme",
        },
      }).pipe(Effect.provide(layer))
    );
    expect(result.run.status).toBe("succeeded");
    expect(result.run.scope).toBe("acme/app#7");
    expect(
      result.asserts.map((assert) => [assert.passed, assert.severity])
    ).toEqual([
      [true, "high"],
      [false, "medium"],
    ]);
    // The run-lifetime worktree is gone; the comment stays with the scope.
    expect(result.resources.map((row) => row.fqn)).toEqual([
      "verify-pr/summary",
    ]);
    const comment = result.records.find(
      (record) => record.fqn === "verify-pr/summary"
    );
    expect(comment?.input).toMatchObject({ number: 7, owner: "acme" });
    expect(JSON.stringify(comment?.input)).toContain("failed (exit 4)");
  });

  test("skips the comment when comment is false", async () => {
    const result = await fake(
      Test.run(verifyPr, {
        comment: false,
        pr: 8,
        repo: { checks: [], clone: ".", name: "app", owner: "acme" },
      }).pipe(Effect.provide(layer))
    );
    expect(statusOf(result, "verify-pr/summary")).toBe("skipped");
  });
});

describe("review-branch", () => {
  test("reviews per lens, passes without findings, and drafts a note", async () => {
    const result = await fake(
      Test.run(reviewBranch, {
        base: "HEAD",
        lenses: ["correctness", "security", "tests"],
        repo: ".",
      }).pipe(Effect.provide(layer))
    );
    expect(result.run.status).toBe("succeeded");
    expect(statusOf(result, "review-branch/review/tests")).toBe("succeeded");
    expect(statusOf(result, "review-branch/accept-findings")).toBe("skipped");
    expect(result.run.result).toMatchObject({
      findings: [],
      note: { title: "Fake change" },
    });
  });
});

describe("review-branch plan", () => {
  test("drafts the release note only after the findings gate", async () => {
    const planned = await fake(
      Effect.flatMap(Engine.Engine, (engine) =>
        engine.plan(
          reviewBranch,
          { base: "HEAD", repo: "." },
          { collection: "test", revision: "r1" }
        )
      ).pipe(
        Effect.provide(
          Engine.layer.pipe(
            Layer.provideMerge(State.memory),
            Layer.provideMerge(layer)
          )
        )
      )
    );
    const note = planned.entries.find(
      (entry) => entry.fqn === "review-branch/release-note"
    );
    expect(note?.dependsOn).toContain("review-branch/accept-findings");
  });
});

describe("implement", () => {
  test("stops after the first attempt whose checks pass", async () => {
    const result = await fake(
      Test.run(implement, {
        attempts: 2,
        repo: project(0),
        request: "Add a feature",
      }).pipe(Effect.provide(layer))
    );
    expect(result.run.status).toBe("succeeded");
    expect(statusOf(result, "implement/test-1")).toBe("succeeded");
    expect(statusOf(result, "implement/implement-2")).toBe("skipped");
    expect(statusOf(result, "implement/test-2")).toBe("skipped");
    expect(statusOf(result, "implement/accept-failing-checks")).toBe("skipped");
    expect(result.asserts.map((assert) => assert.passed)).toEqual([true]);
  });

  test("retries with the failures and asks for approval when checks still fail", async () => {
    const result = await fake(
      Test.run(implement, {
        attempts: 2,
        repo: project(1),
        request: "Add a feature",
      }).pipe(Effect.provide(layer))
    );
    expect(result.run.status).toBe("suspended");
    const retry = result.records.find(
      (record) => record.fqn === "implement/implement-2"
    );
    expect(JSON.stringify(retry?.input)).toContain("these checks fail");
    expect(statusOf(result, "implement/accept-failing-checks")).toBe(
      "suspended"
    );
    expect(result.asserts.map((assert) => assert.passed)).toEqual([false]);
  });
});
