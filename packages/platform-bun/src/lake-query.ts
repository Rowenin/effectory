import type { Database } from "bun:sqlite";

import { canonical, checkJsonBudget } from "@effectory/core/internal/boundary";
import {
  Query,
  QueryPage,
  Record as ArtifactRecord,
} from "@effectory/runtime/lake-protocol";
import type {
  Expression,
  Field,
  QueryRow,
} from "@effectory/runtime/lake-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import type { createPagination } from "./pagination.ts";

const FieldDescription = Schema.Struct({
  path: Schema.Array(Schema.String),
  types: Schema.Array(
    Schema.Literals(["null", "boolean", "number", "string", "object", "array"])
  ),
});
const FieldDescriptions = Schema.Array(FieldDescription);
const Stored = Schema.Struct({
  fieldsJson: Schema.String,
  metadataJson: Schema.String,
});
const missing = Symbol("missing");
type Value = Schema.Json | typeof missing;
interface Row {
  readonly record: ArtifactRecord;
  readonly fields: Readonly<Record<string, Schema.Json>>;
}
const invalid = (message: string) =>
  new OperationError({ code: "InvalidInput", message });
const budget = () =>
  new OperationError({
    code: "QueryBudgetExceeded",
    message:
      "Query exceeded 10000 scanned rows, 16 MiB of metadata, or 250 ms; narrow the artifact scope",
  });
function kind(value: Schema.Json) {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
}
const numericMetadata = new Set([
  "version",
  "schemaVersion",
  "sequence",
  "bytes",
]);

function fieldTypes(
  field: Field,
  descriptions: typeof FieldDescriptions.Type
): readonly string[] {
  if ("tag" in field) {
    return ["string"];
  }
  if ("metadata" in field) {
    return [numericMetadata.has(field.metadata) ? "number" : "string"];
  }
  const description = descriptions.find(
    (entry) => canonical(entry.path) === canonical(field.json)
  );
  if (!description) {
    throw invalid("JSON field is not declared queryable for this schema");
  }
  return description.types;
}
function scalarType(field: Field, descriptions: typeof FieldDescriptions.Type) {
  const types = fieldTypes(field, descriptions).filter(
    (type) => type !== "null"
  );
  if (types.length !== 1 || (types[0] !== "number" && types[0] !== "string")) {
    throw invalid(
      "Ordered fields require a single string or finite-number type, optionally nullable"
    );
  }
  return types[0];
}
function fieldValue(row: Row, field: Field): Value {
  if ("metadata" in field) {
    return row.record[field.metadata];
  }
  const source = "tag" in field ? row.record.tags : row.fields;
  const key = "tag" in field ? field.tag : JSON.stringify(field.json);
  return Object.hasOwn(source, key) ? (source[key] ?? null) : missing;
}
function validateExpression(
  root: Expression | undefined,
  descriptions: typeof FieldDescriptions.Type
) {
  const pending = root === undefined ? [] : [{ depth: 1, node: root }];
  let count = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) {
      break;
    }
    count += 1;
    if (count > 64 || item.depth > 8) {
      throw new OperationError({
        code: "LimitExceeded",
        message: "Lake predicate exceeds 64 terms or depth 8",
      });
    }
    const { node, depth } = item;
    switch (node._tag) {
      case "And":
      case "Or": {
        pending.push(
          ...node.terms.map((term) => ({ depth: depth + 1, node: term }))
        );
        break;
      }
      case "Not": {
        pending.push({ depth: depth + 1, node: node.term });
        break;
      }
      default: {
        const types = fieldTypes(node.field, descriptions);
        const values = node._tag === "In" ? node.values : [node.value];
        if (values.some((value) => !types.includes(kind(value)))) {
          throw invalid(
            "Comparison value does not match the declared field type"
          );
        }
        if (
          node._tag !== "Eq" &&
          node._tag !== "In" &&
          scalarType(node.field, descriptions) !== kind(node.value)
        ) {
          throw invalid(
            "Ordered comparison value must match the field's non-null scalar type"
          );
        }
      }
    }
  }
}
function compare(
  actual: Value,
  expected: Schema.Json,
  operation: "Eq" | "Gt" | "Gte" | "Lt" | "Lte"
) {
  if (actual === missing) {
    return false;
  }
  if (operation === "Eq") {
    return canonical(actual) === canonical(expected);
  }
  if (actual === null || typeof actual !== typeof expected) {
    return false;
  }
  let difference = 0;
  if (typeof actual === "number" && typeof expected === "number") {
    difference = actual - expected;
  } else if (typeof actual === "string" && typeof expected === "string") {
    difference = actual < expected ? -1 : Number(actual > expected);
  } else {
    return false;
  }
  switch (operation) {
    case "Gt": {
      return difference > 0;
    }
    case "Gte": {
      return difference >= 0;
    }
    case "Lt": {
      return difference < 0;
    }
    default: {
      return difference <= 0;
    }
  }
}
function matches(node: Expression, row: Row): boolean {
  switch (node._tag) {
    case "And": {
      return node.terms.every((term) => matches(term, row));
    }
    case "Or": {
      return node.terms.some((term) => matches(term, row));
    }
    case "Not": {
      return !matches(node.term, row);
    }
    case "In": {
      return node.values.some((value) =>
        compare(fieldValue(row, node.field), value, "Eq")
      );
    }
    default: {
      return compare(fieldValue(row, node.field), node.value, node._tag);
    }
  }
}
const textOrder = (left: string, right: string) =>
  left < right ? -1 : Number(left > right);
function valueOrder(left: Value, right: Value) {
  if (left === right) {
    return 0;
  }
  if (left === missing) {
    return -1;
  }
  if (right === missing) {
    return 1;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return textOrder(left, right);
  }
  throw invalid("Stored ordered field does not match its declared scalar type");
}
function order(query: Query, left: Row, right: Row) {
  if (query.orderBy === undefined) {
    return left.record.sequence - right.record.sequence;
  }
  for (const item of query.orderBy) {
    const difference = valueOrder(
      fieldValue(left, item.field),
      fieldValue(right, item.field)
    );
    if (difference !== 0) {
      return item.direction === "asc" ? difference : -difference;
    }
  }
  return (
    textOrder(left.record.artifactId, right.record.artifactId) ||
    left.record.version - right.record.version
  );
}
function project(query: Query, row: Row): QueryRow {
  if (query.select === undefined) {
    return row.record;
  }
  return {
    ...row.record,
    projection: Object.fromEntries(
      query.select.flatMap((item) => {
        const value = fieldValue(row, item.field);
        return value === missing ? [] : [[item.name, value]];
      })
    ),
  };
}
function validate(query: Query, descriptions: typeof FieldDescriptions.Type) {
  validateExpression(query.where, descriptions);
  const names = new Set<string>();
  for (const item of query.select ?? []) {
    fieldTypes(item.field, descriptions);
    if (names.has(item.name)) {
      throw invalid("Projection names must be unique");
    }
    names.add(item.name);
  }
  for (const item of query.orderBy ?? []) {
    scalarType(item.field, descriptions);
  }
}

function scanRows(
  database: Database,
  query: Query,
  principal: string,
  snapshot: number,
  started: number
) {
  const latest =
    query.versions === "latest"
      ? "AND NOT EXISTS (SELECT 1 FROM lake_records newer WHERE newer.principal = r.principal AND newer.artifactId = r.artifactId AND newer.sequence <= ? AND newer.version > r.version)"
      : "";
  const statement =
    database.prepare(`SELECT r.metadataJson, r.fieldsJson FROM lake_records r
    WHERE r.principal = ? AND r.schemaId = ? AND r.schemaVersion = ? AND r.sequence <= ? ${latest} ORDER BY r.sequence LIMIT 10001`);
  let scanned = 0;
  let scannedBytes = 0;
  const matched: Row[] = [];
  try {
    for (const raw of statement.iterate(
      principal,
      query.artifact.schemaId,
      query.artifact.schemaVersion,
      snapshot,
      ...(query.versions === "latest" ? [snapshot] : [])
    )) {
      scanned += 1;
      const stored = Schema.decodeUnknownSync(Stored)(raw);
      scannedBytes +=
        Buffer.byteLength(stored.metadataJson) +
        Buffer.byteLength(stored.fieldsJson);
      if (
        scanned > 10_000 ||
        scannedBytes > 16_777_216 ||
        performance.now() - started > 250
      ) {
        throw budget();
      }
      const row = {
        fields: Schema.decodeUnknownSync(
          Schema.Record(Schema.String, Schema.Json)
        )(JSON.parse(stored.fieldsJson)),
        record: Schema.decodeUnknownSync(ArtifactRecord)(
          JSON.parse(stored.metadataJson)
        ),
      };
      if (query.where === undefined || matches(query.where, row)) {
        matched.push(row);
      }
    }
  } finally {
    statement.finalize();
  }
  return { matched, scanned, scannedBytes };
}

function selectRows(query: Query, source: readonly Row[]) {
  const rows: QueryRow[] = [];
  let more = false;
  let bytes = 0;
  for (const row of source) {
    const projected = project(query, row);
    checkJsonBudget(projected, {
      bytes: 2_097_152,
      depth: 64,
      values: 100_000,
    });
    bytes += Buffer.byteLength(JSON.stringify(projected));
    if (rows.length >= query.limit || bytes > 2_097_152) {
      more = true;
      break;
    }
    rows.push(projected);
  }
  if (more && rows.length === 0) {
    throw new OperationError({
      code: "LimitExceeded",
      message: "Projected row exceeds 2 MiB page limit",
    });
  }
  return { more, rows };
}

function decodeQuery(request: Query) {
  checkJsonBudget(request, { bytes: 65_536, depth: 24, values: 4096 });
  try {
    return Schema.decodeUnknownSync(Query)(request, {
      onExcessProperty: "error",
    });
  } catch {
    throw invalid("Query shape, version, field or page limit is invalid");
  }
}

export function lakeQuery(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  request: Query,
  principal: string,
  cursor?: string
) {
  const query = decodeQuery(request);
  const started = performance.now();
  const scope = {
    kind: "lake",
    principal,
    query: Schema.decodeUnknownSync(Schema.Json)(query),
  };
  const token = pages.read(scope, cursor);
  const snapshot = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.snapshot)
    : Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Int }))(
        database
          .query(
            "SELECT COALESCE(MAX(sequence), 0) AS value FROM lake_records WHERE principal = ?"
          )
          .get(principal)
      ).value;
  const after = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.position)
    : 0;
  const schema = database
    .query(
      "SELECT fieldsJson FROM lake_schemas WHERE schemaId = ? AND version = ?"
    )
    .get(query.artifact.schemaId, query.artifact.schemaVersion);
  const descriptions = schema
    ? Schema.decodeUnknownSync(FieldDescriptions)(
        JSON.parse(
          Schema.decodeUnknownSync(
            Schema.Struct({ fieldsJson: Schema.String })
          )(schema).fieldsJson
        )
      )
    : [];
  validate(query, descriptions);
  const { matched, scanned, scannedBytes } = scanRows(
    database,
    query,
    principal,
    snapshot,
    started
  );
  matched.sort((left, right) => order(query, left, right));
  if (performance.now() - started > 250) {
    throw budget();
  }
  const index =
    after === 0
      ? -1
      : matched.findIndex((row) => row.record.sequence === after);
  if (after !== 0 && index < 0) {
    throw new OperationError({
      code: "CursorExpired",
      message: "Query snapshot row is unavailable",
    });
  }
  const { rows, more } = selectRows(query, matched.slice(index + 1));
  return QueryPage.make({
    cursor: more
      ? pages.write(
          scope,
          snapshot,
          rows.at(-1)?.sequence ?? after,
          token?.expires ?? Date.now() + 3_600_000
        )
      : null,
    matched: matched.length,
    rows,
    scanned,
    scannedBytes,
    snapshot,
  });
}
