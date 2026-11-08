/* oxlint-disable unicorn/consistent-function-scoping -- Pure evaluator helpers are grouped with their error factory. */
import { Schema } from "effect";
import { absurd } from "effect/Function";

import type {
  Expression,
  Field,
  Query,
  QueryRow,
  Record as ArtifactRecord,
} from "./artifact-query-schema.ts";
import { canonical } from "./boundary.ts";

const FieldDescription = Schema.Struct({
  path: Schema.Array(Schema.String),
  types: Schema.Array(
    Schema.Literals(["null", "boolean", "number", "string", "object", "array"])
  ),
});
export const FieldDescriptions = Schema.Array(FieldDescription);
export interface Row {
  readonly record: ArtifactRecord;
  readonly fields: Readonly<Record<string, Schema.Json>>;
}

/** Shared semantics; adapters retain their own boundary error types. */
export function makeQueryEvaluator(
  failure: (code: "InvalidInput" | "LimitExceeded", message: string) => Error
) {
  const missing = Symbol("missing");
  type Value = Schema.Json | typeof missing;
  const invalid = (message: string) => failure("InvalidInput", message);
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
  function scalarType(
    field: Field,
    descriptions: typeof FieldDescriptions.Type
  ) {
    const types = fieldTypes(field, descriptions).filter(
      (type) => type !== "null"
    );
    if (
      types.length !== 1 ||
      (types[0] !== "number" && types[0] !== "string")
    ) {
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
        throw failure(
          "LimitExceeded",
          "Lake predicate exceeds 64 terms or depth 8"
        );
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
        case "Eq":
        case "Gt":
        case "Gte":
        case "In":
        case "Lt":
        case "Lte": {
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
          break;
        }
        default: {
          absurd(node);
        }
      }
    }
  }
  function compare(
    actual: Value,
    expected: Schema.Json,
    operation: "Eq" | "Gt" | "Gte" | "Lt" | "Lte"
  ): boolean {
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
      case "Lte": {
        return difference <= 0;
      }
      default: {
        return absurd(operation);
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
      case "Eq":
      case "Gt":
      case "Gte":
      case "Lt":
      case "Lte": {
        return compare(fieldValue(row, node.field), node.value, node._tag);
      }
      default: {
        return absurd(node);
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
    throw invalid(
      "Stored ordered field does not match its declared scalar type"
    );
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

  return { matches, order, project, validate };
}
