# Checks/JUnit implementation evidence

The user approved the [contract](workflow-checks-api-draft.md) on 2026-11-06. This record distinguishes implementation tests from the earlier research stand-ins. Full repository verification passed on 2026-11-06.

## Implementation

- The SDK exports Checks and AssertionFailed. The invocation installs its private binding alongside the existing services, removes only the runner-owned requirement and reuses the existing operation supervisor and nested-Scope ownership correction.
- Host SQLite rows are keyed by run, invocation, attempt, entry and check id. Start/finish transactions check the exact live reservation and lease; terminal/fenced/superseded entries cannot finish records. Completion faults retain Running for reconciliation. Candidate inspection and reconciliation use bounded indexed batches.
- Run storage migrates old rows to the default low threshold and decodes the actual column strictly. Default submission fingerprints and schedule identities remain unchanged. Nondefault schedule changes advance generation. Reports inherit the root's stored threshold.
- RunChecks returns bounded metadata pages in stored invocation order, then insertion sequence. Invocation positions remain private storage/cursor metadata; the public record stays as approved. The exporter preserves this order without reading task output payloads.
- The CLI capability-checks new features before submission, preserves foreground observation behavior and exit codes, and stages complete bounded XML before stdout or no-overwrite file installation. Run outcome is a separate testcase.

## Real implementation tests

- `packages/core/test/checks.test.ts`: lazy execution, threshold/caught-failure observations, typed errors and defects, nonboolean rejection, dependency inference including Scope, Layer acquisition/release, nested scoped publication, detached checks, cancellation cleanup, duplicate ids and message limits, and fake overrides.
- `packages/core/test/checks-secrets.test.ts`: tracked secrets in messages, identifiers and defect payloads; secrets learned during evaluation are scrubbed again at completion.
- `packages/core/test/checks-persistence.test.ts`: a failed completion write wins over a typed predicate failure, while interruption remains interruption.
- `packages/platform-bun/test/check-store.test.ts`: exact entry admission, live versus lost-owner records, stale and terminal writes, latest admission with no observations, empty continuation pages, query/principal isolation, entry/run budgets, fingerprint defaults and strict stored settings, injected transactional completion failure, and pagination through 10,000 actual records.
- `packages/platform-bun/test/schedule-store.test.ts`: low/default identity preservation, immutable settings, changed effective threshold advancing generation and inherited scheduled admission.
- `packages/platform-bun/test/report-records.test.ts`: report promotion inherits the stored threshold after reopening the database.
- `packages/cli/test/junit.test.ts`: Python ElementTree parses actual generated XML, checking Unicode repair, escaping/whitespace, counts, ordering and synthetic outcomes. Tests cover empty continuation pages, read failure, temporary cleanup, existing-file refusal, old capability refusal and incompatible flags.
- `packages/platform-bun/test/checks-daemon.test.ts`: actual bundled application, CLI and SQLite/native workflow engine. Checks cover threshold versus XML semantics, retry with an empty final entry, fan-out child invocation suites, approval exit 4, cancellation outcome, export after restart, SIGKILL during evaluation and after a completed check before Activity completion, and manual recovery requiring explicit authorization before another entry.

These tests exercise the implementation rather than stand-in services or engine models. The earlier baseline of 466 passing tests covered the ownership correction, not Checks/JUnit.

## Final verification

`bun run typecheck`, `bun run check` and `bun test` passed. The full suite completed with **488 passing tests, zero failures and 4,028 assertions across 126 files** in 781.84 seconds. The 335-file source/test/configuration manifest was unchanged throughout the suite. The final documentation-only edits passed formatting/lint afterwards.

The full-suite log is `/tmp/effectory-checks-research/checks-final-tests-v2.log`; the snapshot is `/tmp/effectory-checks-research/checks-final-manifest.json`. These local logs supplement the repository test cases; they are not required to rerun them.

## Boundaries

The process tests kill at observable persisted boundaries; they do not claim a kill at every CPU instruction. Transaction rollback is additionally fault-injected at completion. Check execution is not independently durable or an exactly-once external operation. Existing manual replay authorization remains authoritative. Full run-history retention, graph-language assertions and skipped cases for checks never reached remain outside this slice.
