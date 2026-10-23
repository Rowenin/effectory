import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Engine,
  Lifetime,
  Output,
  State,
  Test,
  Workflow,
} from "@effectory/core";
import { Effect, Layer, Schema } from "effect";

import { Shell } from "../src/shell.ts";
import { Worktree, makeWorktreeProvider } from "../src/worktree.ts";
import { processLayer } from "./harness.ts";

let base = "";
let origin = "";
let local = "";
let root = "";
let fakeRoot = "";
let mainCommit = "";
let prCommit = "";

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, stderr: "pipe", stdout: "pipe" }
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
};

const commit = (repo: string, file: string, content: string) => {
  writeFileSync(path.join(repo, file), content);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", `write ${file}`);
  return git(repo, "rev-parse", "HEAD");
};

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), "effectory-worktree-"));
  origin = path.join(base, "origin");
  local = path.join(base, "local");
  root = path.join(base, "worktrees");
  fakeRoot = path.join(base, "fake-worktrees");
  git(base, "init", "-q", origin);
  mainCommit = commit(origin, "README.md", "main\n");
  // A pull request head that only exists on the remote, as on GitHub.
  git(origin, "checkout", "-q", "-b", "feature");
  prCommit = commit(origin, "feature.txt", "pr\n");
  git(origin, "update-ref", "refs/pull/12/head", prCommit);
  git(origin, "checkout", "-q", "main");
  git(origin, "branch", "-q", "-D", "feature");
  git(base, "clone", "-q", origin, local);
});

afterAll(() => {
  rmSync(base, { force: true, recursive: true });
});

const provider = () =>
  makeWorktreeProvider({ fakeRoot, root }).pipe(Layer.provide(processLayer));

const engineLayer = Engine.layer.pipe(Layer.provideMerge(State.memory));

const checkoutWorkflow = Workflow.make(
  "verify-pr",
  {
    description: "Check out a PR and read its HEAD",
    input: Schema.Struct({ ref: Schema.String }),
    scope: ({ ref }) => `acme/app:${ref}`,
  },
  Effect.fn(function* body({ ref }) {
    const checkout = yield* Worktree("checkout", {
      fetch: { remote: "origin" },
      ref,
      repo: local,
    }).pipe(Lifetime.run);
    const head = yield* Shell("head", {
      args: ["rev-parse", "HEAD"],
      command: "git",
      cwd: checkout.path,
    });
    return {
      head: Output.map(head, (result) => result.stdout.trim()),
      path: checkout.path,
      recorded: checkout.head,
    };
  })
);

const run = (ref: string, mode: "live" | "fake") =>
  Effect.runPromise(
    Effect.flatMap(Engine.Engine, (engine) =>
      engine.run(
        checkoutWorkflow,
        { ref },
        {
          collection: "test",
          mode,
          revision: "r1",
        }
      )
    ).pipe(
      Effect.provide(Layer.mergeAll(engineLayer, provider(), processLayer))
    )
  );

// Every test drives real git; give them room when the whole suite runs in parallel.
describe("Worktree", () => {
  test("Test.provider: live git worktrees", async () => {
    const report = await Effect.runPromise(
      Test.provider(Worktree, {
        cases: {
          create: { ref: "main", repo: local },
          replace: {
            path: path.join(base, "explicit"),
            ref: "main",
            repo: local,
          },
          update: {
            fetch: { remote: "origin" },
            ref: "pull/12/head",
            repo: local,
          },
        },
        layer: provider(),
        mode: "live",
      })
    );
    expect(report.steps.map((step) => step.name)).toEqual([
      "create",
      "noop",
      "update",
      "replace",
      "delete",
      "recover",
    ]);
    expect(existsSync(path.join(base, "explicit"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    expect(git(local, "worktree", "list", "--porcelain")).not.toContain(root);
  }, 30_000);

  test("a run-lifetime checkout of a fetched PR ref is removed when the run finishes", async () => {
    const summary = await run("pull/12/head", "live");
    expect(summary.run.status).toBe("succeeded");
    const result = summary.run.result as {
      head: string;
      path: string;
      recorded: string;
    };
    expect(result.head).toBe(prCommit);
    expect(result.recorded).toBe(prCommit);
    expect(result.path.startsWith(root)).toBe(true);
    expect(existsSync(result.path)).toBe(false);
    expect(git(local, "worktree", "list", "--porcelain")).not.toContain(
      result.path
    );
  }, 30_000);

  test("a moved branch is an update", async () => {
    const layer = Layer.mergeAll(engineLayer, provider());
    const scoped = Workflow.make(
      "track",
      { description: "", input: Schema.Struct({}), scope: () => "track" },
      () => Worktree("checkout", { ref: "main", repo: local })
    );
    const runOnce = Effect.flatMap(Engine.Engine, (engine) =>
      engine.run(
        scoped,
        {},
        { collection: "test", mode: "live", revision: "r1" }
      )
    );
    const [first, second] = await Effect.runPromise(
      Effect.gen(function* moveBranch() {
        const before = yield* runOnce;
        commit(local, "next.txt", "next\n");
        const after = yield* runOnce;
        return [before, after];
      }).pipe(Effect.provide(layer))
    );
    const before = first?.run.result as { head: string } | undefined;
    const after = second?.run.result as
      | { head: string; path: string }
      | undefined;
    expect(before?.head).toBe(mainCommit);
    expect(after?.head).toBe(git(local, "rev-parse", "main"));
    expect(git(after?.path ?? "", "rev-parse", "HEAD")).toBe(after?.head ?? "");
    git(local, "worktree", "remove", "--force", after?.path ?? "");
  }, 30_000);

  test("fake mode makes an empty directory and removes it", async () => {
    const report = await Effect.runPromise(
      Test.provider(Worktree, {
        cases: {
          create: { ref: "main", repo: local },
          replace: { ref: "main", repo: path.join(base, "other") },
          update: { ref: "pull/12/head", repo: local },
        },
        layer: provider(),
      })
    );
    expect(report.steps).toHaveLength(6);
    expect(readdirSync(fakeRoot)).toEqual([]);

    const summary = await run("pull/12/head", "fake");
    expect(summary.run.status).toBe("succeeded");
    const result = summary.run.result as { head: string; recorded: string };
    // Shell really runs in the fake checkout, which is not a git repository of its own.
    expect(result.recorded).toBe("fake");
    expect(readdirSync(fakeRoot)).toEqual([]);
  }, 30_000);
});
