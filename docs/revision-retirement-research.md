# Retained revision maintenance gap

This is source research and a catalog probe, not an approved deletion API. The [upgrade contract](runtime-upgrade-api-draft.md) explicitly separates unloading application Layers from physical bundle pruning and requires a previewed lifecycle operation before deleting bundles.

## Reproduced limit

`revisions.ts` retains a successfully prepared candidate's manifest even if it is never activated. Its scoped validation resources release normally, but the bundle continues to count toward the 128 retained-revision limit.

A scratch probe used the actual catalog, bundler, application Layers and repository ownership implementation. It created one active revision and prepared 127 different candidates, closing each candidate's borrow without activating it. It submitted no runs and constructed no host store or workflow engine.

- All 128 revision directories had been retained.
- Preparing candidate 129 failed with `LimitExceeded: Retained application revision limit reached (128)`.
- Restarting the catalog with that unretained source also failed with the same error during initial preparation.
- Restoring the original source allowed startup with its original active revision.

The script and successful output are `/tmp/effectory-revision-retirement-research/limit.mjs` and `limit.log`. This proves catalog behavior, not a real daemon command at the limit. The disposable directory was removed. No production code changed.

## Existing maintenance does not reclaim these slots

Run-family reclamation removes eligible completed execution history and retains compact submission identities. Its approved contract expressly retains revision bundles and extension archives. Automatic artifact retention likewise does not delete code. Scoped catalog loading fixes resource retention, but does not make room for a new retained revision.

This is an operational limit even when none of the prepared candidates has ever executed. Manually deleting arbitrary directories is not an established recovery procedure: historical operations, reports, schedules and partially published extension changes can need a particular revision.

## Dependencies to resolve before proposing deletion

A deletion preview must distinguish these references rather than reuse the upgrade inventory unchanged:

- The active pointer and any interrupted extension-activation intent. `extension-journal.ts` publishes an application revision as part of registry activation; pending administrative operations also capture a base application revision.
- Retained runs, including completed ones. Completed source runs can still be used for report regeneration or historical definition/provider operations. The upgrade inventory counts only unfinished runs and is therefore insufficient for pruning.
- Report sources, generations, retries and bulk cancellation work. Their source revision is pinned through the source run, and orphaned rows must refuse inspection rather than silently lose protection.
- Schedule definitions and pending occurrences. Nonpending schedule definitions still reference an application revision, so considering only the upgrade inventory's pending admissions is insufficient.
- Compact retired-run identities. These intentionally keep a revision string after execution history is reclaimed; whether that alone protects bundle files is a public lifecycle choice, not an automatic consequence of a string reference.
- Immutable compatibility metadata and recovery images. Deleting an unused bundle must not relabel retained bundles, erase upgrade receipts or mutate an existing verified copy.

An initial policy could preserve every revision used by any retained run, then let existing run-family reclamation release that dependency. It would recover never-used candidates without breaking report retries or silently changing historical describe behavior. The command shape, selection rules and treatment of compact retired identities still need a concrete reviewed proposal and user discussion. No deletion implementation or automatic pruning is authorized by this research.

The subsequent [upgrade implementation](runtime-upgrades.md) certifies two exact Darwin ARM64 predecessor/source-format combinations to storage 3. The same-format candidate was rejected after an actual old offline writer modified its state. Any retirement implementation changes the host digest again and needs its own old/new executable proof; the current `fe46ad…` release is retained as that future predecessor. A same-storage edge must be demonstrated, never inferred from the contract label.

## Actual daemon reproduction after upgrade verification

The [durable evidence record](revision-retirement-limit-evidence.json) stores the successful result, exact probe source and hashes. The probe used the frozen release runtime source to prepare one active revision and 127 never-activated candidates, then used the real compiled `fe46ad3fa836f61192ee29d76695082ced3d571857716442a22031e45eef79a2` executable (SHA-256 `a69d21b724f053b90453e29d9dd408523c4cfc40b76974bdebcc4ff302a286bf`) for startup and execution.

- Candidate preparation retained exactly 128 manifests with no submitted runs.
- The compiled daemon on candidate 129 exited **5**, reporting `Retained application revision limit reached (128)`.
- Restoring the original source let the same compiled daemon start. A real foreground `task run value --input '{}'` succeeded and returned `candidate-0`; graceful daemon stop completed.
- No bundle was deleted, and no manifest was relabelled. The successful disposable repository and logs remain under the recorded scratch directory.

The first probe arrangement mixed working directories between source preparation and compiled startup. Bun's generated path comments made the original source produce a different bundle digest, so the restoration assertion failed. The corrected probe runs both under the repository directory. The failed setup is recorded separately and is not proof of restoration.

## Dependency findings for the proposal

The following are source findings, not deletion tests:

- `upgrade-work.ts` records only nonterminal runs and pending schedule admissions. Reusing its result as a deletion allowlist would omit completed runs and paused/nonpending definitions. A separate dependency inventory is necessary.
- `report-records.ts` checks the retained source revision before creating a report retry. Keeping all retained source runs avoids silently removing regeneration code.
- `schedule-store.ts:reconcile` changes a nonremoved definition's revision on normal reconciliation. Removed rows remain historical; `tick` immediately returns for them, and `mutate` only toggles pause state and clears pending slots. Re-adding a definition uses the new revision. This supports distinguishing live definitions from inert removed metadata.
- `extension-journal.ts` stores an operation's `baseApplicationRevision` and, during activation, an explicit `applicationRevision`. Queued/running operations and activation intents protect code; settled receipts are historical data. The early request-key lookup returns the stored operation before resolving new work.
- `run-retirement.ts` deliberately retains compact identities after full history is removed. Preserving those revision strings does not itself require executable bundle bytes; adopting that distinction is a public lifecycle decision.

The [concrete command and policy proposal](revision-retirement-api-draft.md) is ready for user discussion. It remains unapproved and unimplemented. It protects every retained run and live schedule/administrative dependency, allows explicit offline removal of unreferenced bundles, and requires journaled resume after interrupted acceptance. It does not add automatic run cleanup or delete extension archives.
