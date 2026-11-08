# AWS Secrets Manager vault adapter

Status: API approved, with the user's amendment that delivery must be an extension rather than part of the core runtime. Implementation lives in `extensions/aws-vault`; repository and focused extension verification have passed. See [implementation evidence](implementation-status.md#aws-secrets-manager-vault-extension). The existing Vault API is unchanged. No independent review has been performed. [Research and measured limits](aws-secrets-manager-vault-research.md) distinguish scratch models from implementation evidence.

## Consumer API

Install the `offtree/aws-vault` extension, implemented with `@distilled.cloud/aws` and its Effect-native Secrets Manager operation. Its archive bundles Distilled, while Effect and the SDK remain shared host modules. Provider dependencies stay out of the core SDK and daemon. The generated facade exposes `AwsSecretsManager.exports.make`; the contract declarations include these option types:

```ts
import type { DefinitionError, Vault } from "@offtree/effectory-sdk";
import type { Duration } from "effect";

export interface SecretReference {
  readonly secretId: string;
  readonly versionId?: string;
  readonly versionStage?: string;
}

export interface Options {
  readonly region: string;
  readonly secrets: Readonly<Record<string, string | SecretReference>>;
  readonly requestTimeout?: Duration.Input;
}

export declare const make: (
  options: Options
) => Vault.Implementation<DefinitionError>;
```

Application usage after installing the extension as `AwsSecretsManager`:

```ts
import { Application, Extension, Vault } from "@offtree/effectory-sdk";
import { Schema } from "effect";

import { AwsSecretsManager } from "./effectory.extensions.ts";

export const Infrastructure = Vault.make({
  id: "infrastructure",
  secrets: { "database-password": Schema.NonEmptyString },
});

export default Application.make({
  tasks: [],
  extensions: [Extension.use(AwsSecretsManager)],
  vaults: [Infrastructure],
}).provide(
  Vault.layer(
    Infrastructure,
    AwsSecretsManager.exports.make({
      region: "us-east-1",
      secrets: {
        "database-password": "production/database-password",
      },
      requestTimeout: "30 seconds",
    })
  )
) satisfies Application.Application<never>;
```

An existing task reads `yield* Infrastructure.get("database-password")`, receiving `Redacted<string>`. It declares `Vault.Errors` in its error schema as today. Tests substitute `Vault.memory({ "database-password": "synthetic-fixture" })` through `Task.provide`; no new Task.test option or provider registry is introduced. Different vault definitions can use different AWS regions or providers through ordinary `Layer.mergeAll`.

## Definition and read behavior

- `make` validates and copies its configuration synchronously, including each nested reference, and throws `DefinitionError` for malformed options. Region, secret ID and supplied version selectors must be nonempty strings; strings are preserved without trimming. Unknown option fields are rejected. Mapping keys follow the existing Vault secret-key rules.
- The mapping must contain exactly the vault's declared keys. That check occurs when `Vault.layer` supplies the declaration to the implementation, and fails with `DefinitionError`. Mapping completeness is a runtime check, not a promised compile-time relationship between separate arguments.
- A string mapping is an AWS secret name or ARN. The object form adds version selectors. Without selectors, AWS reads `AWSCURRENT`; when both selectors are supplied they must identify the same version. Cross-account access uses a full ARN. [AWS GetSecretValue contract](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html).
- Each read calls `GetSecretValue`. The adapter does not cache secret values. Repeated reads and retries can observe a rotation; pin `versionId` when that is undesirable. Replaying a completed durable task still reuses its recorded result, as today.
- Only `SecretString` is supported. Preserve empty strings and newlines exactly. The existing Vault codec performs decoding; JSON fields can be selected by that codec rather than by another adapter-specific selector API. `SecretBinary` fails with `VaultFailure/Unsupported`. Missing or malformed response content fails with `Corrupt`.
- Enforce the existing 65,536-byte raw-secret ceiling in the adapter too, including standalone and CLI reveal reads. Existing per-attempt secret tracking and output protection remain in force; the adapter adds no protection for transformed values, binary output or unmanaged external I/O.
- A genuine AWS `ResourceNotFoundException` returns `None` from the backend. Thus `.getOption` returns `None`, and `.get` produces `VaultSecretNotFound`. Authorization, transport and decoding failures must never be treated as absence.

## Authentication, Layers and Scope

Use Distilled's `Credentials.fromChain()` and an explicit region. Credentials belong to the daemon's environment, profiles or workload identity, not to task inputs, tags or this options object. A shell used later to invoke the CLI does not change the already-running daemon's environment. Distilled implements environment, profile, role and external-process credential sources itself; do not claim byte-for-byte compatibility with every AWS SDK credential behavior. The explicit region must apply to credential resolution as well as the service request, without mutating process.env. The feasibility model uses an Effect ConfigProvider override for region, with the ordinary environment as fallback.

Importing the adapter, calling `make`, and acquiring the provider Layer perform no credential lookup or network request. Build Distilled's credential/region services and Effect's FetchHttpClient through ordinary Layers, capture those services for backend reads, and execute the generated GetSecretValue Effect directly. There is no Promise client to wrap or destroy. Application-level provider services belong to the retained revision's Scope. Task-local providers belong to the invocation's Scope and are reacquired on retry. Use ordinary Effect Layers for substitution and sharing, with no new service or Scope abstraction.

The optional `requestTimeout` is an Effect `Duration.Input`, defaults to 30 seconds, and must resolve to a finite positive duration no longer than five minutes. It starts before credential resolution. Interruption propagates through the generated Effect and Effect HTTP transport. Service retries are disabled with Distilled's `Retry.none`; authors choose task retries with the existing `VaultUnavailable` error tag. This does not disable credential providers' own retry/cache behavior.

**Credential-process ownership:** Distilled passes an abort signal to its credential subprocess. A scratch test with the real default chain confirmed that timeout terminated a synthetic direct credential process, and a real HTTP test confirmed request disconnection. This supersedes the previous AWS Promise SDK limitation. It is not a guarantee that every descendant spawned by a shell command terminates or that arbitrary commands honor termination. Do not promise process-tree cleanup beyond the provider's supported behavior.

Application-build secret reads remain rejected by the existing Vault ownership guard. Missing credentials or an unavailable AWS service must fail reads without preventing the daemon from loading an otherwise valid retained revision. Client code and mapping configuration are bundled with the revision; the external credentials and remote secret values are not pinned by that bundle.

## Error contract and administration

Use the existing tagged errors, with vault/key names where their existing schemas allow them. Never retain upstream error messages, response bodies, headers, credentials or secret locators in task errors or telemetry. Classify Distilled's tagged failures and structured status/category information, not error-message parsing. Disable provider debug request logging and provider tracing within vault reads so an ambient debug Layer or tracer cannot bypass this boundary. Keep the existing Vault boundary's defect sanitation. Durable tests exercise these boundaries with the real Distilled pipeline and synthetic transport, including request interruption.

| Condition | Existing result |
| --- | --- |
| ResourceNotFoundException | Backend None |
| No usable credentials from the provider chain, including missing/invalid profile configuration | VaultUnavailable / KeyMissing |
| Access denied, rejected/expired credentials or invalid authentication token | VaultUnavailable / Unauthorized |
| Timeout, transport failure, throttling, server failure or otherwise unclassified SDK failure | VaultUnavailable / Unreachable |
| InvalidParameterException or InvalidRequestException | VaultFailure / InvalidDefinition |
| DecryptionFailure or malformed success response | VaultFailure / Corrupt |
| SecretBinary | VaultFailure / Unsupported |
| Raw SecretString exceeds 65,536 bytes | VaultFailure / LimitExceeded |
| Existing closed/unmanaged ownership checks | Existing VaultFailure / Closed or Unmanaged |

Authentication failures remain `VaultUnavailable` under the existing public error family. An author retrying that tag therefore also retries these failures; the adapter does not silently introduce different retry semantics. Codec failure handling remains the existing `VaultSecretInvalid` path.

The extension and backend ID is `offtree/aws-vault`. It supplies `read` only. Existing `vault describe` reports the declared keys, unknown remote existence, and read capability without making AWS calls. Existing explicit reveal reads through the backend. Local init/put/delete/key-management commands remain unsupported for this backend. No ListSecrets or DescribeSecret call is required. GetSecretValue needs its AWS permission and, for a customer-managed encryption key, the applicable KMS permission. [AWS permissions](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html).

## Implementation and verification gates

1. Build an installable extension archive with manifest, declarations, bundled Distilled inventory and licenses. Test actual extension installation and generated facade imports. Publishing a GitHub release is separate from local implementation; no npm adapter is required.
2. Prove a packaged Distilled adapter bundles, loads in a real daemon, survives restart on its saved revision, and works with an installed extension factory. A source stand-in already bundles and loads against Effect 4.0.5. The separate internal JSON metadata loader correction preserves source capture, file types and size limits; its verification is independent of adapter approval.
3. Test configuration validation, immutable capture, exact key mapping, Duration bounds, version selectors, raw byte bounds, binary refusal, all error categories and synthetic canary exclusion. SDK credential errors must not escape via causes or logs.
4. Test deferred authentication, real HTTP cancellation, timeout, task cancellation and Layer cleanup. Test startup with unavailable credentials, timeout during credential_process, explicit region without environment/profile region, and no late secret request. Test only supported subprocess ownership and document descendant-process limits.
5. Test the real factory with Vault.layer, Task.test and production secret tracking, including output rejection and task-local Layer acquisition/release. Verify two different providers compose without crossing vault identities.
6. Run repository typecheck, formatting/lint and the full test suite on the implementation. A live AWS integration is additional evidence only when an authorized test account is available; no real credential or live AWS result is claimed by current scratch probes.

## Approval scope and remaining parity

The user approved this read-only API with extension delivery. Implementation includes the factory above, Distilled credential discovery, timeout and cancellation limits, and existing Vault error/admin behavior. No new remote mutation command, runtime provider registry or Vault abstraction is introduced. See [the extension README](../extensions/aws-vault/README.md) for build and installation instructions.

Swamp distributes AWS Secrets Manager, Azure Key Vault and 1Password providers as extensions. Its provider surface includes writes and listing. This slice closes AWS task reads only. Azure, 1Password, remote writes, richer metadata, refresh hooks and provider migration remain explicitly queued. Check Distilled's coverage first for each later integration. Earlier observations about 1Password's own SDK do not establish a limitation of a Distilled provider.
