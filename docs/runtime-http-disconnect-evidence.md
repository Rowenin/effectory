# HTTP disconnect ownership correction

Status: implemented and verified. Typecheck, formatting/lint and the full 757-test suite passed, together with four real Darwin ARM64 upgrade matrices and exact-executable disconnect/shutdown proofs. The [certification record](runtime-http-disconnect-certification.json) preserves the source manifest, executable identities and results.

## Reproduced failure

The previously certified Darwin ARM64 executable (`fe46ad3fa836f61192ee29d76695082ced3d571857716442a22031e45eef79a2`) retained a vault operation after its CLI client disconnected. A synthetic provider was first saved as a revision, then made inactive by starting a different application. Two real `vault reveal --revision` clients borrowed that historical provider. Killing one client left its read running for the probe's ten-second observation window; the hard-killed client had exited 137. A separate Ctrl-C case exhibited the same lack of cleanup. The experiment used no real secrets or external services.

A smaller real-socket probe isolated the boundary: Bun delivered the request's abort signal, but Effect 4.0.5's `HttpEffect.toWebHandler` entered request handling with interruption masked. The RPC HTTP effect waited indefinitely for output, so its request scope did not close and send the RPC interruption. Server shutdown eventually closed the work; client disconnection alone did not.

This affects buffered control requests and streaming routes before their first frame. It is distinct from cancellation after a streaming response has transferred scope ownership to its body.

## Correction

The private `rpcWebHandler` restores interruption around the HTTP RPC effect with `Effect.interruptible`. Control, content and watch routes use that boundary. Effect's existing request scope, RPC disconnect handling, resource acquisition and finalizers retain ownership; there is no second cancellation protocol, polling worker or public API change.

The regression tests start actual Bun HTTP servers and abort requests before any response. The request's resource must close while the server and RPC scopes remain alive. Repeating more requests than each streaming route's permit count also proves that abandoned requests do not exhaust admission. All three tests fail without the correction and pass with it.

## Executable proof

The corrected executable passed both Ctrl-C and SIGKILL client-disconnect cases with an inactive historical revision:

1. Two clients share one provider acquisition.
2. Disconnecting the first client starts its cleanup; a file gate holds cleanup open. The provider and second client remain live.
3. After the first cleanup finishes, the second borrow still keeps the provider alive.
4. Disconnecting the second client and completing its cleanup releases the provider exactly once.
5. A later request reacquires that revision and releases it after disconnect, proving the earlier borrows did not leak.
6. The daemon remains responsive and subsequently stops normally. No client prints a secret value.

The initial content regression omitted the NDJSON newline and never reached its handler. That fixture was corrected before rerunning the complete failed-before/passed-after comparison. An initial attempt to build the incompatible upgrade fixture lacked workspace dependency links; copying those links repaired the fixture setup, without changing production dependencies.

## Release gates

The first actual storage-3 predecessor run found an independent executor gap: planning classified the certified transition as Ready, but supplied no migration steps for source storage 3, and the executor explicitly accepted only source formats 1 and 2. Apply refused before acceptance or mutation. The correction includes storage 3 in both checks and explicitly refuses a descending storage transition. The same existing credential, vault, extension and runtime ownership-transfer steps are used; native execution records are not migrated or relabeled.

Six component cases now cover storage-3 owner transfer with both an empty vault sentinel and real encrypted vault contents: completion, SIGKILL after the extension fence followed by resumption, and SIGKILL followed by an intervening edit that forces abort. They verify prior receipt bytes, vault contents/format, restored or transferred ownership, preservation of the intervening edit, and repeated receipt retrieval. These use synthetic policies and do not substitute for the actual executable transition matrix.

The candidate passed all required checks and actual predecessor/target, offline-writer and rollback matrices. The certified storage-3-to-storage-3 edge transfers host ownership; equal storage numbers alone do not grant an old writer permission. A fresh repository created by the same predecessor has no upgrade marker and still uses storage 1, so that is a separate explicit certification path. The earlier storage-1 and storage-2 predecessor paths also passed against this exact target executable: four matrices in total. Scratch probes, logs, binaries and the source manifest are under `/tmp/effectory-http-disconnect/`.

The full suite passed 757 tests with zero failures against 460 unchanged source/configuration/fixture files. Linux ARM64 component verification passed 19 tests with zero failures and 265 assertions across five files; that is not a Linux executable upgrade certificate. The prior 748-test result and earlier upgrade certificates remain historical evidence for the preceding build. No guarantee is made for hard-killing the daemon, arbitrary non-terminating finalizers, other Effect versions or other executable platforms.

## Completed receipts after rollback

A subsequent audit used disposable clones of the actual storage-2 and storage-3 rollback repositories. Their earlier completed upgrade receipts had expired plan timestamps. Both the actual predecessor and the current certified executable successfully ran `upgrade inspect` and repeated `upgrade apply`, returning the original receipt unchanged: eight command checks in total. Every persistent file remained byte-identical, excluding only the ownership database and its sidecars. Neither operation reran migration or recreated temporary plans.

Accepted receipts live in `.effectory/upgrade-history`, which recovery copies preserve; temporary `.effectory/upgrades` records are excluded. The [retained probe and results](runtime-rollback-receipt-evidence.json) establish that this distinction works through the CLI after restoring, not only through the component journal tests. The original rollback repositories and recovery images were not modified. All 460 certified source/configuration/fixture files and the executable remained unchanged; this is additional evidence, not a new full-suite run.
