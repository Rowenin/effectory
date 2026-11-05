import { Schema } from "effect";

import { DefinitionError } from "./errors.ts";

/** Boundaries cannot depend on services during encoding or decoding. */
export type Boundary = Schema.Codec<unknown, unknown, never, never>;

export function identifier(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u.test(value)) {
    throw new DefinitionError({ message: `Invalid identifier: ${value}` });
  }
  return value;
}

export function version(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DefinitionError({
      message: "Version must be a positive integer",
    });
  }
  return value;
}

export function encode(schema: Boundary, value: unknown): Schema.Json {
  const encoded = Schema.encodeUnknownSync(schema)(value);
  return Schema.decodeUnknownSync(Schema.Json)(encoded);
}

export function decode<S extends Boundary>(
  schema: S,
  value: unknown
): S["Type"] {
  return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" });
}

export function canonical(value: Schema.Json): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => {
        if (left === right) {
          return 0;
        }
        return left < right ? -1 : 1;
      })
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export { checkJsonBudget, jsonLimits } from "./json-budget.ts";
