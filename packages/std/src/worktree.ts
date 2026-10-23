/**
 * `Worktree` is a detached git worktree of a local repository, checked out at
 * a ref. Use it with `Lifetime.run` for a scratch checkout removed when the
 * run finishes:
 *
 * ```ts
 * const checkout = yield* Worktree("checkout", { repo: "/src/app", ref: `pull/${pr}/head`, fetch: { remote: "origin" } }).pipe(Lifetime.run);
 * yield* Shell("test", { cwd: checkout.path, command: "bun", args: ["test"] });
 * ```
 *
 * Path: `props.path`, or by default
 * `$EFFECTORY_HOME/worktrees/<repo name>-<digest(repo, scope, fqn)>`
 * (`EFFECTORY_HOME` defaults to `~/.effectory`), so different scopes never
 * share a checkout and a resumed run finds the one it made.
 *
 * Ref resolution: with `fetch`, or when `ref` does not resolve locally (then
 * from `origin`), the ref is fetched into a private ref
 * (`refs/effectory/worktrees/<digest>`), which makes `pull/12/head` work and
 * avoids racing on `FETCH_HEAD`. `diff` resolves the ref again, so a moved
 * branch is an update (with `fetch`, that means a fetch while planning).
 *
 * Fake mode creates an empty directory under
 * `<tmpdir>/effectory-fake-worktrees` (no git) with `head: "fake"`, so
 * commands that run in it still have a working directory.
 */
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Provider, Resource } from "@effectory/core";
import { Data, Effect, Schema } from "effect";

import { digest, effectoryHome, slug } from "./internal/home.ts";
import * as Process from "./process.ts";

const nonEmpty = Schema.String.check(Schema.isMinLength(1));

export const WorktreeProps = Schema.Struct({
  /** Fetch `ref` from `remote` before checking it out. */
  fetch: Schema.optionalKey(Schema.Struct({ remote: nonEmpty })),
  /** Where to check out; default under `$EFFECTORY_HOME/worktrees`. */
  path: Schema.optionalKey(nonEmpty),
  /** A branch, tag, commit, or remote ref such as `pull/12/head`. */
  ref: nonEmpty,
  /** Path of a local repository. */
  repo: nonEmpty,
});
type Props = typeof WorktreeProps.Type;

export const WorktreeAttributes = Schema.Struct({
  /** The checked-out commit. */
  head: Schema.String,
  path: Schema.String,
  ref: Schema.String,
});
type Attributes = typeof WorktreeAttributes.Type;

export const Worktree = Resource.make("Git.Worktree", {
  attributes: WorktreeAttributes,
  description: "A detached git worktree of a local repository at a ref",
  props: WorktreeProps,
});

/** A git operation on a worktree failed. */
export class WorktreeError extends Data.TaggedError("WorktreeError")<{
  readonly message: string;
}> {}

export interface WorktreeProviderOptions {
  /** Directory for default worktree paths. Default `$EFFECTORY_HOME/worktrees`. */
  readonly root?: string;
  /** Directory for fake-mode worktrees. Default `<tmpdir>/effectory-fake-worktrees`. */
  readonly fakeRoot?: string;
}

const realpath = (value: string) => {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};

const identity = (props: Props, scope: string, fqn: string) =>
  digest([realpath(props.repo), scope, fqn]);

const defaultPath = (root: string, props: Props, scope: string, fqn: string) =>
  path.join(
    root,
    `${slug(path.basename(path.resolve(props.repo)))}-${identity(props, scope, fqn)}`
  );

/** Replace on a new repo or path (old first: the path may be reused); update on a new ref. */
const classify = (olds: Props, news: Props): Provider.Diff | undefined => {
  if (
    path.resolve(olds.repo) !== path.resolve(news.repo) ||
    olds.path !== news.path
  ) {
    return { action: "replace", deleteFirst: true };
  }
  if (olds.ref !== news.ref || olds.fetch?.remote !== news.fetch?.remote) {
    return { action: "update" };
  }
  return undefined;
};

const git = (
  args: readonly string[],
  options: { readonly allowNonZeroExit?: boolean } = {}
) =>
  Process.exec({
    args: [...args],
    command: "git",
    env: { GIT_TERMINAL_PROMPT: "0" },
    maxOutputBytes: 4 * 1024 * 1024,
    timeoutMs: 600_000,
    ...options,
  }).pipe(
    Effect.mapError(
      (failure) =>
        new WorktreeError({
          message: `git ${args.join(" ")}: ${failure.message}`,
        })
    )
  );

/** Whether `target` is a registered worktree of `repo`. */
const registered = (repo: string, target: string) =>
  Effect.gen(function* isRegistered() {
    if (!existsSync(target)) {
      return false;
    }
    const listed = yield* git(["-C", repo, "worktree", "list", "--porcelain"]);
    const wanted = realpath(target);
    return listed.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .some((line) => realpath(line.slice("worktree ".length)) === wanted);
  });

const head = (target: string) =>
  git(["-C", target, "rev-parse", "HEAD"]).pipe(
    Effect.map((result) => result.stdout.trim())
  );

/** Resolve `props.ref` to a commit, fetching into `privateRef` when needed. */
const resolve = (props: Props, privateRef: string) =>
  Effect.gen(function* resolveRef() {
    if (props.fetch === undefined) {
      const local = yield* git(
        [
          "-C",
          props.repo,
          "rev-parse",
          "--verify",
          "--quiet",
          `${props.ref}^{commit}`,
        ],
        { allowNonZeroExit: true }
      );
      if (local.exitCode === 0) {
        return local.stdout.trim();
      }
    }
    const remote = props.fetch?.remote ?? "origin";
    yield* git([
      "-C",
      props.repo,
      "fetch",
      "--no-tags",
      "--quiet",
      remote,
      `+${props.ref}:${privateRef}`,
    ]);
    const fetched = yield* git([
      "-C",
      props.repo,
      "rev-parse",
      "--verify",
      `${privateRef}^{commit}`,
    ]);
    return fetched.stdout.trim();
  });

const live = (root: string) =>
  Effect.sync(() => {
    const privateRef = (props: Props, scope: string, fqn: string) =>
      `refs/effectory/worktrees/${identity(props, scope, fqn)}`;
    const targetOf = (props: Props, scope: string, fqn: string) =>
      path.resolve(props.path ?? defaultPath(root, props, scope, fqn));

    const service: Provider.ProviderService<
      Props,
      Attributes,
      Process.Service
    > = {
      delete: ({ fqn, olds, output, scope }) =>
        Effect.gen(function* deleteWorktree() {
          if (!existsSync(olds.repo)) {
            rmSync(output.path, { force: true, recursive: true });
            return;
          }
          if (yield* registered(olds.repo, output.path)) {
            yield* git([
              "-C",
              olds.repo,
              "worktree",
              "remove",
              "--force",
              output.path,
            ]);
          }
          yield* git(["-C", olds.repo, "worktree", "prune"]);
          yield* git(
            ["-C", olds.repo, "update-ref", "-d", privateRef(olds, scope, fqn)],
            { allowNonZeroExit: true }
          );
          // A directory left at a default path (e.g. an interrupted `worktree add`) is ours.
          if (path.dirname(output.path) === path.resolve(root)) {
            rmSync(output.path, { force: true, recursive: true });
          }
        }),
      diff: ({ fqn, news, olds, output, scope }) =>
        Effect.gen(function* diffWorktree() {
          const change = classify(olds, news);
          if (change !== undefined) {
            return change;
          }
          const commit = yield* resolve(news, privateRef(news, scope, fqn));
          return commit === output.head
            ? ({ action: "noop" } as const)
            : ({ action: "update" } as const);
        }).pipe(
          // Let reconcile report a ref that cannot be resolved.
          Effect.orElseSucceed(() => ({ action: "update" }) as const)
        ),
      read: ({ fqn, olds, output, scope }) =>
        Effect.gen(function* readWorktree() {
          const target = output?.path ?? targetOf(olds, scope, fqn);
          if (
            !existsSync(olds.repo) ||
            !(yield* registered(olds.repo, target))
          ) {
            return;
          }
          return {
            head: yield* head(target),
            path: target,
            ref: output?.ref ?? olds.ref,
          };
        }),
      reconcile: ({ fqn, news, output, scope }) =>
        Effect.gen(function* reconcileWorktree() {
          const target = output?.path ?? targetOf(news, scope, fqn);
          const commit = yield* resolve(news, privateRef(news, scope, fqn));
          if (yield* registered(news.repo, target)) {
            if ((yield* head(target)) !== commit) {
              yield* git([
                "-C",
                target,
                "checkout",
                "--quiet",
                "--detach",
                commit,
              ]);
            }
          } else {
            yield* git(["-C", news.repo, "worktree", "prune"]);
            if (existsSync(target)) {
              return yield* new WorktreeError({
                message: `${target} exists and is not a worktree of ${news.repo}`,
              });
            }
            mkdirSync(path.dirname(target), { recursive: true });
            yield* git([
              "-C",
              news.repo,
              "worktree",
              "add",
              "--quiet",
              "--detach",
              target,
              commit,
            ]);
          }
          return { head: commit, path: target, ref: news.ref };
        }),
    };
    return service;
  });

const fake = (root: string) =>
  Effect.sync(() => {
    const targetOf = (props: Props, scope: string, fqn: string) =>
      path.join(
        root,
        `${slug(path.basename(path.resolve(props.repo)))}-${identity(props, scope, fqn)}`
      );
    const service: Provider.ProviderService<Props, Attributes> = {
      delete: ({ output }) =>
        Effect.sync(() =>
          rmSync(output.path, { force: true, recursive: true })
        ),
      diff: ({ news, olds }) =>
        Effect.succeed(classify(olds, news) ?? { action: "noop" }),
      read: ({ fqn, olds, output, scope }) =>
        Effect.sync(() => {
          const target = output?.path ?? targetOf(olds, scope, fqn);
          return existsSync(target)
            ? { head: "fake", path: target, ref: output?.ref ?? olds.ref }
            : undefined;
        }),
      reconcile: ({ fqn, news, output, scope }) =>
        Effect.sync(() => {
          const target = output?.path ?? targetOf(news, scope, fqn);
          mkdirSync(target, { recursive: true });
          return { head: "fake", path: target, ref: news.ref };
        }),
    };
    return service;
  });

/** The Worktree provider with its directories; the live side needs `Process`. */
export const makeWorktreeProvider = (options: WorktreeProviderOptions = {}) =>
  Provider.dual(Worktree, {
    fake: Effect.suspend(() =>
      fake(
        path.resolve(
          options.fakeRoot ?? path.join(tmpdir(), "effectory-fake-worktrees")
        )
      )
    ),
    live: Effect.suspend(() =>
      live(
        path.resolve(options.root ?? path.join(effectoryHome(), "worktrees"))
      )
    ),
  });

/** The Worktree provider with default directories. Requires `Process`. */
export const WorktreeProvider = makeWorktreeProvider();
