# Working in Effectory

This repository is being rebuilt from scratch. Earlier design notes live in `docs/`.

## Third-party integrations

Use Alchemy's Distilled SDKs for third-party services wherever they provide the required capabilities. Prefer their Effect-native operations and ordinary services/Layers over Promise SDK wrappers or custom HTTP clients. Check compatibility with the pinned Effect version and document any concrete coverage gap before choosing another client. Preserve existing public contracts when migrating integrations; discuss public API or authentication changes with the user.

## Commits and releases

Every commit and pull request title is a [Conventional Commit](https://www.conventionalcommits.org): `<type>(<optional scope>): <summary>`, at most 100 characters, with a blank line before any body. Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`, `style`. Scopes are lowercase, usually a package or area (`cli`, `platform-bun`, `sdk`, `runtime`, `extensions`).

- `feat` releases a minor version, `fix` and `perf` a patch; the other types never release. Mark a breaking change with `!` after the type or a `BREAKING CHANGE:` footer. Before 1.0, breaking changes bump the minor version.
- Write the summary for the changelog reader: what changed for users of Effectory, not how the code moved.
- `bun install` installs a `commit-msg` hook that rejects other messages; CI checks pull requests and pushes to `main`. Run `bun scripts/commit-message.ts --title "<message>"` to check one by hand.
- Do not edit versions or `CHANGELOG.md` by hand. release-please keeps a `chore(main): release X.Y.Z` pull request open; merging it publishes the GitHub Release. See [releasing](docs/binary-distribution.md#releasing).

## Checking your work

```sh
bun run typecheck && bun run check && bun test
```
