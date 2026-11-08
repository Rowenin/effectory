import { Cause, Effect, Exit, Logger, Option, Schema } from "effect";

import {
  VaultFailure,
  VaultUnavailable,
  VaultSecretInvalid,
} from "./vault-errors.ts";
import type { Backend, Registrable, Secrets } from "./vault.ts";

export const definitions = new WeakMap<
  Registrable,
  { readonly secrets: Secrets; readonly description?: string }
>();
export const handles = new WeakMap<
  object,
  { readonly definition: Registrable; readonly backend: Backend }
>();
export const builtinBackends = new WeakSet<object>();
export const quiet = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Logger.CurrentLoggers, new Set()));

/** Decoder construction itself may throw; never expose user codec error text. */
export function decode(
  vault: string,
  key: string,
  codec: Schema.Codec<unknown, string>,
  raw: string
): Effect.Effect<unknown, VaultSecretInvalid> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        restore(
          quiet(Effect.suspend(() => Schema.decodeEffect(codec)(raw))).pipe(
            Effect.timeoutOption("5 seconds")
          )
        )
      );
      if (Exit.isFailure(exit)) {
        const interrupts = exit.cause.reasons.filter(Cause.isInterruptReason);
        if (interrupts.length) {
          return yield* Effect.failCause(Cause.fromReasons<never>(interrupts));
        }
        return yield* new VaultSecretInvalid({
          key,
          reason: exit.cause.reasons.some(Cause.isDieReason)
            ? "DecoderFailed"
            : "InvalidValue",
          vault,
        });
      }
      if (Option.isNone(exit.value)) {
        return yield* new VaultSecretInvalid({
          key,
          reason: "DecodeTimedOut",
          vault,
        });
      }
      return exit.value.value;
    })
  );
}

/** Backend failures are untrusted text: preserve only recognized reason codes. */
export function backendRead<A>(
  vault: string,
  operation: Effect.Effect<A, VaultFailure | VaultUnavailable>
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(restore(quiet(operation)));
      if (Exit.isSuccess(exit)) {
        return exit.value;
      }
      const interrupts = exit.cause.reasons.filter(Cause.isInterruptReason);
      if (interrupts.length) {
        return yield* Effect.failCause(Cause.fromReasons<never>(interrupts));
      }
      const error = Cause.findErrorOption(exit.cause);
      if (Option.isSome(error)) {
        if (
          error.value instanceof VaultFailure &&
          [
            "Unsupported",
            "LimitExceeded",
            "InvalidDefinition",
            "Closed",
            "Corrupt",
            "KeyMismatch",
            "Unmanaged",
          ].includes(error.value.reason)
        ) {
          return yield* new VaultFailure({ reason: error.value.reason, vault });
        }
        if (
          error.value instanceof VaultUnavailable &&
          [
            "Unreachable",
            "Unauthorized",
            "KeyMissing",
            "NotInitialized",
          ].includes(error.value.reason)
        ) {
          return yield* new VaultUnavailable({
            reason: error.value.reason,
            vault,
          });
        }
      }
      return yield* new VaultUnavailable({ reason: "Unreachable", vault });
    })
  );
}
