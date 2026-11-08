import { expect, test } from "bun:test";

import { commitMessageProblems } from "./commit-message.ts";

test("conventional headers with optional scopes and breaking marks pass", () => {
  for (const message of [
    "feat: add vault rotation",
    "fix(cli): report daemon start failures",
    "feat(platform-bun)!: drop format 1 bundles",
    "chore(main): release 0.2.0",
    "docs: explain releases\n\nRelease-please reads these commits.\n\nBREAKING CHANGE: none",
    "Merge branch 'main' into davidr/release",
  ]) {
    expect(commitMessageProblems(message)).toEqual([]);
  }
});

test("git comment lines are ignored, as git strips them", () => {
  expect(
    commitMessageProblems(
      "fix: keep receipts\n# Please enter the commit message\n"
    )
  ).toEqual([]);
});

test("free-form, unknown types and malformed headers fail", () => {
  expect(commitMessageProblems("Add vault rotation")).toHaveLength(1);
  expect(commitMessageProblems("feature: add vault rotation")[0]).toContain(
    "not a commit type"
  );
  expect(commitMessageProblems("fix:missing space")).toHaveLength(1);
  expect(commitMessageProblems("fix(CLI): uppercase scope")).toHaveLength(1);
  expect(commitMessageProblems("")).toEqual(["The message is empty."]);
});

test("long headers and a missing blank line fail", () => {
  expect(commitMessageProblems(`fix: ${"x".repeat(100)}`)[0]).toContain(
    "characters"
  );
  expect(commitMessageProblems("fix: a\nbody right away")).toEqual([
    "Leave a blank line between the header and the body.",
  ]);
});

test("autosquash commits pass only where history is still local", () => {
  expect(commitMessageProblems("fixup! fix: a")).toHaveLength(1);
  expect(
    commitMessageProblems("fixup! fix: a", { allowAutosquash: true })
  ).toEqual([]);
});
