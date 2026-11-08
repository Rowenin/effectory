# 1Password vault extension research

Status: research, 2026-11-07. No new API is approved or implemented. The next parity target is usable 1Password vault access through an installable extension and existing `Vault.layer`. The user selected local Desktop/CLI authentication on 2026-11-07; the revised factory and failure semantics remain proposed. A Connect-only adapter must not be described as service-account or desktop support.

## Current evidence and scope

Vendored Swamp's `design/primitives/vaults.md:1325–1346` identifies `@swamp/1password` as an extension and shows an `op_vault` configuration. That source establishes the integration surface, not its complete authentication or cancellation behavior. The provider implementation is not present in the inspected vendored source; this review does not infer full support from its name.

Effectory now has a verified AWS extension plus local/memory providers. The actual Vault contracts and extension pipeline already support another read backend. Provider code should stay under `extensions/`, behind lazy contract exports. No new core provider registry or task-context field is needed. Remote mutation, listing, refresh hooks and migration remain explicit parity gaps; selecting a read adapter does not complete the overall vault parity goal.

The user was asked which authentication path should be primary: service account, self-hosted Connect, or desktop/CLI. That choice remains pending. No credentials are needed for this design work.

## Distilled coverage

Inspected published `@distilled.cloud/onepassword` 1.0.0-rc.18. The source contains Connect, Events, Users, OAuth and Partnership services. The secret-value read is `connect.getVaultItemById({ vaultUuid, itemUuid })`. Its credentials are a Connect bearer token and server API base URL; `ConnectCredentialsFromEnv` lazily reads `OP_CONNECT_TOKEN` and the Connect host/base URL settings. These are not service-account credentials. No service-account `op://` resolver was found in the inspected package.

The official [Connect reference](https://www.1password.dev/connect/api-reference) requires deploying Connect and authenticating requests with its access token. The official [SDK guide](https://www.1password.dev/sdks) separately documents desktop and service-account authentication. The [CLI secret-reference guide](https://www.1password.dev/cli/secret-references) documents `op://` references and recommends least-privilege service accounts. These distinctions must remain visible in the public proposal.

### Executed Connect probe

`/tmp/effectory-distilled-coverage/onepassword-read.ts` and `.log` use the real generated Distilled operation, real Effect 4.0.5 and a synthetic HttpClient. No account was contacted. The scratch directory's Effect resolves to the repository's pinned module; this is not a test against its earlier isolated 4.1.2 install.

Results:

- Seven requests total; exactly one request per operation with `Retry.none`.
- Correct item URL and synthetic bearer authorization.
- A concealed field was delivered as a plain string, with its trailing newline preserved. The adapter must select only the requested field, wrap it in Redacted and pass it through the existing Vault tracking boundary; it must not expose the whole item to handlers.
- HTTP 401, 403, 404, 429 and 500 produced `Unauthorized`, `Forbidden`, `NotFound`, `TooManyRequests` and `InternalServerError` respectively.
- Every tested upstream error retained the synthetic private message. The adapter must discard upstream text/causes and suppress provider telemetry, including on interrupted failures.
- Timing out a pending operation interrupted the synthetic transport once. This is a transport ownership probe, not a live Connect cancellation test.

Still required for implementation: exact field/section matching, missing versus malformed field semantics, duplicate matching fields, archived/deleted items, response/value limits, mapping validation, explicit host policy, actual HTTP abort, generated facade/install/restart and default credential behavior. Field names, UUID-only locators and `op://` spelling are public choices, not internal details.

## Direct service-account and desktop candidates

The inspected official `@1password/sdk` 0.5.0 supports a service-account string or `DesktopAuth` in client configuration. `createClient` and `secrets.resolve` return Promises; the inspected public declarations provide no abort argument or client close method. Internal release functions are not a supported lifecycle API. This is a concrete Distilled coverage gap, not permission to silently substitute a Promise client or change authentication.

### Retained bundle evidence

Scratch files are in `/tmp/effectory-1password-research`:

- `effectory.ts` contains a proposed task with a deferred SDK client call; no handler is executed.
- `bundle.ts` uses the real `buildApplication`, imports the retained output and builds its application Layer with fetch blocked. The result has 18 captured inputs, 88,729 source bytes and zero network calls. Reading the exported SDK function also succeeds while the original SDK install exists.
- The generated source still contains an absolute original-package `__dirname`; `sdk-core` reads `core_bg.wasm` through `fs.readFileSync`. The WASM is not embedded by that bundle.
- `missing-asset.ts` intercepts only that file read and simulates the file being absent. SDK access fails. This is explicitly a simulated missing-install test, not an actual restore or installation test.

Consequently, successful bundling/import alone is insufficient proof of portable retained revisions. Choosing the official SDK requires a deliberate asset packaging strategy and proof that it works after the original installation disappears. Deadline and cancellation behavior also need a defensible contract; wrapping an uncancellable Promise does not stop its underlying work.

### CLI alternative

The locally installed `op` 2.33.1 was queried only with `--version` and help commands. No account listing, sign-in, token lookup or secret read was performed. `op read --no-newline` supports exact field output through `op://` references. Service-account and desktop use are documented by 1Password, but have not been exercised here.

An Effect-owned subprocess is a candidate fallback for the missing Distilled account modes. Before recommending it, prove bounded stdout/stderr, timeout/interruption and process cleanup, encoding/newline behavior, stable error classification and no accidental inherited Connect routing. Do not parse localized secret-bearing stderr to distinguish absence from authorization. Operator installation/version requirements and desktop prompts in a daemon must be part of the public decision. A missing classification proof must not silently turn all failures into None.

## Next decision and proof sequence

1. Primary authentication is now selected: local Desktop/CLI. Keep the other modes visible as remaining scope, rather than describing a Connect adapter as all of 1Password.
2. Produce exact extension factory/options, locator and failure contracts for that choice. Reuse the approved AWS defaults where applicable: lazy acquisition, 30-second bounded reads, no secret cache, existing Vault errors and task reads, ordinary Layer substitution.
3. Validate the selected client path with synthetic probes before implementation approval, including ownership and retained-revision packaging. No real secret is necessary to prove these mechanics.
4. Implement only after discussing the public API. Then add durable tests and run repository typecheck, check and the full suite. Scratch probes above are not implementation tests.

Only research documentation changed in this turn. Repository tests were not rerun for this documentation-only work; the previous AWS verification remains separate evidence for that completed extension.

## Follow-up ownership and error evidence (2026-11-07)

The previous research turn made progress by establishing real Distilled behavior and the SDK's external-WASM dependency. Authentication selection is still pending. This follow-up does not choose it, introduce an API, or claim another completed provider.

### Effect-owned process proof

`/tmp/effectory-1password-process-proof/probe.ts`, `child.ts` and `probe.log` exercise real Effect 4.0.5 `ChildProcessSpawner` with `BunServices.layer` on Bun 1.4.3/macOS. The executable is a synthetic child, not `op`. No credentials or account calls are involved.

The prototype uses `Effect.scoped` around spawn, concurrent stdout/stderr consumption and exit observation, and `forceKillAfter: 50`. It runs without a shell or inherited environment. Stdout retains at most 65,536 bytes; stderr is discarded and fails the operation after 8,192 bytes. The limits bound retained application output, not all OS pipe or transport buffers. UTF-8 decoding is strict. This is a feasibility model, not a shipping adapter or a proposed public limit for arbitrary CLI execution.

All seven cases passed:

- A value with a final newline returns exactly; empty output remains an empty value.
- A nonzero exit fails and does not retain the synthetic private stderr text.
- Invalid UTF-8 fails instead of silently replacing bytes.
- Continuous stdout and stderr floods each fail at their respective bound and terminate the child.
- A child that ignores SIGTERM is forcibly terminated when the 300 ms read timeout closes its Scope. The measured completion was 366 ms, including cleanup. Thus read timeout is not a hard upper bound on response latency.
- Every case checked that its child PID no longer existed after the scoped operation returned.

This does not prove real `op` behavior, Linux behavior, arbitrary detached descendants, stable CLI error classification, or packaging. It does show that process ownership can use existing Effect primitives without a new scheduler or public service. Real provider execution must use a deliberately selected environment; blindly inheriting Connect/debug/session variables would undermine an explicit authentication choice.

### Structured SDK errors improve the direct-SDK candidate

Further source inspection of official SDK 0.5.0 found a better read operation than `resolve`: public `secrets.resolveAll([reference])` returns `ResolveAllResponse.individualResponses[reference]`. Its structured `ResolveReferenceError.type` includes `fieldNotFound`, `vaultNotFound`, `itemNotFound`, `tooManyVaults`, `tooManyItems`, `tooManyMatchingFields` and `noMatchingSections`, plus parsing/format errors. Its global error wrapper preserves specific expired-authentication and rate-limit classes, but maps other errors to plain Error messages.

This gives a path to distinguishing missing references from ambiguity without parsing text. It is source evidence, not a live service test. The response type allows both `content` and `error` to be absent, so the adapter must validate the actual response rather than assume TypeScript makes it exhaustive. Unknown/global failures must fail closed with sanitized errors, not return None.

This finding changes the next investigation: compare a properly packaged, owned SDK execution boundary with the CLI route before choosing the latter. The SDK's missing cancellation API and external WASM remain unresolved. A Worker/process isolation strategy would need proof that termination ends its work, preserves host secret tracking, carries credentials without persisting them, and remains usable from the compiled Effectory executable without an undeclared Bun/Node installation requirement. No such strategy is implemented or approved here.

The installed CLI help and the inspected official documentation do not establish a stable structured `op read` error contract. Consequently, the CLI is not yet recommended as a drop-in replacement for SDK absence semantics. Its process-cleanup proof alone cannot settle that decision.

## Embedded SDK Worker feasibility (2026-11-07)

The raw SDK WASM is 13,954,367 bytes; uncompressed base64 would exceed the application's 16 MiB bundle ceiling. A scratch extension-build transform gzip-compresses that pinned asset and embeds its base64 in the SDK module, replacing only its exact filesystem read. The transform fails if that source marker changes. Runtime inflation uses `node:zlib`, with no new host loader or source-snapshot exception. No production build script was changed.

`/tmp/effectory-1password-worker-proof` contains the build, Worker entry, source/compiled ownership probes, retained application probe and stdout/stderr probe. Results:

- Compressed base64: 5,660,076 bytes. Worker source: 5,748,717 bytes.
- The real application bundler captures two fixture source inputs and emits a 5,749,194-byte retained bundle containing the Worker payload. Importing it and invoking the real SDK's local secret-reference validator in its Worker succeeds.
- `node:worker_threads.Worker` with `eval: true` executes the payload. It does not need an external `bun` or `node` command. The same ownership test passes in a `bun build --compile` executable.
- `Effect.acquireUseRelease` owns the Worker; its finalizer awaits `worker.terminate()`. Both normal validation and timeout await exit. A synthetic pending fetch inside the Worker reaches a local server once, and Worker termination disconnects it once.
- A separate probe confirms Bun's Node Worker compatibility captures both stdout and stderr when requested. Synthetic private output goes to those streams, not directly to the parent console.

The SDK validation is real; the pending HTTP request is synthetic and does not call 1Password. The ownership prototype does not yet implement client authentication, `resolveAll`, host secret tracking, bounded IPC, bounded output draining or an installed extension. There is no live-account proof, Linux proof or arbitrary SDK-native resource cleanup guarantee. The compiled prototype is not the full Effectory binary. These limits remain implementation gates.

This makes a direct service-account extension feasible enough to propose, without raising runtime source limits or making Connect a prerequisite. Its official SDK dependency is an explicit exception for the service-account capability absent from the inspected Distilled package. Connect should still use Distilled if selected. This is evidence for an alternate service-account path, not the selected primary experience. The user subsequently chose local Desktop/CLI; see the [revised proposal](onepassword-vault-api-draft.md).

## Selected local CLI direction (2026-11-07)

The user chose Desktop/CLI using a local signed-in session. The service-account Worker evidence above remains historical feasibility evidence; it is not the implementation direction. No production dependency or source was added.

Official [app-integration documentation](https://www.1password.dev/cli/app-integration) describes desktop authorization prompts and explicit account selection. The [environment reference](https://www.1password.dev/cli/environment-variables) distinguishes local session/configuration variables from service-account and Connect settings, and says `--account` overrides `OP_ACCOUNT`. The [read command](https://www.1password.dev/cli/reference/commands/read) supports `--no-newline` and reference query parameters. These references plus local help were checked; no account or secret was accessed.

The revised proposal requires an explicit account, excludes hosted authentication variables from the child, allows existing local desktop/manual sessions and uses scoped Effect subprocess ownership. The prior synthetic process probe supports mechanical feasibility only. Missing-secret classification remains a coverage limitation: no documented structured CLI error was established, so the proposal makes failed reads errors even for `getOption`. User approval of that behavior is still required.
