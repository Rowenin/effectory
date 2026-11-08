# Report selection implementation evidence

The user approved the [selection contract](report-selection-api-draft.md). Implementation and final repository verification are complete. [Operator guide](report-selection.md).

## Implementation

- `Report.make` captures frozen classification tags and `required`. `Report.Selection` accepts encoded tag maps or existing typed bindings for schedule selectors. No new service, Layer, Scope or task context field is introduced.
- One resolver inspects compiled graph templates, including child workflows, branches, fan-out and selected extension patches. Admission, describe and plan use that resolver. Application construction validates schedule selectors after the report registry is built.
- Manual submission normalizes selectors before receipt lookup and resolves them after loading the pinned registry. Source insertion, selected report plan, decision and outbox are committed in the existing transaction. Empty selectors preserve the previous fingerprint.
- A nullable run column stores the decision. New root submissions supply it; historical rows remain absent. Run summaries do not carry the decision. Old captured plans decode with empty classification and `required: false`.
- The scheduler resolves outside reconciliation's transaction. Selection, decision and report-plan metadata are excluded from the schedule identity hash, preserving pending occurrences while updating the observed revision.
- CLI selection flags require `reports.selection.v1` before submission. The foreground path reuses its status response. No-flag submission retains its existing compatibility.

## Evidence

| Test | Coverage |
| --- | --- |
| `packages/core/test/report-selection.test.ts` | Eight precedence cases; frozen metadata; invalid, forged, bare and duplicate tag bindings; constructor and schedule validation; negative type assertions; actual compiled branch/fan-out/child/extension-patch traversal without handler execution; direct tasks matching both scopes |
| `packages/platform-bun/test/report-selection.test.ts` | Atomic rollback, captured decisions, request-key replay/conflict, no-op fingerprints, legacy plans and runs, empty selection creating neither sources nor retention holds, required attachment outcome filtering, pending scheduled occurrence preservation, decision bounds and summary omission |
| `packages/platform-bun/test/report-selection-cli.test.ts` | Real daemon, all five flags, direct-task selection, actual selected reporter execution, unchanged source outcome, invalid selectors creating no runs, shared HTTP body limit, describe/plan metadata, restart and deployment removing an attachment after its receipt was accepted |
| `packages/cli/test/watch-compat.test.ts` | An older-protocol HTTP server receives no submission when explicit selection flags are used, including background task/workflow commands |

Existing report, retention, reader, Vault and execution tests remain part of the full verification. These tests exercise the implementation; earlier scratch feasibility probes are not substituted for them. No independent implementation review or Linux run is claimed for this slice.

The code/test/build-input manifest is `/tmp/effectory-selection-final-manifest.json`. Verification logs are `/tmp/effectory-selection-final-typecheck.log`, `/tmp/effectory-selection-final-check.log` and `/tmp/effectory-selection-final-tests.log`. Final verification on 2026-11-06: `bun run typecheck`, `bun run check`, and `bun test` all passed. The suite passed **425 tests across 113 files, 3570 assertions, zero failures**, in 704.62 seconds. All **310 source, test, fixture and build-input hashes** matched the pre-run manifest, with no added files. This verification ran on macOS.
