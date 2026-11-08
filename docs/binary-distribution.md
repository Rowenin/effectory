# Binary distribution

The CLI, daemon and runtime ship as one standalone executable built with `bun build --compile`. Projects install only the authoring SDK (`@offtree/effectory-sdk` and `effect`) from npm, for types and editor support. The binary runs the project with its own built-in copies of those packages.

## Why the host provides `effect` and `@offtree/effectory-sdk`

The daemon interprets the values created by application code: it reads `Workflow.Builder` and `Application.Registry` services, checks `instanceof DefinitionError` and decodes with the application's schemas. That only works when application code and the host share one module instance of `effect` and `@offtree/effectory-sdk`. A second copy breaks tags, `instanceof` checks and schema classes.

A compiled binary keeps its modules in an embedded filesystem (`/$bunfs/...`) that code loaded from disk cannot import. Instead of linking a host copy into `.effectory/node_modules`, which was the earlier source-only approach, the host registers a Bun runtime plugin:

- `scripts/generate-host-modules.ts` writes `packages/platform-bun/src/host-modules.generated.ts`. It contains one lazy `require` for every public `effect` entry point (the named exports and every file matched by `./*`, excluding `internal/`) and every `@offtree/effectory-sdk` export, 402 in total for Effect 4.0.5. The lazy requires make the compiler include every module while evaluating only those that are imported.
- `installHostModules()` (`host-runtime.ts`) registers each specifier with `Bun.plugin`'s `builder.module(...)`, returning the host's own module namespace. Every later `import "effect/…"` or `import "@offtree/effectory-sdk"` from a retained revision bundle or an extension module resolves to the host instance, whether or not a `node_modules` folder exists.
- From source, a bare `require` inside the plugin would re-enter the virtual module, so source runs resolve each specifier to its file before registering.

The application bundle format does not change: `effect` and `@offtree/effectory-sdk` remain external imports of `application.mjs`.

Limitation: Bun does not run runtime `onResolve` hooks for bare package names. Unlisted paths such as `effect/rpc/internal/tracing` therefore are not intercepted. In a source run they fall back to `node_modules`; in a binary without `node_modules` they fail to load. Every public entry point is listed, and `bun test` fails when the table is stale.

## Host ABI

Retained revisions record a host ABI and are refused by a host with a different one. Source runs hash the host sources (`core/src`, `runtime/src`, `platform-bun/src`). The build script computes the same hash and embeds it with `--define EFFECTORY_HOST_ABI=…`, so a binary and a source checkout of the same commit accept each other's revisions.

## Re-entering the host

Processes the host starts for itself use `selfCommand(script, args)`. A source run uses `bun <script> …`; a binary runs itself with the same arguments. Extension validation runs in a separate process. In a binary that process is started as `effectory __effectory-internal validate-extensions …`, which `main.ts` dispatches before the normal CLI parser runs.

## SDK version alignment

The project's npm SDK provides types; the binary provides the runtime. They must match exactly. Like Swamp's `.swamp.yaml` `swampVersion`, the project records which Effectory version last set it up, in `package.json`:

```json
{ "effectory": { "version": "0.1.0" } }
```

| Command | Swamp counterpart | Behavior |
| --- | --- | --- |
| `effectory version` | `swamp version` | CLI version, host ABI, Bun version, whether compiled, and the built-in `effect` / `@offtree/effectory-sdk` versions |
| `effectory init [path]` | `swamp repo init [path]` | Writes `effectory.ts`, `tsconfig.json` and `.gitignore` entries if missing, then runs `upgrade`. The path defaults to `--repository` (the current directory). |
| `effectory upgrade` | `swamp repo upgrade` | Records this version in the marker and pins both SDK packages to exactly the host versions (keeping them in `dependencies` if they were already there); creates `package.json` if missing. Reports `previousVersion`. You then run your package manager. |
| `effectory doctor sdk` | `swamp doctor …` | Local, read-only: compares the marker with this binary and the nearest installed `node_modules/<name>` (searching upward, so hoisted workspaces work) with the host; exits 1 on any mismatch or missing entry. Plain `effectory doctor` still asks the running daemon. |
| `effectory daemon start` | none | Prints the same findings as a warning on stderr; it does not refuse to start |

Swamp has no SDK version check because its extensions import only `zod`, and the binary accepts any Zod 4. Effectory shares all of Effect and its own SDK, so types must match the runtime exactly.

## Building

```sh
bun scripts/build-binary.ts                          # this platform -> dist/bin/
bun scripts/build-binary.ts --target all             # darwin/linux, arm64/x64, glibc and musl
bun scripts/build-binary.ts --target bun-linux-x64 --outdir out
```

The script first checks that the generated module table is current, then writes one `effectory-<platform>` per target and a `SHA256SUMS` file. Each binary is about 80 MB, mostly Bun itself.

## Testing against a binary

`packages/cli/test/binary.test.ts` compiles the binary and runs `init`, `daemon start` and a workflow in a project with no `node_modules`. The process-level suites accept a binary in place of the source entry point:

```sh
bun scripts/build-binary.ts
EFFECTORY_BINARY=dist/bin/effectory-darwin-arm64 bun test packages/platform-bun/test/*daemon*.test.ts packages/platform-bun/test/backup.test.ts
```

## Releasing

A release is one version number shared by every package, the binaries and the npm SDK. Pushing a `v*` tag runs `.github/workflows/release.yml`:

1. **verify**: the tag must equal every `package.json` version; typecheck, lint and tests must pass.
2. **binaries**: on macOS, `build-binary.ts --target all`, a smoke run of the native binary, then a GitHub Release carrying each `effectory-<platform>`, `SHA256SUMS` and `install.sh`.
3. **npm**: `scripts/build-sdk.ts`, then `npm publish` of `@offtree/effectory-sdk` through npm trusted publishing (OIDC, no stored token; provenance is automatic). A tag with a prerelease suffix (`v0.2.0-rc.1`) becomes a GitHub prerelease and publishes under the npm `next` dist-tag.

`scripts/build-sdk.ts` compiles `packages/core` with `tsc` into `dist/sdk`: JavaScript with `.d.ts` files, a generated `package.json` whose export map points at them, `effect` as an exact peer dependency, and the README and MIT license. It rejects output that still imports `.ts` files or anything other than `effect`, then imports the built entry point. The source `package.json` stays `private`; only `dist/sdk` is published.

```sh
bun scripts/build-sdk.ts
(cd dist/sdk && npm pack --dry-run)
```

`install.sh` picks the asset for the OS and architecture (musl on Alpine, arm64 under Rosetta), verifies it against `SHA256SUMS` and installs it to `~/.effectory/bin` (`EFFECTORY_HOME`). `EFFECTORY_VERSION` selects a release, and `EFFECTORY_DOWNLOAD_BASE` points it at a mirror or a local directory (`file:///path/to/dist/bin`), which is how it is tested before a release exists.

### Cutting a release

```sh
# 1. Set the same version in package.json and packages/*/package.json, then commit.
# 2. Tag and push.
git tag v0.1.0
git push origin v0.1.0
```

### One-time setup

- npm cannot configure a trusted publisher for a package that does not exist yet, so the first version is published by hand: `npm login`, `bun scripts/build-sdk.ts`, `cd dist/sdk && npm publish --access public`.
- Then, on npmjs.com, `@offtree/effectory-sdk` → Settings → Trusted publishing → GitHub Actions: repository `Rowenin/effectory`, workflow `release.yml`, environment `npm`. Afterwards, set publishing access to require two-factor authentication and disallow tokens.
- Create the `npm` environment in the GitHub repository settings, optionally restricted to `v*` tags.

## Not yet implemented

- An `@offtree/effectory-cli` npm package. Like esbuild or Biome, it would need one package per platform plus a wrapper, each with its own trusted-publisher setup; binaries ship through GitHub Releases for now.
- A Homebrew tap and an `effectory update` self-updater (Swamp: `swamp update`).
- Code signing and notarization for macOS and Windows builds. Windows targets are not built yet.
- Running workflows in unit tests outside the binary (an SDK testing entry point or `effectory test`).
