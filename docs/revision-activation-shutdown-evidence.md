# Revision activation during shutdown

The lifecycle audit identified two boundaries absent from the previous tests: shutdown while a new application Layer is preparing, and shutdown after publication while the old active revision is still releasing its resources. The new regression is [`revision-activation-shutdown.test.ts`](../packages/platform-bun/test/revision-activation-shutdown.test.ts).

Both cases use the real revision catalog, bundled application import, Effect Layers and repository SQLite lease. A scoped activation worker has the same ownership nesting as the administration worker. File gates hold application cleanup open; the test waits for a recorded shutdown request before making assertions. It does not infer cleanup from elapsed time.

## Observed boundaries

- **Preparing:** the candidate has acquired its resource but has not completed Layer construction. Shutdown interrupts preparation, runs its finalizer, and retains the old active pointer. The candidate has no published manifest. On restart the incomplete candidate directory is discarded and the current source is acquired afresh.
- **Published:** the new active pointer is durable, but the old active pin's finalizer is gated. Shutdown waits for that cleanup, then releases the new application. Restart loads the published current revision.
- In both cases a competing real repository lease fails while cleanup is open. The shutdown fiber remains incomplete, neither resource has finished release, and each resource subsequently releases exactly once. Repository ownership becomes available only afterward.

Both cases pass against the existing production implementation. No runtime behavior, public API, source ABI or certified executable changed. The first scratch test attempts exposed test-harness mistakes (reading the marker before creation and using unexported helper names), not runtime failures. The final tests use explicit synchronization and the installed Effect APIs.

## Verification

The focused catalog/borrower/native-Activity lifetime group passed **11 tests, zero failures, 70 assertions across four files** in 2.73 seconds. Typecheck and formatting/lint passed. The only addition to the 450-file certified-release source selection is this test; the existing files are byte-identical. The full suite passed **711 tests, zero failures, 6,065 assertions across 167 files** in 1,159.17 seconds. All 451 captured files remained unchanged, with no additions or omissions during verification.

Logs and source inventory are under `/tmp/effectory-activation-shutdown/`. This is graceful interruption and resource-ownership evidence. It does not establish finalizer execution after SIGKILL, a bound on arbitrary author finalizers, a new bundle-pruning policy, or a live HTTP extension-change shutdown test. The existing process-kill upgrade and recovery proofs remain separate.

Evidence SHA-256:

- `typecheck.log`: `659cd0cb96e417abbda0d6caaf5958ba03c82d8840f3ada7a6b25dbea92eeca9`.
- `check.log`: `97236d1034d6dfe32e5758ca1ca93d0f6a5a095cbd4d3cebc02190adc825244a`.
- `focused.log`: `520fb9da44c463695cd3a1b3f063b1afc58f3140dcb96113a3e48c1be11e533e`.
- `full-tests.log`: `acb7769425b4f9a6916508e72131d41ee515c16705c9b1acb86f788e3a07f17c`.
- `source-manifest.json`: `6dad23a74c3313ae82dbc24dab6db49a3c8f3c07a8308fad80406aac93c343b8`.
- `source-stability.json`: `56f71e42d951156f774b3a49706f95f66d4ba91f80bdcb405f985f9f5935f994`.
