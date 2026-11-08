# Changelog

## [0.2.0](https://github.com/Rowenin/effectory/compare/v0.1.0...v0.2.0) (2026-11-08)


### ⚠ BREAKING CHANGES

* **deps:** Effect 4.0.6 and later make a declared task failure fatal when cleanup also dies, so such tasks no longer retry. Repositories created by v0.1.0 must run `effectory upgrade plan` and `apply` offline before the new daemon starts; other predecessors are not certified.

### Features

* **deps:** update Effect to 4.1.2 with strict type-aware checks ([b18931c](https://github.com/Rowenin/effectory/commit/b18931cc83e7ede2399f7e8aeb7fdb095ca6bfc8))

## [0.1.0](https://github.com/Rowenin/effectory/releases/tag/v0.1.0) (2026-11-08)

First public release.

- The CLI, daemon and runtime ship as one standalone binary for macOS and Linux (arm64 and x64, glibc and musl), installed with `install.sh` from GitHub Releases.
- `@offtree/effectory-sdk` ships as a tarball on each release; `effectory init` and `effectory upgrade` pin projects to it, and `effectory doctor sdk` checks the pins.
- The `offtree/aws-vault` extension is attached to the release.
