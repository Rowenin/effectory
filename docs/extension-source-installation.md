# Installing extensions from source

Install a repository or a directory within it, at a branch, tag or full commit SHA:

```sh
effectory extension add github:Rowenin/effectory@<tag-or-commit> \
  --path extensions/agent-runner --as Agents --trust
```

Omit `--path` for an extension at the repository root. Add runs through the repository daemon and returns an operation receipt; `operation get <id>` reports completion. Installation generates `effectory.extensions.ts`. Select the descriptor with `Extension.use(Agents)` in your application and supply any services its tasks require.

Commit `effectory.extensions.lock.json` alongside your application. The lock records the requested ref and path, resolved 40-character commit, exact Bun/Effect/SDK versions, dependency lock digest, compiler version and built archive digest. It does not depend on a GitHub release or npm publication.

## Another computer

Install the same Effectory version, Git and the locked Bun version. Authenticate with `gh auth login` for a private GitHub repository. After cloning your application:

```sh
effectory extension restore --trust
```

A missing bundle is rebuilt from the locked commit and verified against the lock. Restoring never re-resolves the original tag or branch. `--trust` authorizes building missing source bundles and loading the resulting extension; it is required before source dependency installation or compilation. Cached bundles restore offline without build tools or another trust flag. A fresh rebuild needs access to GitHub and the dependencies in the committed Bun lockfile, or corresponding local caches. Git submodules and symlinks are not supported by the source builder.

Updates are explicit:

```sh
effectory extension outdated
effectory extension update offtree/agent-runner --to <original-ref> --trust
effectory extension update offtree/agent-runner --to <new-tag-or-commit> --trust
```

The first command only checks whether the requested ref now resolves to a different commit. Update resolves the ref supplied with `--to`; pass the original tag or branch to refresh a moved ref. A failed build or digest mismatch leaves the active installation unchanged.

## Author contract

The selected directory contains `package.json` and `effectory.extension.source.json`. The nearest ancestor `bun.lock`, within the repository, supplies dependencies. Its adjacent `package.json` must pin `packageManager` to `bun@<host-version>`. The extension declares exact peer dependencies matching the host's `effect` and `@offtree/effectory-sdk` versions. Include TypeScript as a locked development dependency. Ordinary local workspace packages may supply build dependencies. Outside this workspace, make the matching SDK available as a locked development dependency, for example from its [release archive](binary-distribution.md#releasing).

For example, a task extension's metadata looks like:

```json
{
  "format": 1,
  "id": "acme/tools",
  "capabilities": ["process"],
  "contracts": { "file": "src/contracts.ts", "export": "contracts" },
  "entrypoint": { "file": "src/extension.ts", "export": "default" },
  "contributions": {
    "artifacts": [],
    "implementations": [],
    "patches": [],
    "tasks": [{ "id": "acme/tools/run", "name": "Run", "version": 1 }],
    "workflows": []
  },
  "dependencies": {}
}
```

Contributions must match the executable descriptor and contract exports; validation runs after trust is granted. The extension version comes from its `package.json`. See the [agent runner metadata](../extensions/agent-runner/effectory.extension.source.json) for a complete example.

The host runs `bun install --frozen-lockfile --ignore-scripts`, invokes the locked TypeScript compiler with host-generated declaration settings, and bundles the two entry points with Bun. Repository build scripts, TypeScript plugins and lifecycle scripts are not invoked. Libraries that require installation scripts or custom code generation must commit the generated source or use the prebuilt archive format. Effect, the SDK and declared extension imports remain external; other imported packages are bundled with a dependency inventory and available license files. Public declarations should expose host peers, local declarations or declared extension contracts; consumers do not install bundled implementation dependencies.

Builds use canonical archive headers and manifests. Restore requires the original build toolchain and identical output, even across computers: a difference fails verification instead of accepting new bytes. Source builds run with the user's permissions, as do installed extensions; declared capabilities describe intent rather than providing an OS sandbox.

## Prebuilt archives

Existing release locks continue to work. Choose an archive explicitly when desired:

```sh
effectory extension add github:Rowenin/effectory@<release> \
  --asset effectory-agent-runner.tgz --as Agents --trust
```

`--asset` and `--path` are mutually exclusive. Archive restores fetch the locked release asset and verify its digest, without source dependency installation or compilation.
