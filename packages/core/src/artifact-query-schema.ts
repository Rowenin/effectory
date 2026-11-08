/* oxlint-disable no-redeclare */
// Runtime schemas and decoded types intentionally share names.
import { Schema } from "effect";

export const ContentType = Schema.String.check(
  Schema.isMaxLength(127),
  Schema.isPattern(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u)
);

const Name = Schema.NonEmptyString.check(Schema.isMaxLength(100));
export const Field = Schema.Union([
  Schema.Struct({ tag: Name }),
  Schema.Struct({
    json: Schema.Array(Name).check(Schema.isBetweenLength(1, 8)),
  }),
  Schema.Struct({
    metadata: Schema.Literals([
      "runId",
      "taskId",
      "revision",
      "output",
      "artifactId",
      "version",
      "committedAt",
      "sequence",
      "bytes",
      "schemaId",
      "schemaVersion",
      "digest",
      "attemptId",
      "invocationPath",
    ]),
  }),
]);
export type Field = typeof Field.Type;
export interface Predicate {
  readonly _tag: "And" | "Or";
  readonly terms: readonly Expression[];
}
export interface Negation {
  readonly _tag: "Not";
  readonly term: Expression;
}
export interface Comparison {
  readonly _tag: "Eq" | "Gt" | "Gte" | "Lt" | "Lte";
  readonly field: Field;
  readonly value: Schema.Json;
}
export interface Membership {
  readonly _tag: "In";
  readonly field: Field;
  readonly values: readonly Schema.Json[];
}
export type Expression = Predicate | Negation | Comparison | Membership;
export const Expression: Schema.Codec<Expression> = Schema.suspend(() =>
  Schema.Union([
    Schema.Struct({
      _tag: Schema.Literals(["And", "Or"]),
      terms: Schema.Array(Expression).check(Schema.isBetweenLength(1, 64)),
    }),
    Schema.TaggedStruct("Not", { term: Expression }),
    Schema.Struct({
      _tag: Schema.Literals(["Eq", "Gt", "Gte", "Lt", "Lte"]),
      field: Field,
      value: Schema.Json,
    }),
    Schema.TaggedStruct("In", {
      field: Field,
      values: Schema.Array(Schema.Json).check(Schema.isBetweenLength(1, 32)),
    }),
  ])
);
export const Equal = Schema.TaggedStruct("Eq", {
  field: Field,
  value: Schema.Json,
});
export const Query = Schema.Struct({
  artifact: Schema.Struct({
    schemaId: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
    schemaVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  limit: Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 1 })),
  orderBy: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        direction: Schema.Literals(["asc", "desc"]),
        field: Field,
      })
    ).check(Schema.isBetweenLength(1, 4))
  ),
  select: Schema.optionalKey(
    Schema.Array(Schema.Struct({ field: Field, name: Name })).check(
      Schema.isBetweenLength(1, 32)
    )
  ),
  version: Schema.Literal(1),
  versions: Schema.Literals(["all", "latest"]),
  where: Schema.optionalKey(Expression),
});
export type Query = typeof Query.Type;
export const Record = Schema.Struct({
  artifactId: Schema.String,
  attemptId: Schema.String,
  bytes: Schema.Int,
  committedAt: Schema.String,
  contentType: Schema.optionalKey(ContentType),
  digest: Schema.String,
  invocationPath: Schema.String,
  kind: Schema.optionalKey(Schema.Literals(["json", "bytes"])),
  output: Schema.String,
  revision: Schema.String,
  runId: Schema.String,
  schemaId: Schema.String,
  schemaVersion: Schema.Int,
  sequence: Schema.Int,
  tags: Schema.Record(Schema.String, Schema.String),
  taskId: Schema.String,
  version: Schema.Int,
});
export type Record = typeof Record.Type;
export const QueryRow = Schema.Struct({
  ...Record.fields,
  projection: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
export type QueryRow = typeof QueryRow.Type;
export const QueryPage = Schema.Struct({
  cursor: Schema.NullOr(Schema.String),
  matched: Schema.Int,
  rows: Schema.Array(QueryRow).check(Schema.isMaxLength(200)),
  scanned: Schema.Int,
  scannedBytes: Schema.Int,
  snapshot: Schema.Int,
});
export const Content = Schema.Struct({ metadata: Record, value: Schema.Json });
