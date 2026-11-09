import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";

import { digest } from "../src/extension-archive.ts";
import {
  ExtensionSource,
  GhCommand,
  ghCommandLayer,
  gitHubSourceLayer,
  parseSource,
} from "../src/extension-source.ts";
import { archiveFixture } from "./fixtures/extension-archive.ts";

const source = parseSource(
  "github:acme/private-tools@release/v1",
  "effectory.tgz"
);
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
test("GitHub resolution pins release, asset and commit identities; download uses the locked asset", async () => {
  const archive = await archiveFixture();
  const seen: string[][] = [];

  const fake = Layer.succeed(GhCommand, {
    run: (args) =>
      Effect.sync(() => {
        seen.push([...args]);
        // oxlint-disable-next-line prefer-destructuring -- gh api endpoint follows the hostname option.
        const endpoint = args[3];
        if (endpoint?.includes("releases/tags/") === true) {
          return bytes({
            assets: [
              {
                digest: `sha256:${digest(archive)}`,
                id: 20,
                name: "effectory.tgz",
                size: archive.length,
              },
            ],
            draft: false,
            id: 10,
            tag_name: "release/v1",
          });
        }
        if (endpoint?.includes("commits/") === true) {
          return bytes({ sha: "a".repeat(40) });
        }
        if (endpoint === "repos/acme/private-tools/releases/assets/20") {
          return archive;
        }
        throw new Error(`Unexpected API request: ${endpoint}`);
      }),
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* ExtensionSource;
      const resolved = yield* adapter.resolve(source);
      if ("kind" in resolved) {
        throw new Error("Expected release source");
      }
      expect(resolved.assetId).toBe(20);
      expect(resolved.releaseId).toBe(10);
      expect(resolved.commit).toBe("a".repeat(40));
      expect(yield* adapter.download(resolved)).toEqual(archive);
      expect(seen[0]?.[3]).toBe(
        "repos/acme/private-tools/releases/tags/release%2Fv1"
      );
      expect(seen[2]).toContain("Accept: application/octet-stream");
      expect(
        seen.every(
          (args) => args[1] === "--hostname" && args[2] === "github.com"
        )
      ).toBe(true);
      const changed = yield* adapter
        .download({ ...resolved, publisherDigest: "f".repeat(64) })
        .pipe(Effect.result);
      expect(changed._tag).toBe("Failure");
    }).pipe(Effect.provide(gitHubSourceLayer.pipe(Layer.provide(fake))))
  );
});

test("the gh process adapter bounds output and redacts process diagnostics", async () => {
  const script = path.join(import.meta.dir, "fixtures/gh-process.ts");
  const layer = ghCommandLayer([process.execPath, script]);
  await Effect.runPromise(
    Effect.gen(function* () {
      const command = yield* GhCommand;
      expect(
        new TextDecoder().decode(
          yield* command.run(["ok", "literal;$(not-a-shell)"], 100)
        )
      ).toBe("literal;$(not-a-shell)");
      const oversized = yield* command.run(["large"], 100).pipe(Effect.result);
      expect(oversized._tag).toBe("Failure");
      if (oversized._tag === "Failure") {
        expect(oversized.failure.code).toBe("LimitExceeded");
      }
      const failed = yield* command.run(["error"], 100).pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      if (failed._tag === "Failure") {
        expect(failed.failure.message).toContain("gh auth status");
        expect(failed.failure.message).not.toContain("secret-from-stderr");
      }
    }).pipe(Effect.provide(layer))
  );
});

test("cancelling a validation/download process waits for its physical exit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-child-"));
  const filename = path.join(directory, "pid");
  const script = path.join(import.meta.dir, "fixtures/gh-process.ts");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const command = yield* GhCommand;
        yield* command.run(["hang", filename], 100).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.succeed(new Uint8Array()),
          })
        );
      }).pipe(Effect.provide(ghCommandLayer([process.execPath, script])))
    );
    const pid = Number(await Bun.file(filename).text());
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
