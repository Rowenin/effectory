# AWS Secrets Manager vault extension

`offtree/aws-vault` is a read-only Effectory extension using Alchemy's Distilled SDK. The extension bundles its provider dependencies; it uses the host's existing `Vault.layer`, Effect services and secret protection.

## Build and install

From the Effectory checkout:

```sh
bun install --frozen-lockfile
bun run build:extension:aws-vault
```

This creates `dist/extensions/aws-vault/effectory-aws-vault.tgz` and `SHA256SUMS`. The build validates the extension archive before returning. The private workspace package is a build input, not an npm adapter.

After that archive is attached to a trusted GitHub release, install it with the existing extension command (replace `OWNER/REPO@TAG` with that release):

```sh
effectory extension add github:OWNER/REPO@TAG \
  --asset effectory-aws-vault.tgz --as AwsSecretsManager --trust
```

No release has been published by this implementation. The release workflow attaches the archive on a future version-tag release. Installation creates the `effectory.extensions.ts` facade. Configure the application, then restart the daemon to load the edited revision.

## Use

```ts
import { Application, Extension, Task, Vault } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

import { AwsSecretsManager } from "./effectory.extensions.ts";

const Credentials = Vault.make({
  id: "credentials",
  secrets: { token: Schema.NonEmptyString },
});
const Check = Task.make(
  {
    id: "check-credentials",
    version: 1,
    input: Schema.Null,
    success: Schema.Boolean,
    error: Vault.Errors,
    replay: "idempotent",
  },
  () => Effect.as(Credentials.get("token"), true)
);

export default Application.make({
  tasks: [Check],
  vaults: [Credentials],
  extensions: [Extension.use(AwsSecretsManager)],
}).provide(
  Vault.layer(
    Credentials,
    AwsSecretsManager.exports.make({
      region: "us-east-1",
      secrets: { token: "production/github-token" },
      requestTimeout: "30 seconds",
    })
  )
) satisfies Application.Application<never>;
```

The factory validates and copies options. Mapping keys must exactly match the vault declaration. A mapping can also be `{ secretId, versionId?, versionStage? }`; no selector means AWS's current version. Reads do not cache secret values, so pin a version if retries must read the same value.

Task reads are unchanged: `yield* Credentials.get("token")` returns a `Redacted<string>`. Tests can provide `Vault.layer(Credentials, Vault.memory({ token: "fixture" }))` through `Task.provide`. Different vaults can use different provider Layers in the same application.

## Credentials and lifetime

Distilled's credential chain runs in the daemon, using its environment, profiles or workload identity. Import, factory creation, Layer acquisition and `vault describe` do not resolve credentials or contact AWS. The explicit region also applies to credential discovery, without changing process environment variables.

The timeout covers credential discovery and the service request. It defaults to 30 seconds and must be finite, positive and at most five minutes. The adapter disables service retries; tasks can explicitly retry `VaultUnavailable`. Credential sources may have their own cache/retry behavior.

Interruption aborts HTTP requests and Distilled's direct credential process. It does not guarantee termination of every descendant of an arbitrary credential command. The retained revision contains provider code and mappings; external credentials and AWS values remain live.

## Supported reads and errors

Only `SecretString` is supported, with a 65,536-byte UTF-8 ceiling. Empty strings and trailing newlines are preserved. Missing secrets give `None` through `getOption`; access failures never become absence. Binary values fail with `VaultFailure/Unsupported`.

Errors use existing Vault tags and sanitized reasons. No upstream messages, secret locators or provider telemetry are retained. Normal task secret tracking still applies. `vault describe` shows read capability and unknown remote existence; explicit reveal uses the provider. Init, put, delete and key-management operations are not supported by this remote backend.

The full behavior and error mapping are in [the approved contract](../../docs/aws-secrets-manager-vault-api-draft.md). Tests use synthetic credentials and local endpoints; they do not claim live AWS or IAM integration coverage.
