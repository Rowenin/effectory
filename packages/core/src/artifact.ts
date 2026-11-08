import { Duration, Option, Schema } from "effect";

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
  readonly kind: "json";
  readonly contentType: "application/json";
  readonly schema: S;
  readonly refSchema: ReturnType<typeof referenceSchema<Id>>;
  readonly fields: readonly (readonly string[])[];
  readonly queryFields: readonly QueryField[];
  readonly retention?: {
    readonly maxVersions?: number;
    readonly maxAgeMillis?: number;
  };
}

export interface Bytes<Id extends string = string> {
  readonly id: Id;
  readonly version: number;
  readonly kind: "bytes";
  readonly contentType: string;
  readonly refSchema: ReturnType<typeof referenceSchema<Id>>;
  readonly retention?: Artifact["retention"];
}

export type Any = Artifact | Bytes;

interface CommonSpec<Id extends string> {
  readonly id: Id;
  readonly version: number;
  readonly retention?: {
    readonly maxVersions?: number;
    readonly maxAge?: Duration.Input;
  };
}
interface JsonSpec<
  Id extends string,
  S extends Boundary,
> extends CommonSpec<Id> {
  readonly kind?: "json";
  readonly schema: S;
  readonly fields?: readonly (readonly string[])[];
}
interface BytesSpec<Id extends string> extends CommonSpec<Id> {
  readonly kind: "bytes";
  readonly contentType: string;
  readonly schema?: never;
  readonly fields?: never;
}

function retentionFor(spec: CommonSpec<string>): Artifact["retention"] {
  let retention: Artifact["retention"];
  if ("retention" in spec) {
    const input = spec.retention;
    if (
      !input ||
      Object.keys(input).some(
        (key) => key !== "maxVersions" && key !== "maxAge"
      ) ||
      Object.keys(input).length === 0
    ) {
      throw new Error("Artifact retention requires maxVersions or maxAge");
    }
    const normalized: { maxVersions?: number; maxAgeMillis?: number } = {};
    if ("maxVersions" in input) {
      if (
        typeof input.maxVersions !== "number" ||
        !Number.isSafeInteger(input.maxVersions) ||
        input.maxVersions < 1
      ) {
        throw new Error(
          "Artifact retention maxVersions must be a positive safe integer"
        );
      }
      normalized.maxVersions = input.maxVersions;
    }
    if ("maxAge" in input) {
      const duration = Duration.fromInput(input.maxAge as Duration.Input);
      const millis = Option.isSome(duration)
        ? Math.floor(Duration.toMillis(duration.value))
        : Number.NaN;
      if (!Number.isSafeInteger(millis) || millis < 1) {
        throw new Error(
          "Artifact retention maxAge must be finite and at least one millisecond"
        );
      }
      normalized.maxAgeMillis = millis;
    }
    retention = Object.freeze(normalized);
  }
  return retention;
}

export function make<const Id extends string>(spec: BytesSpec<Id>): Bytes<Id>;
export function make<const Id extends string, S extends Boundary>(
  spec: JsonSpec<Id, S>
): Artifact<Id, S>;
export function make<const Id extends string, S extends Boundary>(
  spec: JsonSpec<Id, S> | BytesSpec<Id>
): Artifact<Id, S> | Bytes<Id> {
  const supported = new Set([
    "id",
    "version",
    "kind",
    "retention",
    ...(spec.kind === "bytes" ? ["contentType"] : ["schema", "fields"]),
  ]);
  if (
    Object.keys(spec).some((key) => !supported.has(key)) ||
    ("kind" in spec && spec.kind !== "json" && spec.kind !== "bytes")
  ) {
    throw new Error("Unsupported artifact specification option");
  }
  identifier(spec.id);
  version(spec.version);
  const retention = retentionFor(spec);
  if (spec.kind === "bytes") {
    if (typeof spec.contentType !== "string") {
      throw new TypeError("Bytes artifacts require a contentType");
    }
    if (spec.contentType.includes(";")) {
      throw new Error(
        "MIME parameters are unsupported; use a type/subtype such as text/csv"
      );
    }
    const contentType = spec.contentType.toLowerCase();
    if (
      contentType.length > 127 ||
      /[^\u0020-\u007E]/u.test(spec.contentType) ||
      !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(
        contentType
      )
    ) {
      throw new Error(
        "Artifact contentType must be an ASCII type/subtype without wildcards, whitespace or parameters"
      );
    }
    return Object.freeze({
      contentType,
      id: spec.id,
      kind: "bytes",
      refSchema: referenceSchema(spec.id),
      version: spec.version,
      ...(retention === undefined ? {} : { retention }),
    });
  }
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
    contentType: "application/json",
    id: spec.id,
    kind: "json",
    schema: spec.schema,
    version: spec.version,
    ...(retention === undefined ? {} : { retention }),
    fields: Object.freeze(fields.map((field) => Object.freeze([...field]))),
    queryFields: Object.freeze(queryFields(spec.schema, fields)),
    refSchema: referenceSchema(spec.id),
  });
}

export type Outputs = Readonly<Record<string, Any>>;
export type Reference = ReturnType<typeof referenceSchema>["Type"];

export { fixture } from "./artifact-fixture.ts";
export type { Fixture, FixtureOptions } from "./artifact-fixture.ts";
