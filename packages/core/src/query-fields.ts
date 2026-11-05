import { Schema } from "effect";

import type { Boundary } from "./boundary.ts";

const primitives = [
  "null",
  "boolean",
  "number",
  "string",
  "object",
  "array",
] as const;
export type Primitive = (typeof primitives)[number];
export interface QueryField {
  readonly path: readonly string[];
  readonly types: readonly Primitive[];
}
function isObject(
  value: Schema.Json | undefined
): value is Readonly<Record<string, Schema.Json>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const object = (value: Schema.Json | undefined) =>
  isObject(value) ? value : undefined;
function fieldChild(
  shape: Readonly<Record<string, Schema.Json>>,
  key: string
): Schema.Json | undefined {
  const properties = object(shape.properties);
  if (properties && Object.hasOwn(properties, key)) {
    return properties[key];
  }
  if (shape.type === "array" && /^(?:0|[1-9][0-9]*)$/u.test(key)) {
    return Array.isArray(shape.prefixItems)
      ? (shape.prefixItems[Number(key)] ?? shape.items)
      : shape.items;
  }
  return object(shape.additionalProperties);
}
const invalid = () =>
  new Error(
    "Queryable field is absent from the encoded schema or uses an unsupported recursive/intersection declaration"
  );

/** Resolve only declared paths; never infer types from the first published value. */
export function queryFields(
  schema: Boundary,
  paths: readonly (readonly string[])[]
): readonly QueryField[] {
  if (paths.length === 0) {
    return [];
  }
  const document = Schema.decodeUnknownSync(
    Schema.Struct({
      definitions: Schema.Record(Schema.String, Schema.Json),
      schema: Schema.Json,
    })
  )(Schema.toJsonSchemaDocument(Schema.toEncoded(schema)));
  let work = 0;
  function resolve(
    node: Schema.Json | undefined,
    remaining: readonly string[],
    depth: number
  ): Primitive[] {
    work += 1;
    if (work > 4096 || depth > 64) {
      throw invalid();
    }
    if (node === false || node === undefined) {
      return [];
    }
    if (node === true) {
      return [...primitives];
    }
    const shape = object(node);
    if (!shape) {
      return [];
    }
    if (typeof shape.$ref === "string") {
      const match = /^#\/(?:\$defs|definitions)\/(?<name>[^/]+)$/u.exec(
        shape.$ref
      );
      const name = match?.groups?.name
        ?.replaceAll("~1", "/")
        .replaceAll("~0", "~");
      if (name === undefined || !Object.hasOwn(document.definitions, name)) {
        throw invalid();
      }
      return resolve(document.definitions[name], remaining, depth + 1);
    }
    const variants = shape.anyOf ?? shape.oneOf;
    if (Array.isArray(variants)) {
      return variants.flatMap((variant) =>
        resolve(variant, remaining, depth + 1)
      );
    }
    if (shape.allOf !== undefined) {
      throw invalid();
    }
    const [key, ...rest] = remaining;
    if (key !== undefined) {
      return resolve(fieldChild(shape, key), rest, depth + 1);
    }
    const types = Array.isArray(shape.type) ? shape.type : [shape.type];
    if (types.every((type) => type === undefined)) {
      return [...primitives];
    }
    return types.flatMap((type) => {
      if (type === "integer") {
        return ["number" as const];
      }
      return primitives.filter((primitive) => primitive === type);
    });
  }
  return paths.map((path) => {
    const types = [...new Set(resolve(document.schema, path, 0))].toSorted();
    if (types.length === 0) {
      throw invalid();
    }
    return Object.freeze({
      path: Object.freeze([...path]),
      types: Object.freeze(types),
    });
  });
}
