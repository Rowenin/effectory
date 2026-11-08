import { Context, Effect, Option, Schema } from "effect";

import type { Boundary } from "./boundary.ts";
import { DefinitionError, TaskRuntimeError } from "./errors.ts";
import { RunTags } from "./run-tags.ts";
import { bindings, definitions, synchronous } from "./tag-state.ts";

const bindingType: unique symbol = Symbol("Tag.Binding");

export interface Binding<Key extends string = string> {
  readonly [bindingType]: Key;
}

/** Required per-invocation metadata. Standalone Effects can supply this using a Layer. */
export class Values extends Context.Service<
  Values,
  Readonly<Record<string, string>>
>()("@offtree/effectory-sdk/Tag/Values") {}

export interface Definition<Key extends string, S extends Boundary> {
  (value: S["Type"]): Binding<Key>;
  readonly key: Key;
  readonly codec: Schema.Codec<S["Type"], string>;
  // Public API: `yield* Team.value()` is the chosen syntax (docs/run-tags-contract.md).
  // @effect-diagnostics-next-line lazyEffect:off
  readonly value: () => Effect.Effect<
    Option.Option<S["Type"]>,
    TaskRuntimeError,
    Values
  >;
}

export type Input = readonly Binding[] | Readonly<Record<string, string>>;
// Existential schemas erase only heterogeneous storage, never a definition's call signature.
// oxlint-disable-next-line typescript/no-explicit-any
type AnyDefinition = Definition<string, any>;
export type Declarations =
  | readonly (AnyDefinition | Binding)[]
  | Readonly<Record<string, string>>;

export function make<const Key extends string, S extends Boundary>(
  key: Key,
  schema: S
): Definition<Key, S> {
  try {
    if (typeof key !== "string") {
      throw new DefinitionError({ message: "A tag key must be a string" });
    }
    Schema.decodeSync(RunTags)({ [key]: "" });
    const codec = Schema.String.pipe(
      Schema.decodeTo(Schema.toCodecStringTree(schema))
    );
    const equivalent = Schema.toEquivalence(schema);
    const bind = (value: S["Type"]): Binding<Key> => {
      const encoded = synchronous(key, Schema.encodeUnknownExit(codec)(value));
      synchronous(key, Schema.decodeExit(RunTags)({ [key]: encoded }));
      const decoded = synchronous(key, Schema.decodeExit(codec)(encoded));
      if (!equivalent(value, decoded)) {
        throw new DefinitionError({
          message: `Tag \`${key}\` does not round-trip without changing its value`,
        });
      }
      const binding = Object.freeze({ [bindingType]: key });
      bindings.set(binding, { codec, encoded, key });
      return binding;
    };
    const definition = Object.freeze(
      Object.assign(bind, {
        codec,
        key,
        value: () =>
          Effect.gen(function* () {
            const tags = yield* Values;
            if (!Object.hasOwn(tags, key)) {
              return Option.none<S["Type"]>();
            }
            return yield* Schema.decodeUnknownEffect(codec)(tags[key]).pipe(
              Effect.asSome,
              Effect.mapError(
                (error) =>
                  new TaskRuntimeError({
                    code: "InvalidBoundary",
                    message: `Invalid run tag \`${key}\`: ${error.message.slice(0, 1500)}`,
                  })
              )
            );
          }),
      })
    );
    definitions.set(definition, { codec, key });
    return definition;
  } catch (error) {
    throw error instanceof DefinitionError
      ? error
      : new DefinitionError({
          message: `Invalid tag \`${key}\`: ${String(error).slice(0, 1500)}`,
        });
  }
}
