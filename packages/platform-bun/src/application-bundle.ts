import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { ExtensionLock } from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Effect } from "effect";

import { bindingSource, bindingsFilename } from "./extension-bindings.ts";

export const digestOf = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const revisionUnavailable = (cause?: unknown) =>
  cause instanceof OperationError
    ? cause
    : new OperationError({
        code: "RevisionUnavailable",
        message:
          "Application could not be bundled or its retained revision could not be loaded",
      });
export const sourceConflict = () =>
  new OperationError({
    code: "Conflict",
    message:
      "Application source or active revision changed while the candidate was being prepared",
  });

export interface Bundle {
  readonly source: string;
  readonly inputs: ReadonlyMap<string, string | null>;
}

/** Capture the bytes actually parsed, so activation can detect edits during compilation. */
export function buildApplication(
  repository: string,
  lock?: typeof ExtensionLock.Type
) {
  return Effect.gen(function* () {
    const inputs = new Map<string, string | null>();
    const root = yield* Effect.try({
      catch: revisionUnavailable,
      try: () => realpathSync(repository),
    });
    const facade = bindingsFilename(root);
    const overlay = lock === undefined ? null : bindingSource(root, lock);
    let total = 0;
    const output = yield* Effect.tryPromise({
      catch: revisionUnavailable,
      try: () =>
        Bun.build({
          entrypoints: [path.join(root, "effectory.ts")],
          external: [
            "effect",
            "effect/*",
            "@effectory/core",
            "@effectory/core/*",
          ],
          format: "esm",
          minify: false,
          packages: "bundle",
          plugins: [
            {
              name: "effectory-source-snapshot",
              setup(builder) {
                if (overlay !== null) {
                  builder.onResolve(
                    { filter: /effectory\.extensions(?:\.ts)?$/u },
                    (args) => {
                      if (
                        args.path.startsWith(".") &&
                        path
                          .resolve(path.dirname(args.importer), args.path)
                          .replace(/\.ts$/u, "") ===
                          facade.replace(/\.ts$/u, "")
                      ) {
                        return { path: facade };
                      }
                    }
                  );
                }
                builder.onLoad({ filter: /.*/u, namespace: "file" }, (args) => {
                  if (
                    !["js", "jsx", "ts", "tsx", "json"].includes(args.loader)
                  ) {
                    throw new Error(
                      "Only JavaScript, TypeScript and JSON application modules are supported"
                    );
                  }
                  const filename = path.resolve(args.path);
                  const old = existsSync(filename) ? statSync(filename) : null;
                  if (
                    old !== null &&
                    (!old.isFile() || old.size > 16_777_216)
                  ) {
                    throw new Error("Application module exceeds its limit");
                  }
                  const actual = old === null ? null : readFileSync(filename);
                  inputs.set(
                    filename,
                    actual === null ? null : digestOf(actual)
                  );
                  const contents =
                    filename === facade && overlay !== null ? overlay : actual;
                  if (contents === null) {
                    throw new Error("Missing application module");
                  }
                  total += Buffer.byteLength(contents);
                  if (inputs.size > 1024 || total > 33_554_432) {
                    throw new Error(
                      "Application source snapshot exceeds its limit"
                    );
                  }
                  return { contents, loader: args.loader };
                });
              },
            },
          ],
          sourcemap: "none",
          target: "bun",
        }),
    });
    const [bundle] = output.outputs;
    if (!output.success || !bundle || output.outputs.length !== 1) {
      return yield* revisionUnavailable();
    }
    const source = yield* Effect.promise(() => bundle.text());
    if (Buffer.byteLength(source) > 16_777_216) {
      return yield* new OperationError({
        code: "LimitExceeded",
        message: "Application bundle exceeds 16 MiB",
      });
    }
    return { inputs, source } satisfies Bundle;
  });
}

export function assertUnchanged(inputs: Bundle["inputs"]) {
  for (const [filename, digest] of inputs) {
    const current = existsSync(filename) ? statSync(filename) : null;
    if (digest === null) {
      if (current !== null) {
        throw sourceConflict();
      }
    } else if (
      current === null ||
      !current.isFile() ||
      current.size > 16_777_216 ||
      digestOf(readFileSync(filename)) !== digest
    ) {
      throw sourceConflict();
    }
  }
}
