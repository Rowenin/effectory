/* oxlint-disable max-classes-per-file -- the SecretStore service and its error belong together. */
/**
 * Secrets: `Redacted` values read from a `SecretStore` layer. Values never
 * enter State; node statuses and records store `{ secret: name }`.
 */
import { Context, Data, Effect, Layer, Redacted } from "effect";

import * as Node from "./node.ts";
import type { NodeOptions, Registry } from "./node.ts";
import type * as Output from "./output.ts";

export class SecretNotFound extends Data.TaggedError("SecretNotFound")<{
  readonly message: string;
  readonly secret: string;
}> {}

export interface SecretStoreShape {
  readonly get: (
    name: string
  ) => Effect.Effect<Redacted.Redacted<string>, SecretNotFound>;
}

const notFound = (name: string, where: string) =>
  new SecretNotFound({
    message: `Secret ${name} not found in ${where}`,
    secret: name,
  });

/** `gh-webhook` and `ghWebhook` become `GH_WEBHOOK`. */
export const envName = (name: string): string =>
  name
    .replaceAll(/(?<lower>[a-z\d])(?<upper>[A-Z])/gu, "$<lower>_$<upper>")
    .replaceAll(/[^A-Za-z\d]+/gu, "_")
    .toUpperCase();

/** Where Secrets come from. */
export class SecretStore extends Context.Service<
  SecretStore,
  SecretStoreShape
>()("effectory/SecretStore") {
  /** A store from a lookup function. */
  static make(get: SecretStoreShape["get"]): Layer.Layer<SecretStore> {
    return Layer.succeed(SecretStore, { get });
  }

  /** A store over fixed values, for tests and local runs. */
  static fromRecord(
    values: Readonly<Record<string, string>>
  ): Layer.Layer<SecretStore> {
    return SecretStore.make((name) =>
      Object.hasOwn(values, name)
        ? Effect.succeed(Redacted.make(values[name] as string, { label: name }))
        : Effect.fail(notFound(name, "the secret record"))
    );
  }

  /**
   * Environment variables: `name` exactly, then its upper snake case
   * (`gh-webhook` → `GH_WEBHOOK`). Read at lookup time.
   */
  static readonly env: Layer.Layer<SecretStore> = SecretStore.make((name) =>
    Effect.suspend(() => {
      const value = process.env[name] ?? process.env[envName(name)];
      return value === undefined
        ? Effect.fail(notFound(name, `the environment (${envName(name)})`))
        : Effect.succeed(Redacted.make(value, { label: name }));
    })
  );
}

export interface SecretOptions extends NodeOptions {
  /** Node name; default `secret.<name>`. */
  readonly as?: string;
}

const unsafe = /[^\w.@:#+-]/gu;

/**
 * A secret as an `Output<Redacted<string>>`. The SecretStore is captured at
 * registration; the secret is read again on every resume.
 *
 * ```ts
 * const token = yield* Secret("github-token");
 * ```
 */
export const Secret = (
  name: string,
  options?: SecretOptions
): Effect.Effect<
  Output.Output<Redacted.Redacted<string>>,
  never,
  Registry | SecretStore
> =>
  Effect.gen(function* registerSecret() {
    const store = yield* SecretStore;
    const { as, ...nodeOptions } = options ?? {};
    return yield* Node.register<Redacted.Redacted<string>>({
      execute: () => store.get(name).pipe(Effect.map(Node.succeeded)),
      input: { name },
      kind: "secret",
      name: as ?? `secret.${name.replaceAll(unsafe, "-")}`,
      options: nodeOptions,
      plan: () => Effect.succeed({ action: "run", detail: `read ${name}` }),
      record: false,
      reuse: "never",
      type: "Secret",
    });
  });
