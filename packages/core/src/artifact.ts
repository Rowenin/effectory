import { Schema } from "effect";

import { identifier, version } from "./boundary.ts";
import type { Boundary } from "./boundary.ts";
import { queryFields } from "./query-fields.ts";
import type { QueryField } from "./query-fields.ts";

export function referenceSchema<const Id extends string>(id: Id) {
  return Schema.Struct({
    artifactId: Schema.String,
    digest: Schema.String,
    schemaId: Schema.Literal(id),
    schemaVersion: Schema.Int.check(Schema.isGreaterThan(0)),
    version: Schema.Int.check(Schema.isGreaterThan(0)),
  });
}

export interface Artifact<
  Id extends string = string,
  S extends Boundary = Boundary,
> {
  readonly id: Id;
  readonly version: number;
  readonly schema: S;
  readonly refSchema: ReturnType<typeof referenceSchema<Id>>;
  readonly fields: readonly (readonly string[])[];
  readonly queryFields: readonly QueryField[];
}

export function make<const Id extends string, S extends Boundary>(spec: {
  readonly id: Id;
  readonly version: number;
  readonly schema: S;
  readonly fields?: readonly (readonly string[])[];
}): Artifact<Id, S> {
  const supported = new Set(["id", "version", "schema", "fields"]);
  if (Object.keys(spec).some((key) => !supported.has(key))) {
    throw new Error(
      "Unsupported artifact specification option; retention and binary outputs are not implemented"
    );
  }
  identifier(spec.id);
  version(spec.version);
  const fields = spec.fields ?? [];
  if (
    fields.length > 32 ||
    new Set(fields.map((field) => JSON.stringify(field))).size !==
      fields.length ||
    fields.some(
      (field) =>
        field.length === 0 ||
        field.length > 8 ||
        field.some((key) => key.length === 0 || key.length > 100)
    )
  ) {
    throw new Error(
      "Artifact query fields must contain 1–8 path segments, with at most 32 fields"
    );
  }
  return Object.freeze({
    ...spec,
    fields: Object.freeze(fields.map((field) => Object.freeze([...field]))),
    queryFields: Object.freeze(queryFields(spec.schema, fields)),
    refSchema: referenceSchema(spec.id),
  });
}

export type Outputs = Readonly<Record<string, Artifact>>;
export type Reference = ReturnType<typeof referenceSchema>["Type"];
