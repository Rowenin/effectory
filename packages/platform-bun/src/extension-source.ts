import type {
  ExtensionSelector,
  ResolvedExtensionSource,
} from "@effectory/runtime/extension-protocol";
import {
  GitHubSource,
  ResolvedSource,
  extensionLimits,
  GitRepositorySource,
} from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Context, Effect, Layer, Schema } from "effect";

import { runBounded } from "./bounded-process.ts";
import { digest } from "./extension-archive.ts";

export const GhCommand = Context.Service<{
  readonly run: (
    args: readonly string[],
    byteLimit: number
  ) => Effect.Effect<Uint8Array, OperationError>;
}>("effectory/GhCommand");
export const ExtensionSource = Context.Service<{
  readonly resolve: (
    source: typeof ExtensionSelector.Type
  ) => Effect.Effect<typeof ResolvedExtensionSource.Type, OperationError>;
  readonly download: (
    source: typeof ResolvedExtensionSource.Type
  ) => Effect.Effect<Uint8Array, OperationError>;
}>("effectory/ExtensionSource");
const unavailable = () =>
  new OperationError({
    code: "Unavailable",
    message:
      "GitHub request failed. Check gh is installed, gh auth status, repository access, and the release asset.",
  });
const invalid = (message: string) =>
  new OperationError({ code: "InvalidInput", message });

export function parseSource(
  source: string,
  assetName?: string,
  extensionPath?: string
) {
  const match = /^github:(?<repository>[^@]+)@(?<ref>.+)$/u.exec(source);
  if (!match) {
    throw invalid("Use github:owner/repository@ref");
  }
  if (assetName === undefined) {
    return Schema.decodeUnknownSync(GitRepositorySource)({
      kind: "git",
      path: extensionPath ?? ".",
      ref: match.groups?.ref,
      repository: match.groups?.repository,
    });
  }
  if (extensionPath !== undefined) {
    throw invalid("Choose a source path or a release asset");
  }
  return Schema.decodeUnknownSync(GitHubSource)({
    assetName,
    ref: match.groups?.ref,
    repository: match.groups?.repository,
  });
}
export function ghCommandLayer(command: readonly string[] = ["gh"]) {
  return Layer.succeed(GhCommand, {
    run: (args, maximumBytes) =>
      runBounded([...command, ...args], {
        environment: {
          ...process.env,
          GH_DEBUG: "",
          GH_PAGER: "cat",
          GH_PROMPT_DISABLED: "1",
        },
        failure: unavailable,
        maximumBytes,
      }),
  });
}
export const ghLayer = ghCommandLayer();
const Release = Schema.Struct({
  assets: Schema.Array(
    Schema.Struct({
      digest: Schema.optionalKey(Schema.NullOr(Schema.String)),
      id: Schema.Int,
      name: Schema.String,
      size: Schema.Int,
    })
  ).check(Schema.isMaxLength(1000)),
  draft: Schema.Boolean,
  id: Schema.Int,
  tag_name: Schema.String,
});
const Commit = Schema.Struct({ sha: Schema.String });
const endpoint = (repository: string, suffix: string) =>
  `repos/${repository}/${suffix}`;
const apiArgs = (url: string, accept: string) => [
  "api",
  "--hostname",
  "github.com",
  url,
  "--header",
  `Accept: ${accept}`,
  "--header",
  "X-GitHub-Api-Version: 2022-11-28",
];
const decodeJson = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  bytes: Uint8Array
) =>
  Effect.try({
    catch: () => invalid("GitHub returned unsupported release metadata"),
    try: (): unknown =>
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(() =>
          invalid("GitHub returned unsupported release metadata")
        )
      )
    )
  );
export const gitHubSourceLayer = Layer.effect(
  ExtensionSource,
  Effect.gen(function* () {
    const gh = yield* GhCommand;
    return {
      download: (source) =>
        Effect.gen(function* () {
          if ("kind" in source) {
            const git = yield* Effect.promise(
              async () => await import("./extension-git.ts")
            );
            return yield* git.download(source);
          }
          const checked = yield* Schema.decodeEffect(ResolvedSource)(
            source
          ).pipe(
            Effect.mapError(() => invalid("Invalid locked GitHub source"))
          );
          const bytes = yield* gh.run(
            apiArgs(
              endpoint(
                checked.repository,
                `releases/assets/${checked.assetId}`
              ),
              "application/octet-stream"
            ),
            extensionLimits.archiveBytes
          );
          if (
            bytes.length !== checked.size ||
            (checked.publisherDigest !== null &&
              digest(bytes) !== checked.publisherDigest)
          ) {
            return yield* invalid(
              "Release asset bytes disagree with the resolved asset metadata"
            );
          }
          return bytes;
        }),
      resolve: (source) =>
        Effect.gen(function* () {
          if ("kind" in source) {
            const git = yield* Effect.promise(
              async () => await import("./extension-git.ts")
            );
            return yield* git.resolve(source);
          }
          const checked = yield* Schema.decodeEffect(GitHubSource)(source).pipe(
            Effect.mapError(() => invalid("Invalid GitHub extension source"))
          );
          const raw = yield* gh.run(
            apiArgs(
              endpoint(
                checked.repository,
                `releases/tags/${encodeURIComponent(checked.ref)}`
              ),
              "application/vnd.github+json"
            ),
            1_048_576
          );
          const release = yield* decodeJson(Release, raw);
          if (release.draft || release.tag_name !== checked.ref) {
            return yield* invalid(
              "Extension source must select an exact published release tag"
            );
          }
          const matches = release.assets.filter(
            (asset) => asset.name === checked.assetName
          );
          const [asset] = matches;
          if (!asset || matches.length !== 1) {
            return yield* invalid(
              "The release must contain exactly one matching extension asset"
            );
          }
          const commit = yield* decodeJson(
            Commit,
            yield* gh.run(
              apiArgs(
                endpoint(
                  checked.repository,
                  `commits/${encodeURIComponent(checked.ref)}`
                ),
                "application/vnd.github+json"
              ),
              1_048_576
            )
          );
          const publisherDigest =
            asset.digest !== undefined &&
            asset.digest !== null &&
            asset.digest.startsWith("sha256:")
              ? asset.digest.slice(7)
              : null;
          return yield* Schema.decodeEffect(ResolvedSource)({
            ...checked,
            assetId: asset.id,
            commit: commit.sha,
            publisherDigest,
            releaseId: release.id,
            size: asset.size,
          }).pipe(
            Effect.mapError(() =>
              invalid("GitHub asset exceeds limits or has invalid metadata")
            )
          );
        }),
    };
  })
);
export const GitHubSourceLive = gitHubSourceLayer.pipe(Layer.provide(ghLayer));

/** Metadata-only discovery; GitHub's latest release is not a semantic-version comparison. */
export const latestRelease = (source: typeof ExtensionSelector.Type) =>
  Effect.gen(function* () {
    if ("kind" in source) {
      const git = yield* Effect.promise(
        async () => await import("./extension-git.ts")
      );
      const resolved = yield* git.resolve(source);
      return { ...source, ref: resolved.commit };
    }
    const gh = yield* GhCommand;
    const release = yield* decodeJson(
      Release,
      yield* gh.run(
        apiArgs(
          endpoint(source.repository, "releases/latest"),
          "application/vnd.github+json"
        ),
        1_048_576
      )
    );
    if (
      release.draft ||
      release.assets.filter((asset) => asset.name === source.assetName)
        .length !== 1
    ) {
      return yield* invalid(
        "Latest published release has no unique matching extension asset"
      );
    }
    return yield* Schema.decodeEffect(GitHubSource)({
      ...source,
      ref: release.tag_name,
    }).pipe(
      Effect.mapError(() => invalid("Latest release has an invalid tag"))
    );
  });
