import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GitRepositorySource,
  ResolvedGitSource,
} from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import { buildSourceExtension } from "./extension-source-build.ts";
import { sourceCommand } from "./extension-source-command.ts";
import { hostVersions } from "./host-runtime.ts";

const failure = () =>
  new OperationError({
    code: "InvalidInput",
    message: "Git extension source is invalid or unavailable",
  });
const gitOptions = [
  "-c",
  "credential.helper=",
  "-c",
  "credential.https://github.com.helper=!gh auth git-credential",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "init.templateDir=",
  "-c",
  "protocol.ext.allow=never",
];
const remote = (repository: string) => `https://github.com/${repository}.git`;

export function resolve(input: typeof GitRepositorySource.Type) {
  return Effect.gen(function* () {
    const source = yield* Schema.decodeEffect(GitRepositorySource)(input).pipe(
      Effect.mapError(failure)
    );
    const command = yield* sourceCommand;
    let commit = source.ref;
    if (!/^[a-f0-9]{40}$/u.test(commit)) {
      let refs = [
        `refs/heads/${source.ref}`,
        `refs/tags/${source.ref}`,
        `refs/tags/${source.ref}^{}`,
      ];
      if (source.ref.startsWith("refs/tags/")) {
        refs = [source.ref, `${source.ref}^{}`];
      } else if (source.ref === "HEAD" || source.ref.startsWith("refs/")) {
        refs = [source.ref];
      }
      const output = new TextDecoder().decode(
        yield* command.run("git", [
          ...gitOptions,
          "ls-remote",
          "--",
          remote(source.repository),
          ...refs,
        ])
      );
      const lines = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(/\s+/u));
      const heads = lines.filter(
        ([, ref]) => ref?.startsWith("refs/heads/") === true
      );
      const tags = lines.filter(
        ([, ref]) => ref?.startsWith("refs/tags/") === true
      );
      if (heads.length > 0 && tags.length > 0) {
        return yield* new OperationError({
          code: "InvalidInput",
          message: "Git ref is ambiguous; use refs/heads/... or refs/tags/...",
        });
      }
      const selected =
        lines.find(([, ref]) => ref?.endsWith("^{}") === true) ?? lines[0];
      commit = selected?.[0] ?? "";
    }
    return yield* Schema.decodeEffect(ResolvedGitSource)({
      ...source,
      commit,
      toolchain: {
        bun: Bun.version,
        effect: hostVersions.effect,
        sdk: hostVersions["@offtree/effectory-sdk"],
      },
    }).pipe(Effect.mapError(failure));
  });
}

export function download(input: typeof ResolvedGitSource.Type) {
  return Effect.gen(function* () {
    const source = yield* Schema.decodeEffect(ResolvedGitSource)(input).pipe(
      Effect.mapError(failure)
    );
    if (
      source.toolchain.bun !== Bun.version ||
      source.toolchain.effect !== hostVersions.effect ||
      source.toolchain.sdk !== hostVersions["@offtree/effectory-sdk"]
    ) {
      return yield* new OperationError({
        code: "Conflict",
        message:
          "Pinned source build requires the original Bun, Effect and SDK versions",
      });
    }
    const command = yield* sourceCommand;
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        catch: failure,
        try: async () =>
          await realpath(
            await mkdtemp(path.join(tmpdir(), "effectory-source-"))
          ),
      }),
      (directory) =>
        Effect.gen(function* () {
          yield* command.run("git", [...gitOptions, "init", directory]);
          yield* command.run(
            "git",
            [
              ...gitOptions,
              "-C",
              directory,
              "fetch",
              "--depth=1",
              "--no-tags",
              "--",
              remote(source.repository),
              source.commit,
            ],
            { timeoutMillis: 120_000 }
          );
          const fetched = new TextDecoder()
            .decode(
              yield* command.run("git", [
                ...gitOptions,
                "-C",
                directory,
                "rev-parse",
                "--verify",
                "FETCH_HEAD^{commit}",
              ])
            )
            .trim();
          if (fetched !== source.commit) {
            return yield* new OperationError({
              code: "Conflict",
              message: "Fetched Git commit differs from the lock",
            });
          }
          yield* command.run(
            "git",
            [
              ...gitOptions,
              "-C",
              directory,
              "checkout",
              "--detach",
              source.commit,
            ],
            { timeoutMillis: 120_000 }
          );
          return yield* buildSourceExtension(directory, source, command);
        }),
      (directory) =>
        Effect.promise(
          async () => await rm(directory, { force: true, recursive: true })
        )
    );
  });
}
