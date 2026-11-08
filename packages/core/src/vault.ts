import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import type { Scope } from "effect";

import { identifier } from "./boundary.ts";
import { DefinitionError } from "./errors.ts";
import { VaultFailure, VaultSecretNotFound } from "./vault-errors.ts";
import type { ReadError, VaultUnavailable } from "./vault-errors.ts";
import {
  backendRead,
  builtinBackends,
  decode,
  definitions,
  handles,
} from "./vault-state.ts";
import { Invocation, RevisionBuild, register } from "./vault-tracker.ts";

export {
  Errors,
  VaultFailure,
  VaultSecretInvalid,
  VaultSecretNotFound,
  VaultUnavailable,
} from "./vault-errors.ts";
export type { ReadError } from "./vault-errors.ts";
export type SecretCodec = Schema.Codec<unknown, string>;
export type Secrets = Readonly<Record<string, SecretCodec>>;
export interface Registrable {
  readonly kind: "Vault";
  readonly id: string;
  readonly key: string;
}
const HandleTypeId: unique symbol = Symbol("Vault.Handle");
export interface Handle<Id extends string, S extends Secrets> {
  readonly [HandleTypeId]: { readonly id: Id; readonly secrets: S };
  readonly get: <K extends keyof S & string>(
    key: K
  ) => Effect.Effect<Redacted.Redacted<S[K]["Type"]>, ReadError>;
  readonly getOption: <K extends keyof S & string>(
    key: K
  ) => Effect.Effect<
    Option.Option<Redacted.Redacted<S[K]["Type"]>>,
    Exclude<ReadError, VaultSecretNotFound>
  >;
}
export interface Definition<
  Id extends string,
  S extends Secrets,
> extends Context.Service<Definition<Id, S>, Handle<Id, S>> {
  readonly kind: "Vault";
  readonly id: Id;
  readonly secrets: S;
  readonly get: <K extends keyof S & string>(
    key: K
  ) => Effect.Effect<
    Redacted.Redacted<S[K]["Type"]>,
    ReadError,
    Definition<Id, S>
  >;
  readonly getOption: <K extends keyof S & string>(
    key: K
  ) => Effect.Effect<
    Option.Option<Redacted.Redacted<S[K]["Type"]>>,
    Exclude<ReadError, VaultSecretNotFound>,
    Definition<Id, S>
  >;
}
export function make<const Id extends string, const S extends Secrets>(spec: {
  readonly id: Id;
  readonly secrets: S;
  readonly description?: string;
}): Definition<Id, S> {
  identifier(spec.id);
  if (
    spec.secrets === null ||
    spec.secrets === undefined ||
    Object.keys(spec.secrets).length > 256
  ) {
    throw new DefinitionError({
      message: "Vault must declare at most 256 keys",
    });
  }
  for (const [name, codec] of Object.entries(spec.secrets)) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u.test(name) ||
      !Schema.isSchema(codec)
    ) {
      throw new DefinitionError({
        message: `Invalid vault declaration: ${spec.id}`,
      });
    }
  }
  const service = Context.Service<Definition<Id, S>, Handle<Id, S>>()(
    `@offtree/effectory-sdk/Vault/${spec.id}/${crypto.randomUUID()}`
  );
  const secrets = Object.freeze({ ...spec.secrets });
  const checked = service.pipe(
    Effect.filterOrFail(
      (handle) => Object.is(handles.get(handle)?.definition, service),
      () => new VaultFailure({ reason: "InvalidDefinition", vault: spec.id })
    )
  );
  const self = Object.assign(service, {
    get: <K extends keyof S & string>(key: K) =>
      Effect.flatMap(checked, (handle) => handle.get(key)),
    getOption: <K extends keyof S & string>(key: K) =>
      Effect.flatMap(checked, (handle) => handle.getOption(key)),
    id: spec.id,
    kind: "Vault" as const,
    secrets,
  });
  definitions.set(self, {
    secrets,
    ...(spec.description === undefined
      ? {}
      : { description: spec.description }),
  });
  return Object.freeze(self);
}
export interface ImplementationSpec {
  readonly id: string;
  readonly keys: readonly string[];
}
export type KeyState =
  | {
      readonly _tag: "Absent" | "Present" | "Deleted";
      readonly version: string;
    }
  | { readonly _tag: "Unknown" };
export interface Backend {
  readonly providerId: string;
  readonly read: (
    key: string
  ) => Effect.Effect<
    Option.Option<Redacted.Redacted>,
    VaultUnavailable | VaultFailure
  >;
  readonly inspect?: (
    key: string
  ) => Effect.Effect<KeyState, VaultUnavailable | VaultFailure>;
  readonly list?: Effect.Effect<
    readonly string[],
    VaultUnavailable | VaultFailure
  >;
}
export type Implementation<out E = never, out R = never> = (
  spec: ImplementationSpec
) => Effect.Effect<Backend, E, R | Scope.Scope>;
export function layer<Id extends string, S extends Secrets, E, R>(
  definition: Definition<Id, S>,
  implementation: Implementation<E, R>
): Layer.Layer<
  Definition<Id, S>,
  E | DefinitionError,
  Exclude<R, Scope.Scope>
> {
  return Layer.effect(
    definition,
    Effect.gen(function* () {
      if (!definitions.has(definition)) {
        return yield* new DefinitionError({
          message: "Noncanonical vault definition",
        });
      }
      const managed =
        (yield* RevisionBuild) || (yield* Invocation) !== undefined;
      const backend = yield* implementation(
        Object.freeze({
          id: definition.id,
          keys: Object.freeze(Object.keys(definition.secrets)),
        })
      );
      if (
        backend === null ||
        backend === undefined ||
        typeof backend.read !== "function" ||
        typeof backend.providerId !== "string" ||
        (backend.providerId.startsWith("effectory/") &&
          !builtinBackends.has(backend))
      ) {
        return yield* new DefinitionError({
          message: `Invalid vault backend: ${definition.id}`,
        });
      }
      let closed = false;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
        })
      );
      const read = <K extends keyof S & string>(key: K) =>
        Effect.gen(function* () {
          const tracker = yield* Invocation;
          const building = yield* RevisionBuild;
          if (closed || (tracker && !tracker.open)) {
            return yield* new VaultFailure({
              key,
              reason: "Closed",
              vault: definition.id,
            });
          }
          if (!tracker && (managed || building)) {
            return yield* new VaultFailure({
              key,
              reason: "Unmanaged",
              vault: definition.id,
            });
          }
          const codec = definition.secrets[key];
          if (!Object.hasOwn(definition.secrets, key) || !codec) {
            return yield* new VaultFailure({
              key,
              reason: "InvalidDefinition",
              vault: definition.id,
            });
          }
          const value = yield* backendRead(
            definition.id,
            Effect.suspend(() => backend.read(key))
          );
          if (Option.isNone(value)) {
            return Option.none<Redacted.Redacted<S[K]["Type"]>>();
          }
          const raw = Redacted.value(value.value);
          if (tracker) {
            yield* Effect.try({
              catch: () =>
                new VaultFailure({
                  key,
                  reason: tracker.open ? "LimitExceeded" : "Closed",
                  vault: definition.id,
                }),
              try: () => register(tracker, definition.id, key, raw, true),
            });
          }
          const decoded = yield* decode(definition.id, key, codec, raw);
          if (closed || (tracker && !tracker.open)) {
            return yield* new VaultFailure({
              key,
              reason: "Closed",
              vault: definition.id,
            });
          }
          if (tracker && typeof decoded === "string" && decoded !== raw) {
            yield* Effect.try({
              catch: () =>
                new VaultFailure({
                  key,
                  reason: tracker.open ? "LimitExceeded" : "Closed",
                  vault: definition.id,
                }),
              try: () => register(tracker, definition.id, key, decoded, false),
            });
          }
          return Option.some(Redacted.make(decoded as S[K]["Type"]));
        });
      const handle: Handle<Id, S> = Object.freeze({
        [HandleTypeId]: { id: definition.id, secrets: definition.secrets },
        get: <K extends keyof S & string>(key: K) =>
          Effect.flatMap(read(key), (value) =>
            Effect.fromOption(
              value,
              () => new VaultSecretNotFound({ key, vault: definition.id })
            )
          ),
        getOption: read,
      });
      handles.set(handle, { backend, definition });
      return handle;
    })
  );
}
export function memory(
  values: Readonly<Record<string, string>>
): Implementation {
  const entries = new Map(Object.entries(values));
  return () =>
    Effect.sync(() => {
      const backend: Backend = {
        list: Effect.succeed([...entries.keys()]),
        providerId: "effectory/memory",
        read: (key) =>
          Effect.sync(() =>
            Option.map(Option.fromUndefinedOr(entries.get(key)), Redacted.make)
          ),
      };
      builtinBackends.add(backend);
      return backend;
    });
}
export class LocalStore extends Context.Service<
  LocalStore,
  {
    readonly open: (
      spec: ImplementationSpec
    ) => Effect.Effect<Backend, never, Scope.Scope>;
  }
>()("@offtree/effectory-sdk/Vault/LocalStore") {}
export const local: Implementation<never, LocalStore> = (spec) =>
  Effect.flatMap(LocalStore, (store) => store.open(spec));
