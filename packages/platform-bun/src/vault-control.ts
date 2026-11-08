import { OperationError } from "@effectory/runtime/protocol";
import { Vault } from "@offtree/effectory-sdk";
import { checkJsonBudget } from "@offtree/effectory-sdk/internal/boundary";
import {
  backendRead,
  decode,
  quiet,
} from "@offtree/effectory-sdk/internal/vault-state";
import { Effect, Option, Redacted, Schema } from "effect";

import type { Catalog } from "./catalog.ts";
import { keyDirectory, vaultOperation } from "./vault-store.ts";
import type { Mutation } from "./vault-store.ts";

const error = (code: OperationError["code"], message: string) =>
  new OperationError({ code, message });
const adminError = (failure: Vault.ReadError) => {
  let code: OperationError["code"] = "Unavailable";
  if (failure instanceof Vault.VaultSecretNotFound) {
    code = "NotFound";
  } else if (failure instanceof Vault.VaultSecretInvalid) {
    code = "InvalidInput";
  } else if (failure instanceof Vault.VaultFailure) {
    if (failure.reason === "LimitExceeded") {
      code = "LimitExceeded";
    } else if (
      ["Unsupported", "InvalidDefinition", "Unmanaged"].includes(failure.reason)
    ) {
      code = "InvalidInput";
    }
  }
  return error(
    code,
    `Vault ${failure.vault}${"key" in failure && failure.key ? `/${failure.key}` : ""}: ${"reason" in failure ? failure.reason : "not found"}`
  );
};
export function vaultHandlers(catalog: typeof Catalog.Service) {
  const store = () =>
    Effect.suspend(() =>
      catalog.vaults
        ? Effect.succeed(catalog.vaults)
        : Effect.fail(
            error(
              "Unavailable",
              "Vault administration is unavailable in this host"
            )
          )
    );
  const selected = (request: { vault: string; revision?: string }) =>
    Effect.gen(function* () {
      const application = yield* catalog.get(request.revision);
      const vault = application.registry.vaults.get(request.vault);
      if (!vault) {
        return yield* error(
          "NotFound",
          `Vault ${request.vault} is not registered in revision ${application.revision}; select its earlier --revision or use offline reset`
        );
      }
      return { ...vault, revision: application.revision };
    });
  const local = (request: { vault: string; revision?: string }) =>
    Effect.gen(function* () {
      const selection = yield* selected(request);
      const storage = yield* store();
      if (!storage.backends.has(selection.backend)) {
        return yield* error(
          "InvalidInput",
          `Vault ${request.vault}: Unsupported; this provider is read-only`
        );
      }
      return { ...selection, storage };
    });
  const mutate = (request: Mutation & { revision?: string }) =>
    Effect.gen(function* () {
      const { storage, secrets, revision } = yield* local(request);
      const prior = yield* vaultOperation(() => storage.lookup(request));
      if (prior) {
        return { ...prior, revision };
      }
      if (request.operation === "Put") {
        const codec = secrets[request.key];
        if (!Object.hasOwn(secrets, request.key) || !codec) {
          return yield* error(
            "InvalidInput",
            `Vault ${request.vault}/${request.key} is undeclared`
          );
        }
        yield* decode(
          request.vault,
          request.key,
          codec,
          request.value ?? ""
        ).pipe(Effect.mapError(adminError));
      }
      return {
        ...(yield* vaultOperation(() => storage.mutate(request))),
        revision,
      };
    }).pipe(Effect.scoped);
  return {
    VaultDelete: (
      request: Omit<Mutation, "operation" | "value"> & { revision?: string }
    ) => mutate({ ...request, operation: "Delete" }),
    VaultDescribe: (request: { vault: string; revision?: string }) =>
      Effect.gen(function* () {
        const { backend, secrets, revision } = yield* selected(request);
        const storage = yield* store();
        const isLocal = storage.backends.has(backend);
        const listed = backend.list
          ? yield* backendRead(request.vault, backend.list).pipe(
              Effect.mapError(adminError)
            )
          : [];
        if (
          listed.length > 256 ||
          listed.some(
            (key) => !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u.test(key)
          )
        ) {
          return yield* error(
            "LimitExceeded",
            `Vault ${request.vault} returned an invalid or oversized key list`
          );
        }
        const names = [
          ...new Set([...Object.keys(secrets), ...listed]),
        ].toSorted();
        const keys = yield* Effect.forEach(names, (key) =>
          Effect.gen(function* () {
            const codec = Object.hasOwn(secrets, key)
              ? secrets[key]
              : undefined;
            const { inspect } = backend;
            const state = inspect
              ? yield* backendRead(
                  request.vault,
                  quiet(Effect.suspend(() => inspect(key)))
                ).pipe(Effect.mapError(adminError))
              : { _tag: "Unknown" as const };
            const schema = codec
              ? yield* vaultOperation(() => {
                  const result = Schema.toJsonSchemaDocument(
                    Schema.toType(codec)
                  );
                  checkJsonBudget(result, {
                    bytes: 65_536,
                    depth: 32,
                    values: 10_000,
                  });
                  return Schema.decodeUnknownSync(Schema.Json)(result);
                })
              : undefined;
            return {
              declared: !!codec,
              key,
              state,
              ...(schema === undefined ? {} : { schema }),
            };
          })
        );
        const status = isLocal
          ? yield* vaultOperation(() => storage.status(request.vault))
          : { hint: null, keyId: null, state: "Unknown" as const };
        const result = {
          capabilities: isLocal
            ? ["read", "list", "inspect", "init", "put", "delete", "reveal"]
            : [
                "read",
                ...(backend.list ? ["list"] : []),
                ...(backend.inspect ? ["inspect"] : []),
              ],
          providerId: backend.providerId,
          revision,
          vault: request.vault,
          ...status,
          keyDirectory: isLocal
            ? yield* vaultOperation(() => keyDirectory(storage.repository))
            : null,
          keys,
        };
        yield* vaultOperation(() =>
          checkJsonBudget(result, {
            bytes: 1_048_576,
            depth: 40,
            values: 100_000,
          })
        );
        return result;
      }).pipe(Effect.scoped),
    VaultInit: (request: { vault: string; revision?: string }) =>
      Effect.gen(function* () {
        const { storage, revision } = yield* local(request);
        const result = yield* vaultOperation(() => storage.init(request.vault));
        if (result.state !== "Ready" || result.keyId === null) {
          return yield* error(
            "Unavailable",
            `Vault ${request.vault}: initialization did not complete`
          );
        }
        return {
          keyId: result.keyId,
          revision,
          state: "Ready" as const,
          vault: request.vault,
        };
      }).pipe(Effect.scoped),
    VaultList: (request: { revision?: string }) =>
      Effect.gen(function* () {
        const application = yield* catalog.get(request.revision);
        const storage = yield* store();
        const stored = yield* vaultOperation(() => storage.list());
        const names = new Set([
          ...stored,
          ...application.registry.vaults.keys(),
        ]);
        return {
          items: [...names].toSorted().map((vault) => {
            const definition = application.registry.vaults.get(vault);
            return {
              local:
                stored.includes(vault) ||
                (!!definition && storage.backends.has(definition.backend)),
              providerId: definition?.backend.providerId ?? null,
              registered: !!definition,
              vault,
            };
          }),
          revision: application.revision,
          usage: yield* vaultOperation(() => storage.usage()),
        };
      }).pipe(Effect.scoped),
    VaultPut: (
      request: Omit<Mutation, "operation"> & {
        value: string;
        revision?: string;
      }
    ) => mutate({ ...request, operation: "Put" }),
    VaultReveal: (request: { vault: string; key: string; revision?: string }) =>
      Effect.gen(function* () {
        const { backend, revision } = yield* selected(request);
        const value = yield* backendRead(
          request.vault,
          Effect.suspend(() => backend.read(request.key))
        ).pipe(Effect.mapError(adminError));
        if (Option.isNone(value)) {
          return yield* error(
            "NotFound",
            `Vault ${request.vault}/${request.key} not found`
          );
        }
        return {
          key: request.key,
          revision,
          value: Redacted.value(value.value),
          vault: request.vault,
        };
      }).pipe(Effect.scoped),
  };
}
