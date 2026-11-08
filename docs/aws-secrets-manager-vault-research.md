# Remote vault adapter research

Status: historical feasibility evidence. The user subsequently approved [AWS Secrets Manager reads](aws-secrets-manager-vault-api-draft.md) with extension delivery, now implemented and verified under `extensions/aws-vault`; see [implementation evidence](implementation-status.md#aws-secrets-manager-vault-extension). The user directed third-party integrations to use Alchemy's Distilled SDKs wherever supported. Scratch probes below are not counted as implementation tests. An independent internal package.json bundler correction is now in production source with regression tests; full verification is recorded separately below.

## Current choice: Distilled

Use `@distilled.cloud/aws`, not `@aws-sdk/client-secrets-manager`. The [Distilled project](https://github.com/alchemy-run/distilled) supplies Effect-native service operations. The inspected published release is 1.0.0-rc.18, including core and signer dependencies; its Effect peer range accepts the repository's pinned 4.0.5. All current probes below use 4.0.5, not the newer Effect version a fresh unconstrained install selected.

The published Secrets Manager module exposes `getSecretValue` as an Effect requiring Credentials and HttpClient, with tagged service errors and a SecretString value that may already be Redacted. `Credentials.fromChain` is lazy. `Retry.none` disables service retries. Effect's FetchHttpClient owns request cancellation. There is no SDK client object whose destruction needs a custom wrapper.

The mapping factory in this proposal stays unchanged. Its backend captures credential, region and HTTP services from ordinary Layers. The model supplies the explicit region to credential resolution using a scoped ConfigProvider override; merely supplying the optional Region service does not satisfy the chain's independent region lookup. No global environment mutation is needed. Provider debug logging and provider spans are disabled at the read boundary; production trace/error disclosure tests remain required.

### Distilled probes

Scripts live outside the checkout at `/tmp/effectory-distilled-vault-research`. These are stand-ins for the proposed adapter, using real Distilled, Vault and Effect code. No remote account or real credential was used.

| Probe | Evidence |
| --- | --- |
| `probe.ts`, `probe.log` | Five synthetic calls through real Distilled request/response handling and Vault: success, missing value, sanitized denial, one interrupted read, and Task.test SecretInOutput protection. Layer acquisition triggered no credential resolution or request. |
| `abort.ts`, `abort.log` | Real Distilled operation and Effect FetchHttpClient against a local server: one pending request disconnected on timeout. |
| `process-parent.ts`, `credential-process.ts`, `process.log` | Default chain in an isolated environment with explicit synthetic config files, no inherited AWS credentials, and no configured environment/profile region. Acquisition did not spawn the command. Read timeout terminated the direct synthetic credential_process. This is not a descendant-process-tree guarantee. |
| `bundle.ts`, `bundle.log` | Real application bundler, retained bundle import and application Layer construction: 106 inputs, 335,066 output bytes, no fetch calls. No scratch loader wrapper. It does not prove packaged installation or real-daemon restart yet. |
| `typecheck.log` | Model, application and probes pass TypeScript against real SDK types and the pinned Effect version. |

The initial scratch install had a second physical Effect copy. Its Redacted registry was separate from core's, and the Vault read failed. Sharing the repository's Effect module fixed it. The actual application bundler externalizes Effect, and its successful retained-bundle probe uses the canonical module. Pack/install tests must enforce that same sharing; installing a compatible version alone is not proof of runtime module identity.

Distilled's credential-process implementation uses an abort signal, unlike the AWS Promise SDK examined earlier. That changes the cancellation conclusion: the old limitation below is historical evidence for the rejected client, not the current proposal. Direct process termination and HTTP abort are tested; arbitrary shell descendants and every credential source are not.

### Other integration coverage

Published 1.0.0-rc.18 packages were inspected in `/tmp/effectory-distilled-coverage`. Apart from the synthetic GitHub binary-response probe below, this is source evidence only, not an implemented migration or a live service test.

- **GitHub:** Effectory's current external-service transport is `extension-source.ts`, which uses `gh api` for release metadata, commit resolution and asset downloads. Distilled's `github/repos` exposes `getReleaseByTag`, `getCommit` and `getReleaseAsset`. The last method's generated result is ReleaseAsset metadata, not bytes. A synthetic binary response to the real generated method succeeded with a runtime string: seven original bytes became nine on UTF-8 re-encoding (`github-asset.ts`, `github-asset.log`, Effect 4.0.5). The shared protocol reads text unless the output schema declares binary. This is a concrete gap in using that method for archive downloads, not a reason to discard Distilled's metadata operations. Before migration, retain or provide a bounded byte-preserving download path and prove redirects and existing gh-based authentication. Keep Effectory's own boundary validation rather than relying solely on generated TypeScript output types. Do not silently replace the operator's login contract with a required environment token.
- **1Password:** `onepassword/connect` exposes `getVaultItemById` and item fields. Its credentials target a self-hosted Connect server with `OP_CONNECT_TOKEN` and a host URL. This supports a potential Connect adapter. It does not establish support for service-account `op://` resolution or desktop authentication. These account models must not be conflated when designing the later public adapter.
- **Azure:** the inspected `azure/keyvault` GetSecret operation is the Resource Manager control-plane route. Its source explicitly says secret values are not returned and directs consumers to the data-plane API. A package labelled Azure is therefore insufficient evidence for a vault-value reader. Check data-plane coverage or a supported Distilled extension before choosing a fallback client.

The repository's AGENTS.md now records the user's Distilled-first rule. Existing API/authentication contracts still govern migrations; a coverage gap must be concrete and documented rather than assumed from the package catalogue.

## Why this gap

Swamp's [vault design](../vendor/swamp/design/primitives/vaults.md) names `@swamp/aws-sm`, `@swamp/azure-kv` and `@swamp/1password` as extension providers. Effectory has [typed vaults and provider Layers](vaults.md), but no ready-to-use remote adapter. A working extension factory proves extensibility, not a usable integration with these services.

The existing Vault implementation already provides typed declarations, Redacted values, decoding, ownership checks and task secret tracking. An adapter can implement `Vault.Implementation` and return a read-only Backend. The [revision loader](../packages/platform-bun/src/revisions.ts) owns application Layers, and [vault control](../packages/platform-bun/src/vault-control.ts) already distinguishes external read backends from local mutation support. There is no need for a provider registry, new task context field or new RPC for AWS reads.

## Historical AWS Promise SDK evidence

All scripts and installed research dependencies are outside the checkout in `/tmp/effectory-remote-vault-research`. They use synthetic credentials and canaries only. Versions: Effect 4.0.5, Bun 1.4.3, `@aws-sdk/client-secrets-manager` 3.1164.0 and `@1password/sdk` 0.5.0. No AWS or 1Password account was contacted. These scratch files are not durable repository tests and must be replaced by implementation tests before shipping.

| Probe | Actual components | Result and limit |
| --- | --- | --- |
| `probe.ts`, `probe.log` | Real AWS SDK request pipeline, real Vault.layer and Task.test; stand-in adapter and synthetic HTTP handler | Five clients acquired/destroyed; credential lookup deferred until read; missing, denied and success cases; one timeout abort; secret-output rejection. The model implements only part of the proposed error table. |
| `abort.ts`, `abort.log` | Real AWS Node HTTP handler against a local synthetic server; stand-in adapter | One pending request disconnected on timeout. A delayed credential resolution outlived its read timeout, then completed without sending a late secret HTTP request. |
| `bundle.ts`, `bundle.log` | Real buildApplication and AWS dependency before the correction | The original bundler rejected SDK package.json imports because Bun supplied a jsonc loader. |
| `bundle.ts` with `PROBE_JSON_FIX=1`, `bundle-fixed.log` | Same original bundler, with a scratch-only wrapper supplying the JSON loader for a .json input | Single 916,253-byte bundle, 149 captured inputs, one JSON fallback. Retained bundle imported and application Layer built; no fetch call. This was evidence for the later internal correction, not a real daemon restart. |
| `public-shape.ts`, `typecheck.log` | Real core SDK and Effect types; stand-in factory with Duration normalization | Proposed mapping/factory shape and Application<never> typecheck. Model/probe/application files also pass the repository TypeScript configuration. |

The source manifest from the preceding completed slice can detect unintended production changes. Its 501-test result belongs to run-history reclamation; it is not AWS adapter verification.

## Superseded AWS Promise SDK ownership findings

The following paragraphs describe the original rejected client choice. They remain as historical comparison evidence and do not specify the revised adapter.

The SDK accepts an abort signal on `send`. `Effect.tryPromise` can bridge that signal and `Effect.acquireRelease` can own the client's destroy operation. A Layer can be acquired without resolving credentials. Secret reads remain ordinary Effects behind the existing typed vault service.

Cancellation of credential discovery is weaker. Source inspection of `@aws-sdk/credential-provider-process` found a promisified subprocess exec without a cancellation signal; the default chain also memoizes credential lookup. The delayed-provider probe confirms that read timeout does not terminate all credential work. Do not claim that client destruction or Scope finalization kills credential subprocesses. The proposed contract discloses this rather than inventing a second AWS authentication framework.

The factory's service retry setting is one attempt. This does not disable credential providers' own behavior. The adapter does not cache secret values, so rotation is observable on subsequent reads. AWS's [GetSecretValue API](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html) defines name/ARN lookup, version ID/stage selectors, SecretString versus SecretBinary and access permissions. The [standard Node credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html) is the proposed authentication mechanism.

## Earlier 1Password SDK investigation

The inspected public SDK exposes `secrets.resolve(secretReference): Promise<string>` with no abort argument, and its public client exposes no close/destroy method. Internal release functions are not a supported adapter contract. The official [SDK documentation](https://www.1password.dev/sdks) describes asynchronous client construction and supported authentication. The [CLI read command](https://www.1password.dev/cli/reference/commands/read) is a possible scoped subprocess alternative, but precise missing/authentication error classification and process ownership still need evidence. Neither path is approved or implemented here.

These observations concern 1Password's own SDK, not Distilled. Distilled's [provider catalogue](https://distilled.cloud/) includes AWS, Azure, GitHub and `onepassword`. Each needs an operation/authentication coverage check; the package name alone is not evidence that it supports the same account model or every needed operation. The next slice remains AWS reads, with the other provider integrations explicitly queued under the user's Distilled-first policy.

## Internal bundler correction verification

The production source-snapshot loader now maps Bun's jsonc loader to JSON only for imported package.json files. Four regression cases cover dependency metadata, source-change detection/retained output, unsupported JSONC/text modules and the existing file limit. Typecheck, formatting/lint and all 505 repository tests passed, with 4,234 assertions across 130 files and no failures. Runtime/test sources remained unchanged during the run; only the AGENTS.md instruction changed outside the excluded documentation files. See [implementation status](implementation-status.md#imported-package-metadata). This verifies the internal correction, not an AWS adapter that has not yet been implemented.
