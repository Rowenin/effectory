# Nested operation Scopes — ownership correction

Status: implemented and fully verified, 2026-11-06. This is a private correctness fix to existing ArtifactStorage behavior, discovered while researching [Checks](workflow-checks-api-draft.md). It adds no public service, method, option or error. Checks and JUnit remain unapproved and unimplemented.

## Problem and reproduction

A task-local Layer could publish a binary stream whose source opens an Effect Scope and publishes JSON. The JSON publication succeeded, then the source hung while closing its Scope. That Scope had registered the invocation's close function. Close interrupted and awaited every owned operation, including the outer publication whose source was still closing the Scope: a self-wait cycle.

The reproduction used the real Task.make, Task.provide, Task.test and ArtifactStorage, without a stand-in Checks service. `/tmp/effectory-checks-research/nested-publish.ts` reached `source:inner-published` and failed to finish within the five-second subprocess deadline. The parent killed the stuck process and recorded the output in `nested-publish.log`. The existing private owner also reproduced the cycle independently in `ownership.ts nested-setup`.

The existing operation owner otherwise passed scratch probes for caller interruption, invocation close, partial Layer acquisition failure and interruption combined with a secret-bearing defect. After the correction, all five probes—including nested setup—passed against the actual modified private owner; `ownership-current-results.json` records those results. These are lifecycle probes, not durable storage tests.

## Correction

`packages/core/src/publication-lifetime.ts` tracks the active owned-operation ancestry in a private Effect Context.Reference. Each invocation has an identity distinct from every other invocation. A child operation inherits active frames; each frame becomes inactive when its fiber finishes.

When a nested operation or nested Layer opens a Scope, that Scope owns its resources, not the enclosing invocation. The owner therefore does not attach invocation-close finalizers to those inner Scopes. The nested operation is still supervised, and caller interruption or invocation close still interrupts and awaits it. Task-local Layer acquisition outside an owned operation retains its existing close finalizers and ordering.

Both the direct Scope registration and the MemoMap's Layer-acquisition wrapper use this distinction. Correcting only one would leave another route to the same cycle. Inactive frames are ignored and pruned when a new operation starts, so an explicitly captured/re-provided Context cannot indefinitely suppress normal acquisition-scope closure after its original operation has finished.

The correction uses ordinary Effect Context, Layer memoization and the existing fiber supervisor. There is no new resource Scope, persistent state or scheduling pool. Existing limits and publication commit fences remain unchanged.

## Regression tests

`packages/core/test/publication-nesting.test.ts` adds five cases:

- Nested Effect.scoped publication during task Layer setup completes and releases its source before the handler runs.
- A nested source Layer follows the same behavior; task Layer release still rejects late publications.
- A handled source failure releases its resources without closing the setup that handles it.
- A caller timeout interrupts and awaits the nested source, then permits a later publication in the same setup.
- Re-providing a captured Context after its operation has finished does not suppress ordinary invocation closure.

The focused run including existing artifact-storage and binary-artifact tests passed **23 tests and 93 assertions**. An initial version of the new tests inspected a nonexistent TestPublication.key property; the test assertions were corrected to check the published content. No SDK field was added.

`packages/platform-bun/test/publication-nesting-daemon.test.ts` bundles a real application, starts the daemon, submits the task, reads the terminal result, downloads and checks the outer binary bytes, then stops the daemon normally and checks that all three publications reached the real lake. It passed independently in roughly 6.6 seconds. A bounded run-status poll makes a recurrence fail instead of waiting forever for foreground observation.

## Verification

The required `bun run typecheck && bun run check && bun test` sequence passed. The full suite completed with **466 passing tests, zero failures and 3,795 assertions across 120 files**, in 887.24 seconds. Logs are `/tmp/effectory-checks-research/nesting-final-typecheck.log`, `nesting-final-check.log` and `nesting-final-tests.log`.

The full source/test/example manifest was captured in `/tmp/effectory-checks-research/nesting-final-manifest.json` (324 files). Fresh enumeration and hash comparison after the suite found no changed, added or removed files. Compared with the previous automatic-retention verification, the only source change is publication-lifetime.ts and the only added source-tree files are the two regression-test files above. Documentation edits have a separate final formatting/lint check in `nesting-doc-check.log`.

No independent review, Linux-only probe or compiled-binary verification is claimed for this correction. Existing daemon/test infrastructure is reused. No Checks implementation or public API approval is implied.
