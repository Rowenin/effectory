# Cancellation during shared revision acquisition

Status: verified against the current source and certified Darwin ARM64 executable. This audit found no production defect and changed no runtime code. The [evidence record](revision-shared-acquisition-evidence.json) preserves both probes, their results and executable identity.

## Boundary under test

The catalog shares application Layer acquisition through Effect's `RcMap`. Existing borrower tests cover an acquired revision, but a historical vault operation can also disconnect while that revision's Layer is still being built. One cancelled waiter must not interrupt acquisition needed by another; the last waiter must keep ownership through cleanup; subsequent access must not reuse an abandoned acquisition.

The direct probe used the real `revisionCatalogLayer`, a bundled application and actual Effect Layers. It activated another revision, then borrowed the inactive revision twice while its construction waited on a file gate. Two cases passed:

- Cancelling the first waiter left one acquisition alive. Opening the gate let the second borrower use it.
- Cancelling both waiters before opening the gate interrupted construction. Neither borrower obtained the registry.

In both cases the final cancellation remained pending while a resource finalizer waited on a separate gate. Releasing cleanup produced exactly one release. A later borrow performed a fresh acquisition and released it normally.

## Real HTTP and process proof

The same boundary passed through the actual compiled daemon, with a synthetic vault provider saved as an inactive historical revision. Two real `vault reveal --revision` processes waited for its construction. The four combinations were Ctrl-C or SIGKILL, with either one waiter cancelled before construction completed or both waiters cancelled during construction.

Every successful case recorded one shared acquisition, no premature release while the second waiter remained, exactly one cleanup after the last disconnect, and successful acquisition by a later request. The daemon stayed responsive while cleanup was gated and subsequently stopped with exit 0. Clients printed no secret bytes; their exits were 130 for Ctrl-C and 137 for SIGKILL.

The first HTTP probe waited only 300 milliseconds after starting the second CLI and saw cleanup after the first disconnected. A process being alive did not establish that its request had arrived. The corrected probe allowed 2.5 seconds for CLI startup and checked the resulting acquisition count and surviving read. All four cases then passed. The earlier assertion failure remains in the evidence rather than being reported as a runtime regression.

## Scope and verification

The executable is build `c26a3010cee6c4d7dac060b8a4b70388d5c856e5263ad764533db6a5ce9f7357`, SHA-256 `0d1ae6d32526f4deb52fa9733d3420112decc9a311de004d6aa305e01ec3f485`. All 460 source/configuration/fixture files still match the [757-test certification](runtime-http-disconnect-certification.json). These additional probes are separate evidence, not additional repository test-suite tests or a new upgrade certificate.

This does not guarantee cleanup after daemon SIGKILL, bounded completion of arbitrary finalizers, other platforms or other Effect versions. The probe uses synthetic local providers and no external credentials. Revision reclamation and the Codex empty-override correction remain separate proposed public changes awaiting user approval.
