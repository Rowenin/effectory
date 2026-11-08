# Changelog

## [0.1.0](https://github.com/Rowenin/effectory/releases/tag/v0.1.0) (2026-11-08)

First public release.

- The CLI, daemon and runtime ship as one standalone binary for macOS and Linux (arm64 and x64, glibc and musl), installed with `install.sh` from GitHub Releases.
- `@offtree/effectory-sdk` ships as a tarball on each release; `effectory init` and `effectory upgrade` pin projects to it, and `effectory doctor sdk` checks the pins.
- The `offtree/aws-vault` extension is attached to the release.
