import { Console, Effect, Layer } from "effect";

import {
  digest,
  verifyArchive,
} from "../packages/platform-bun/src/extension-archive.ts";
import {
  ExtensionSource,
  ghLayer,
  gitHubSourceLayer,
  parseSource,
} from "../packages/platform-bun/src/extension-source.ts";

const [source, asset] = process.argv.slice(2);
if (
  source === undefined ||
  source === "" ||
  asset === undefined ||
  asset === ""
) {
  throw new Error(
    "Usage: bun scripts/verify-release-download.ts github:owner/repository@tag asset-name"
  );
}

// Read-only transport smoke check. Never evaluates or installs downloaded code.
await Effect.runPromise(
  Effect.gen(function* () {
    const adapter = yield* ExtensionSource;
    const resolved = yield* adapter.resolve(parseSource(source, asset));
    if ("kind" in resolved) {
      throw new Error("Expected release source");
    }
    const first = yield* adapter.download(resolved);
    const second = yield* adapter.download(resolved);
    const sha256 = digest(first);
    if (sha256 !== digest(second)) {
      throw new Error("The same locked GitHub asset returned different bytes");
    }
    const verified = verifyArchive(first);
    yield* Console.log(
      JSON.stringify({
        assetId: resolved.assetId,
        bytes: first.length,
        commit: resolved.commit,
        extensionId: verified.manifest.id,
        extensionVersion: verified.manifest.version,
        publisherDigestVerified: resolved.publisherDigest !== null,
        releaseId: resolved.releaseId,
        sha256,
      })
    );
  }).pipe(Effect.provide(gitHubSourceLayer.pipe(Layer.provide(ghLayer))))
);
