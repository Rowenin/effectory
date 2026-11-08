# Verification assertions and JUnit — research

Status: design research, 2026-11-06. No Checks/JUnit implementation or user approval. This follows the verified automatic-artifact-retention slice. The [proposed contract](workflow-checks-api-draft.md) requires public API discussion before implementation. Subsequent lifecycle research identified an existing ArtifactStorage deadlock; its separate [private ownership correction](invocation-nested-scope-fix.md) does not implement the proposal.

## Upstream capability, read from source

Swamp's `assert` workflow task evaluates an asynchronous CEL predicate, records its boolean result, message and severity, and can invoke external model methods. Its default severity is high; the run's default `--fail-on` threshold is low. False results below the threshold remain recorded failures but are allowed to continue. Fan-out creates individual assertion cases. See `vendor/swamp/design/primitives/workflows.md:2428–2510` and the assert paths in `vendor/swamp/src/domain/workflows/execution_service.ts`.

`vendor/swamp/src/presentation/renderers/workflow_run_junit.ts` consumes `assert_result` events. It exports only assertions, groups them by job, records false as `<failure>` and evaluation errors as `<error>`. Severity filtering influences its run-failure decision; it does not remove failures from the XML. Thus a successful CLI exit under a high threshold can accompany a failing JUnit document. No assertions produces a warning and zero testcases. Cancellation and suspension also write the accumulated document. This is source evidence, not a run of Swamp.

`vendor/swamp/src/cli/commands/workflow_run.ts` implements `--junit` and `--out`; it rejects JSON mode, detached JUnit runs and multi-input batches. The renderer writes directly to the requested file and overwrites it. There is no claim here of atomic installation or crash-safe export in Swamp.

## Current Effectory boundaries

- `packages/core/src/workflow.ts` has task/map/branch/fan-out/child/wait/sleep nodes, but no assertion node. Mapping every existing task to a JUnit case would not implement Swamp's explicit assertion model.
- `packages/core/src/task.ts` already supplies invocation-owned services inside `definition()`, outside task-local Layer acquisition. Its public requirement exclusions cover Tag.Values, ArtifactStorage, Report.History and ArtifactReader. A new runner-owned Checks service must be added consistently to these exclusions and the SDK module sharing manifest.
- `taskLayer` preserves errors declared in the task's error schema and turns undeclared Layer errors into defects. `AssertionFailed` can therefore remain an ordinary declared domain error, including normal retry selection; no implicit error union is needed.
- `packages/platform-bun/src/interpreter.ts` builds each runtime context with attempt and entry identity. `packages/platform-bun/src/recovery-store.ts` increments entry on actual re-entry, including idempotent replay. This gives checks an existing execution identity without adding a public context field.
- `packages/core/src/publication-lifetime.ts` owns child fibers, propagates caller interruption, and closes operations before task-local Layer resources release. Its mechanisms are reusable for check evaluation. Reuse requires real integration tests; the present probe does not establish it.
- Task progress/log events have a separate 1,000-entry/1 MiB per-run budget (`host-store.ts`, telemetry). Check correctness cannot depend on those best-effort records surviving. It requires its own bounded rows; human progress can announce results without being the export source.
- Native task Activities own task execution results. Checks are observations within an entry, not new durable activities. Re-entry may evaluate them again. A stored Passed check does not authorize skipping the surrounding task's external work.
- `run-outputs.ts` reads full native outputs and can refuse a single output above its 2 MiB page limit. JUnit should not fetch every task output or serialize task inputs/results/error details.
- `vault-tracker.ts`, `task-logger.ts` and task result/error encoding already protect known secrets. A new persisted check message must use the attempt tracker before writing, and must not store raw predicate errors or defects. Identifiers cannot be rewritten into colliding keys.
- `packages/cli/src/main.ts` currently prints a final Run JSON from `observe`; JUnit launch mode needs an output choice in that flow, preserving accepted-run recovery hints and existing exit behavior. No JUnit/threshold flags exist today.

## Executed feasibility probe

Scratch directory: `/tmp/effectory-checks-research/`. `probe.ts` defines a labelled stand-in Checks Context.Service and AssertionFailed schema, then imports the real Task module. `tsconfig.json` extends the repository settings. The commands were:

```sh
node_modules/.bin/tsc --project /tmp/effectory-checks-research/tsconfig.json
bun /tmp/effectory-checks-research/probe.ts
```

Both passed. The compiler rejects an Effect<number> predicate; predicate dependencies and errors are retained. A real Task with declared AssertionFailed/ProbeUnavailable errors, provided with ordinary Layers, runs through real Task.test. A false value at the threshold fails with AssertionFailed; false below the threshold succeeds; an evaluation error keeps the original typed value. The output is saved in `probe.log`; compiler output is in `typecheck.log`.

This proves signature feasibility and ordinary Effect composition only. The fake uses an in-memory array and does not record evaluation errors, supervise fibers, implement limits, persist anything, scrub secrets or export XML. The future runner-owned requirement exclusion is not present; the probe explicitly supplies Checks. No new API has been tested as an SDK implementation.

`selection.ts` is a separate synthetic SQLite model. It proves that selecting through the latest admitted attempt/entry excludes a previous attempt even when its replacement emitted no check rows, and excludes earlier manual re-entry observations. Its query plan uses indexed run/sequence traversal and indexed attempt lookups. `selection.log` records the result. This is neither a scale benchmark nor production migration/query testing; implementation must bound candidate work separately from SQL LIMIT.

### Additional ownership evidence

`ownership.ts` exercises the real private publication owner with a stand-in observation callback. Caller interruption, invocation close, Layer-acquisition failure cleanup and secret-defect sanitation passed. Nested Scope closure during acquisition deadlocked. `nested-publish.ts` then reproduced that issue through existing public ArtifactStorage APIs, without Checks. A scratch guard resolved all five lifecycle cases; the [subsequent private fix and real regressions](invocation-nested-scope-fix.md) cover the existing SDK and daemon. Future Checks must preserve that ancestry distinction rather than attaching an invocation-close finalizer to a predicate's inner Scope.

This adds lifecycle evidence only. Check-row crash recovery, status reconciliation, paging, threshold admission and XML export are still unimplemented proof obligations. The previous presentation's wording is corrected: **raising** the failure threshold from low to high lets lower-severity false results continue; lowering it makes execution stricter.

### XML scalar and whitespace probe

`xml.ts` is a standalone proposed encoder, not SDK/CLI code. Eight cases cover metacharacters, quotes, tabs/newlines/carriage returns, forbidden controls, lone surrogates, BMP noncharacters, valid astral Unicode and valid formatting characters. XML 1.0-forbidden scalars become U+FFFD; whitespace in data uses numeric references. Python's actual xml.etree.ElementTree parser recovered both the attribute and text values exactly after this normalization. `xml-results.json` records the result. This checks escaping rules only, not JUnit consumer compatibility, terminal export selection or failure recovery.

## Selection and tradeoffs

Recommend a Checks service used by ordinary tasks, rather than a new graph expression evaluator or a second verification-task engine. External probes use ordinary Effect services; literal predicates use Effect.succeed. Task retry, manual recovery, timeouts, extensions and reports continue to use their current machinery.

The proposed XML is reconstructible from a completed stored run. This differs deliberately from Swamp's event-accumulated partial output. It includes a synthetic run-outcome testcase so an infrastructure failure cannot appear as a fully green document merely because earlier assertions passed. Severity remains truthful in the assertion cases; CI can apply stricter treatment than the run threshold.

Remaining gaps are named in the contract: no CEL importer, skipped-case discovery for code that never called Checks, flaky-test XML dialect, or independent checkpoint/retry for an individual assertion. This feature does not close the full parity goal.
