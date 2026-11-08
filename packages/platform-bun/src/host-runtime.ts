import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import corePackage from "@offtree/effectory-sdk/package.json" with { type: "json" };
import { plugin } from "bun";

import { effectVersion, hostModuleLoaders } from "./host-modules.generated.ts";

/** Replaced by `scripts/build-binary.ts` through `--define`. */
declare const EFFECTORY_HOST_ABI: string | undefined;

/** True inside a `bun build --compile` executable. */
export const compiled =
  import.meta.path.startsWith("/$bunfs/") ||
  import.meta.path.startsWith("B:/~BUN/") ||
  import.meta.path.startsWith("B:\\~BUN\\");

/** The SDK versions application and extension code runs against. */
export const hostVersions = {
  "@offtree/effectory-sdk": corePackage.version,
  effect: effectVersion,
} as const;

/** Hash of the host sources that define the retained-revision contract. */
export function sourceAbi() {
  const roots = [
    path.dirname(fileURLToPath(import.meta.resolve("@offtree/effectory-sdk"))),
    path.dirname(
      fileURLToPath(import.meta.resolve("@effectory/runtime/protocol"))
    ),
    import.meta.dir,
  ];
  const hash = createHash("sha256");
  for (const root of roots) {
    for (const filename of readdirSync(root)
      .filter((name) => name.endsWith(".ts"))
      .toSorted()) {
      hash.update(filename).update(readFileSync(path.join(root, filename)));
    }
  }
  return hash.digest("hex");
}

let abi: string | undefined;
/** A compiled binary carries the ABI of the sources it was built from. */
export function hostAbi() {
  abi ??=
    typeof EFFECTORY_HOST_ABI === "string" ? EFFECTORY_HOST_ABI : sourceAbi();
  return abi;
}

const installed = Symbol.for("effectory.hostModules");

/**
 * Serve `effect` and `@offtree/effectory-sdk` to every later import from this host's
 * own instances. Application revisions and extension modules are loaded from
 * disk and must share them. The table covers every public entry point, so a
 * project's own `node_modules` copy is never used for them. (Bun does not run
 * runtime `onResolve` hooks for bare packages, so unlisted internal paths are
 * not intercepted; a binary without `node_modules` simply cannot load them.)
 */
export function installHostModules() {
  if (Reflect.get(globalThis, installed) === true) {
    return;
  }
  // In a binary each loader requires a bundled module id. From source, a bare
  // specifier would re-enter the virtual module, so resolve files first.
  const loaders: Readonly<Record<string, () => object>> = compiled
    ? hostModuleLoaders
    : Object.fromEntries(
        Object.keys(hostModuleLoaders).map((specifier) => {
          const filename = Bun.resolveSync(specifier, import.meta.dir);
          // oxlint-disable-next-line node/global-require, unicorn/prefer-module -- Synchronous, lazily evaluated host module.
          return [specifier, () => require(filename) as object];
        })
      );
  plugin({
    name: "effectory-host-modules",
    setup(builder) {
      for (const [specifier, load] of Object.entries(loaders)) {
        // A module namespace is an object of its named exports.
        builder.module(specifier, () => ({
          exports: load() as Record<string, unknown>,
          loader: "object",
        }));
      }
    },
    target: "bun",
  });
  Reflect.set(globalThis, installed, true);
}

/** First argument of a hidden subcommand that runs host-internal processes. */
export const internalCommand = "__effectory-internal";

/**
 * A command line that re-enters this host. Source runs need the script path;
 * a compiled binary is its own entry point.
 */
export function selfCommand(script: string, args: readonly string[]) {
  return compiled
    ? [process.execPath, ...args]
    : [process.execPath, script, ...args];
}
