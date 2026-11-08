import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import * as Retry from "@distilled.cloud/aws/Retry";
import * as SecretsManager from "@distilled.cloud/aws/secrets-manager";
import * as Telemetry from "@distilled.cloud/core/telemetry";
import { Vault } from "@offtree/effectory-sdk";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Redacted,
} from "effect";
import { FetchHttpClient } from "effect/http";
import type { HttpClient } from "effect/http";

import type { CapturedOptions, SecretReference } from "./options.ts";

type ReadError = Vault.VaultFailure | Vault.VaultUnavailable;
type Value = Option.Option<Redacted.Redacted<string>>;

// Each case is a structured upstream error tag; never inspect error messages.
// oxlint-disable-next-line complexity
function classify(vault: string, error: unknown): ReadError {
  if (
    error instanceof Vault.VaultFailure ||
    error instanceof Vault.VaultUnavailable
  ) {
    return error;
  }
  const originalTag =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "_tag")
      : undefined;
  const tag =
    originalTag === "UnknownAwsError" &&
    typeof error === "object" &&
    error !== null
      ? Reflect.get(error, "errorTag")
      : originalTag;
  switch (tag) {
    case "InvalidParameterException":
    case "InvalidRequestException":
    case "InvalidInput": {
      return new Vault.VaultFailure({ reason: "InvalidDefinition", vault });
    }
    case "DecryptionFailure":
    case "ParseError": {
      return new Vault.VaultFailure({ reason: "Corrupt", vault });
    }
    case "AccessDeniedException":
    case "AccessDenied":
    case "InvalidClientTokenId":
    case "InvalidSignatureException":
    case "SignatureDoesNotMatch":
    case "OptInRequired":
    case "ExpiredTokenException":
    case "IncompleteSignature":
    case "NotAuthorized":
    case "RequestExpired":
    case "UnrecognizedClientException":
    case "SigningError":
    case "Alchemy::AWS::InvalidSSOToken":
    case "Alchemy::AWS::ExpiredSSOToken": {
      return new Vault.VaultUnavailable({ reason: "Unauthorized", vault });
    }
    case "SourceError":
    case "AWS::CredentialProviderError": {
      return new Vault.VaultUnavailable({ reason: "KeyMissing", vault });
    }
    default: {
      return new Vault.VaultUnavailable({
        reason:
          typeof tag === "string" && tag.startsWith("Alchemy::AWS::")
            ? "KeyMissing"
            : "Unreachable",
        vault,
      });
    }
  }
}

// Admin reads use the backend directly, so sanitation must not depend on
// Task's logger or Vault's handler wrapper. Keep interruption; drop all text.
function protect<A, E, R>(
  vault: string,
  operation: Effect.Effect<A, E, R>
): Effect.Effect<A, ReadError, R> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(restore(operation));
      if (Exit.isSuccess(exit)) {
        return exit.value;
      }
      const interrupted = exit.cause.reasons.filter(Cause.isInterruptReason);
      if (interrupted.length > 0) {
        return yield* Effect.failCause(Cause.fromReasons<never>(interrupted));
      }
      const error = Cause.findErrorOption(exit.cause);
      return yield* classify(
        vault,
        Option.isSome(error) ? error.value : undefined
      );
    })
  );
}

function value(
  vault: string,
  response: SecretsManager.GetSecretValueResponse
): Effect.Effect<Value, ReadError> {
  return Effect.try({
    catch: () => new Vault.VaultFailure({ reason: "Corrupt", vault }),
    try: () => {
      const raw = response.SecretString;
      return Redacted.isRedacted(raw) ? Redacted.value(raw) : raw;
    },
  }).pipe(
    Effect.flatMap((raw): Effect.Effect<Value, ReadError> => {
      if (response.SecretBinary !== undefined) {
        return Effect.fail(
          new Vault.VaultFailure({ reason: "Unsupported", vault })
        );
      }
      if (typeof raw !== "string") {
        return Effect.fail(
          new Vault.VaultFailure({ reason: "Corrupt", vault })
        );
      }
      if (new TextEncoder().encode(raw).byteLength > 65_536) {
        return Effect.fail(
          new Vault.VaultFailure({ reason: "LimitExceeded", vault })
        );
      }
      return Effect.succeed(Option.some(Redacted.make(raw)));
    })
  );
}

function request(
  reference: SecretReference
): SecretsManager.GetSecretValueRequest {
  return {
    SecretId: reference.secretId,
    ...(reference.versionId === undefined
      ? {}
      : { VersionId: reference.versionId }),
    ...(reference.versionStage === undefined
      ? {}
      : { VersionStage: reference.versionStage }),
  };
}

/** Private implementation seam; the extension's contract exports only make. */
export function makeBackend(
  spec: Vault.ImplementationSpec,
  options: CapturedOptions,
  dependencies: Layer.Layer<
    Credentials.Credentials | HttpClient.HttpClient
  > = Layer.mergeAll(Credentials.fromChain(), FetchHttpClient.layer)
) {
  return Effect.gen(function* () {
    const services = yield* Layer.build(dependencies);
    const config = ConfigProvider.orElse(
      ConfigProvider.fromUnknown({ AWS_REGION: options.region }),
      ConfigProvider.fromEnv()
    );
    const region = Effect.succeed(options.region as Region.RegionName);
    return Object.freeze({
      providerId: "offtree/aws-vault",
      read: (key: string): Effect.Effect<Value, ReadError> =>
        Effect.suspend(() => {
          if (!Object.hasOwn(options.secrets, key)) {
            return Effect.fail(
              new Vault.VaultFailure({
                reason: "InvalidDefinition",
                vault: spec.id,
              })
            );
          }
          const reference = options.secrets[key];
          if (reference === undefined) {
            return Effect.fail(
              new Vault.VaultFailure({
                reason: "InvalidDefinition",
                vault: spec.id,
              })
            );
          }
          const operation = Effect.suspend(() =>
            SecretsManager.getSecretValue(request(reference))
          ).pipe(
            Retry.none,
            Effect.flatMap((response) => value(spec.id, response)),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(Option.none())
            ),
            Effect.timeoutOption(options.timeoutMillis),
            Effect.flatMap((result) =>
              Option.isSome(result)
                ? Effect.succeed(result.value)
                : Effect.fail(
                    new Vault.VaultUnavailable({
                      reason: "Unreachable",
                      vault: spec.id,
                    })
                  )
            ),
            Effect.provideContext(services),
            Effect.provideService(Region.Region, region),
            Effect.provideService(ConfigProvider.ConfigProvider, config),
            // Explicit undefined selects the two-argument provideService overload.
            // oxlint-disable-next-line unicorn/no-useless-undefined
            Effect.provideService(Telemetry.Debug, undefined),
            // oxlint-disable-next-line unicorn/no-useless-undefined
            Effect.provideService(Telemetry.OperationSpan, undefined),
            Effect.provideService(Logger.CurrentLoggers, new Set()),
            Effect.withTracerEnabled(false)
          );
          return protect(spec.id, operation);
        }),
    }) satisfies Vault.Backend;
  });
}
