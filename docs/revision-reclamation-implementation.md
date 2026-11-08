# Revision reclamation implementation

The user approved the [full contract](revision-retirement-api-draft.md) on 2026-11-08. Implementation is in progress. No CLI deletion command is exposed yet, and no new executable upgrade edge is certified.

## Implemented foundation

- `revision-reclaim-record.ts` defines the approved selector, preview, protection, receipt and inspection shapes using Effect Schema.
- `revision-reclaim-inventory.ts` inventories retained bundles under repository ownership without importing application code, opening SQLite or removing incomplete preparations. It validates content-addressed identity, manifest format, exact bundle-directory membership, regular files, sizes and digests. Reads use no-follow descriptors and detect substitution or changes while reading. External hard links are permitted; byte counts remain logical bytes.
- Six focused tests passed (21 assertions). They cover archived incompatible manifests, an import-throwing bundle that is never executed, preserved incomplete preparation, external hard links, unexpected files, symlink substitution, changed content, future manifest formats, all 128 retained revisions and refusal above the limit.
- Typecheck passed. These focused results do not replace the final full suite or executable transition proofs.

## Remaining implementation

1. A separate dependency scanner must protect **all** retained runs and nonremoved schedules, not reuse the unfinished-work predicate in `inspectUpgradeWork`. Validate report ownership, invocations, attempts, waits, recovery/outbox work and extension activation before choosing candidates. Share one million-row / 256 MiB budget across every visited header. Inspect only private database copies.
2. Bind previews to owner/platform, repository identity, active pointer, dependency state and exact file identities. Protect active and scheduled revisions and extension base/candidate revisions. Keep examples bounded without losing complete counts.
3. Implement bounded previews, durable acceptance, quarantine rename/unlink progress, explicit resume, immutable receipts and recreated-revision handling. No bundle may move before accepted intent is durable.
4. Wire `revision reclaim plan|apply|inspect`; gate startup, upgrades, offline maintenance, backup and restore during accepted deletion. Historical missing-revision diagnostics must identify the reclamation record.
5. Run every contract proof, including actual 128-slot exhaustion recovery, run-family reclamation, malformed dependencies, process kills at each durable boundary, restored pending deletion and old-writer refusal. Run the required full checks against frozen source.

Preserve `/tmp/effectory-http-disconnect/release2-bin/effectory-darwin-arm64` as the real predecessor: build `c26a3010cee6c4d7dac060b8a4b70388d5c856e5263ad764533db6a5ce9f7357`, SHA-256 `0d1ae6d32526f4deb52fa9733d3420112decc9a311de004d6aa305e01ec3f485`. Its existing certificate remains historical evidence, not certification of the new source.

The Codex empty-override amendment was explicitly deferred in the same user response. Do not change its current placement behavior as part of this implementation.
