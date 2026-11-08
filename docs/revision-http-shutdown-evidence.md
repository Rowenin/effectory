# Revision-backed HTTP reads during shutdown

The compiled Darwin ARM64 host used by the runtime-upgrade certification passed two real HTTP shutdown probes. An application supplied a synthetic read-only vault backend through `Vault.layer`; an actual `vault reveal` CLI request entered its read and waited indefinitely. No real credentials or external services were used.

The read's cleanup recorded its entry and waited on a filesystem gate. While cleanup was gated, the daemon was still alive and the application provider had not released. Opening the gate produced this exact order, once in each case:

```text
provider-acquired
reading
read-cleanup-start
read-cleanup-end
provider-released
```

Both `daemon stop` and SIGTERM followed that order. The reveal client exited 3 with no value on stdout. The daemon exited 0 for the stop command and 130 for SIGTERM, retaining the existing signal exit behavior. Thus the actual HTTP operation—not just a direct catalog borrower—retained its revision-backed provider through interrupted read cleanup.

This extends the [catalog activation/shutdown evidence](revision-activation-shutdown-evidence.md). It does not test concurrent HTTP extension activation, inactive historical revisions over HTTP, SIGKILL cleanup, or cleanup exceeding the daemon's two-second forced-shutdown deadline. The gate was released promptly after observing cleanup entry. Existing historical-borrower and repository-lease tests remain separate evidence.

## Verification and limits

The executable is `/tmp/effectory-format2-upgrade/release-bin/effectory-darwin-arm64`, SHA-256 `a69d21b724f053b90453e29d9dd408523c4cfc40b76974bdebcc4ff302a286bf`, build ABI `fe46ad3fa836f61192ee29d76695082ced3d571857716442a22031e45eef79a2`. It is the existing certified release, not a newly built candidate. Bun is 1.4.3 on Darwin ARM64.

The first probe also attempted a competing `upgrade plan` process with a one-second timeout while cleanup was gated. That process hit the probe's timeout; it did not establish either acquisition or refusal of repository ownership. The corrected probe removes that timing-dependent assertion. No production defect was observed or fixed.

The [machine-readable evidence](revision-http-shutdown-evidence.json) preserves the final probe and its process helper, results, initial failed log, executable hash and source-stability audit. Scratch projects and logs are under `/tmp/effectory-http-shutdown/`. The 457 source/configuration/fixture files from the last full verification remain unchanged. This turn adds documentation only; the earlier 748-test result is not reported as a newly run suite.
