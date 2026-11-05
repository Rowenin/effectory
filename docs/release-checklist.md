# Bounded v0 release checklist

This checklist covers the implementation roadmap's local Bun runtime. It distinguishes implemented behavior from evidence and from live distribution checks against real GitHub releases. The package is a source-workspace prototype at version 0.0.0; no registry publication or production certification is implied.

## Required local gate

Run from the repository root with the pinned dependencies:

```sh
bun install --frozen-lockfile
bun run typecheck && bun run check && bun test
```

The full required check passed on 2026-11-05: **121 tests across 31 files, 765 assertions**, plus typecheck and formatting/lint. After the final transport exit-code adjustment and addition of release scripts, typecheck/lint passed again and the affected CLI suites passed **3 tests with 22 assertions**. The fixture archive builder also ran successfully. Type fixtures are included in `typecheck`, including expected compile failures. Tests use isolated temporary repositories and real daemon/CLI processes where restart behavior matters. Upstream vendored tests are excluded.

| Gate | Evidence | Result |
| --- | --- | --- |
| M0: authoring and composition | Core `authoring`, `contracts`, `graph`, `extensions` tests; emitted extension declaration/facade checks in `extension-bindings.test.ts` | Passed |
| M1: persistence and ownership | `engine`, `host-store`, `runtime` tests: committed acceptance/outbox, stale ownership, native result reuse, manual uncertainty, wait-decision recovery | Passed |
| M2: complete consumer demonstration | `daemon.test.ts`: separate CLI submission, approval, process death, source change, retained revision, answer and lake query; `runtime.test.ts`: death after publication | Passed |
| M3: graph and interactions | `operators`, `runtime`, `cancellation-daemon` tests: branch/fan-out, linked child limits, retries/deadlines, callback-before-trigger-return, rejection/expiry/cancellation | Passed |
| M4: extension installation and activation | `extension-daemon`, `extension-runtime`, `extension-journal`, `extension-bootstrap`, `extension-bindings`, `extension-cache`, `extension-resolver`, `extension-archive`, `extension-source` tests | Passed; fault-injection fixtures plus live public/private install checks below |
| M5: control plane and bounded inspection | `discovery`, `host-store`, `operators`, `cli-delivery`, CLI `json-lines` tests: authorization-first paging, stable receipts, native outputs, filtered logs, watch handoff and slow/broken stdout | Passed |
| M5: lake semantics and work bounds | `query-fields`, `lake`, `lake-budget` tests: encoded schema types, independent expected query sets, compound predicates, ordering/projection, latest-as-of pages during writes, budget failure | Passed |
| M5: drain and diagnostics | `drain-daemon.test.ts`: persisted receipt, replacement-instance protection, process-exit observation, uncooperative async finalizer, read-only permission diagnostics | Passed |
| M5: storage exhaustion | `storage-full.test.ts`: real SQLite page limit, atomic failed admission/publication, retained accepted work, retry with original keys after space is available | Passed |
| M5: offline recovery | `backup.test.ts`: waiting run, pre-wait artifact, retained bundle and trusted extension restored at a new path after the original is removed; corrupted/incomplete snapshots refused | Passed |

All platform tests above are under `packages/platform-bun/test/`; core tests are under `packages/core/test/`. JSON-Lines tests are under `packages/cli/test/`.

## Live GitHub distribution gate

The real `gh` process adapter successfully downloaded public GitHub CLI asset `679195516` (`cli/cli`, release `v2.103.3`, `gh_2.103.3_checksums.txt`) twice on 2026-11-05. Both reads were 1,971 bytes and matched GitHub's published SHA-256 `f756e7859d90dbb5e85aae5194206c37da220bec9bac23d3d659078a8e766fdc`. This proves the public authenticated transport path; that text asset is not an Effectory extension.

**The live distribution gate passed on 2026-11-05.** With user authorization, the reviewed fixture was published to two new Rowenin repositories:

| Visibility | Release | Release ID | Asset ID |
| --- | --- | --- | --- |
| Public | [effectory-extension-fixture-public v1.0.0](https://github.com/Rowenin/effectory-extension-fixture-public/releases/tag/v1.0.0) | 435218881 | 713461560 |
| Private | [effectory-extension-fixture-private v1.0.0](https://github.com/Rowenin/effectory-extension-fixture-private/releases/tag/v1.0.0) | 435218938 | 713461716 |

Both assets are named `effectory.tgz`, contain 1,867 bytes and have SHA-256 `dacc0e9eb2034036a6b6bd55ed75acc656bce45114954816e9567af56baa4f34`. Both download checks verified GitHub's publisher digest. Both installation checks used the real `gh` adapter, installed through CLI/RPC, confirmed installation did not automatically select the extension, ran the explicitly selected task, and restored/restarted the same revision without invoking `gh`. Each workflow returned `formatted:loaded/a/b`. [Machine-readable evidence](release-evidence.json) records the source commits and full results. Fault-injection/update checks remain covered by the local suite; this live test does not claim every failure mode was induced against GitHub.

A reviewable fixture can be built without any external writes:

```sh
bun scripts/build-release-fixture.ts
```

This writes `dist/release-fixture/effectory.tgz`, its `manifest.json` and `sha256.txt`. It contains the tested `fixture/tools` task/contract package with emitted TypeScript declarations and canonical external SDK imports. It does not contain repository credentials. The exact archive listed above has been uploaded to both test releases; rebuilding does not overwrite those immutable release assets.

The read-only smoke check resolves an exact tag, downloads its locked asset twice, verifies size/publisher digest when present, and validates the Effectory manifest/file hashes without evaluating code:

```sh
bun scripts/verify-release-download.ts github:Rowenin/effectory-extension-fixture-public@v1.0.0 effectory.tgz
bun scripts/verify-release-download.ts github:Rowenin/effectory-extension-fixture-private@v1.0.0 effectory.tgz
```

For the `fixture/tools` archive produced above, the complete installation check is also scripted:

```sh
bun scripts/verify-release-install.ts github:Rowenin/effectory-extension-fixture-public@v1.0.0 effectory.tgz --trust-fixture
bun scripts/verify-release-install.ts github:Rowenin/effectory-extension-fixture-private@v1.0.0 effectory.tgz --trust-fixture
```

This creates a fresh temporary consumer and starts its daemon, installs the release through CLI/RPC, checks that installation alone did not select contributions, imports `Tools.tasks.Inspect` with its exported `Client` service, and runs a local workflow that consumes its result. It then stops the daemon, makes `gh` fail on every invocation, restores from the verified cache, and starts/runs the same pinned revision again. The final result includes release/asset IDs and archive digest. Owned temporary repositories and child processes are cleaned up.

`--trust-fixture` acknowledges that this check executes the privileged extension. Use the archive you reviewed and published; the download-only check does not evaluate code. The offline phase denies `gh` access and asserts no invocation; it is not a general network sandbox. The installation script has passed against both local GitHub responses and the real public/private releases listed above.

Repeat the selected update/old-waiting-run checks from `extension-daemon.test.ts` when testing another release. Record the exact release/asset IDs and hashes here; never record authentication tokens.

## Practical limits

- One trusted local owner, one daemon, in-process privileged application/extension code. Authentication and bounded RPCs do not sandbox code, CPU, synchronous event-loop blocking or application-owned allocations.
- RPC requests/results, graph expansion, handlers, query work, logs, pages and observers have finite advertised limits. These are resource bounds, not an RSS or throughput benchmark. A large graph can retain many individually bounded values; size workloads for available memory.
- Query scan time is checked between SQLite/scan/sort stages. It cannot preempt one synchronous SQLite call. Query tests compare independently calculated expected results and force a row-budget failure; they do not claim a separate full SQL reference engine or a stress benchmark.
- Loaded source bytes and the active revision are checked before activation. This is not an atomic snapshot of every possible module-resolution input. Keep source/dependency/config changes quiescent during startup or extension activation; retained runs always use their pinned bundle.
- Manual external-effect uncertainty becomes `NeedsAttention`. Inspection/cancellation are supported; arbitrary result injection, retry-anyway and compensation are deferred.
- Backups include plaintext credentials and local trust decisions and require the same host ABI. Host upgrades/migrations, automatic GC/TTL, binary artifacts, remote/cloud workers, cron, MCP, named configured behavior instances and a registry publishing pipeline remain outside bounded v0.

The [README](../README.md) and executable schemas are the current API reference. Older proposal documents describe future possibilities and should not be read as additional implemented guarantees.
