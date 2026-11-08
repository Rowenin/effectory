import { Cause, Exit, Schema } from "effect";

import { DefinitionError } from "./errors.ts";
import { RunTags } from "./run-tags.ts";

export interface TagSchema {
  readonly key: string;
  readonly codec: Schema.Codec<unknown, string>;
}
export const definitions = new WeakMap<object, TagSchema>();
export const bindings = new WeakMap<
  object,
  TagSchema & { readonly encoded: string }
>();

export function synchronous<A>(
  key: string,
  exit: Exit.Exit<A, Schema.SchemaError>
): A {
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const async = exit.cause.reasons.some(
    (reason) =>
      Cause.isDieReason(reason) && Cause.isAsyncFiberError(reason.defect)
  );
  throw new DefinitionError({
    message: `Invalid tag \`${key}\`: ${
      async
        ? "declaration codec must encode and decode synchronously"
        : Cause.pretty(exit.cause).slice(0, 1400)
    }`,
  });
}

function plainMap(input: unknown): asserts input is Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    throw new DefinitionError({
      message: "Tags must be a plain string map or tag binding array",
    });
  }
}

export function snapshot(input: unknown): typeof RunTags.Type {
  try {
    plainMap(input);
    return Object.freeze(Schema.decodeUnknownSync(RunTags)(input));
  } catch (error) {
    throw error instanceof DefinitionError
      ? error
      : new DefinitionError({
          message: `Invalid tags: ${String(error).slice(0, 1700)}`,
        });
  }
}

const isArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

export function normalize(
  input: unknown,
  publication = false
): Readonly<Record<string, string>> {
  let raw: unknown = input;
  if (isArray(input)) {
    const entries: [string, string][] = [];
    const keys = new Set<string>();
    for (const item of input) {
      const binding =
        typeof item === "object" && item !== null
          ? bindings.get(item)
          : undefined;
      if (!binding) {
        throw new DefinitionError({
          message: "Tags require canonical Tag bindings",
        });
      }
      if (keys.has(binding.key)) {
        throw new DefinitionError({ message: `Duplicate tag: ${binding.key}` });
      }
      keys.add(binding.key);
      entries.push([binding.key, binding.encoded]);
    }
    raw = Object.fromEntries(entries);
  }
  if (!publication) {
    return snapshot(raw);
  }
  plainMap(raw);
  return Object.freeze(
    Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(raw)
  );
}

export function declarations(input: unknown) {
  const schemas: Record<string, TagSchema["codec"]> = {};
  if (!isArray(input)) {
    return { tagSchemas: Object.freeze(schemas), tags: snapshot(input) };
  }
  const values: [string, string][] = [];
  for (const item of input) {
    const eligible =
      (typeof item === "object" && item !== null) || typeof item === "function";
    const binding = eligible ? bindings.get(item) : undefined;
    const definition = eligible ? definitions.get(item) : undefined;
    const metadata = binding ?? definition;
    if (!metadata) {
      throw new DefinitionError({
        message: "Declarations require canonical Tag definitions or bindings",
      });
    }
    if (Object.hasOwn(schemas, metadata.key)) {
      throw new DefinitionError({
        message: `Duplicate tag declaration: ${metadata.key}`,
      });
    }
    Object.defineProperty(schemas, metadata.key, {
      enumerable: true,
      value: metadata.codec,
    });
    if (binding) {
      values.push([binding.key, binding.encoded]);
    }
  }
  if (Object.keys(schemas).length > 32) {
    throw new DefinitionError({
      message: "At most 32 tag declarations are supported",
    });
  }
  return {
    tagSchemas: Object.freeze(schemas),
    tags: snapshot(Object.fromEntries(values)),
  };
}

/** Optional declarations validate only supplied values, without canonicalizing strings. */
export function validate(
  tags: Readonly<Record<string, string>>,
  schemas: Readonly<Record<string, TagSchema["codec"]>>
) {
  const problems: string[] = [];
  for (const [key, codec] of Object.entries(schemas).toSorted(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (!Object.hasOwn(tags, key)) {
      continue;
    }
    try {
      synchronous(
        key,
        Schema.decodeUnknownExit(codec)(tags[key], { errors: "all" })
      );
    } catch (error) {
      problems.push(
        error instanceof DefinitionError
          ? error.message
          : `Invalid tag \`${key}\``
      );
    }
  }
  if (problems.length > 0) {
    let message = "";
    let included = 0;
    for (const problem of problems) {
      if (message.length + problem.length > 1950) {
        break;
      }
      message += `${message ? "; " : ""}${problem}`;
      included += 1;
    }
    if (included < problems.length) {
      message += `; +${problems.length - included} more tag problems`;
    }
    throw new DefinitionError({ message });
  }
}
