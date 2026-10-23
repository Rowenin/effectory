/** JSON helpers for persisted values: canonical form, digests, secret redaction. */
import { createHash } from "node:crypto";

import { Redacted } from "effect";

/**
 * Make a value safe to persist. Redacted values become `{ secret: label }`, so
 * secret values never enter records or node statuses.
 */
export const toJson = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) {
    return { secret: value.label ?? "redacted" };
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(toJson);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, toJson(child)])
    );
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
};

/** JSON with sorted object keys, so equal values produce equal strings. */
export const canonical = (value: unknown): string => {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return item.map(sort);
    }
    if (typeof item === "object" && item !== null) {
      return Object.fromEntries(
        Object.keys(item)
          .toSorted()
          .map((key) => [key, sort((item as Record<string, unknown>)[key])])
      );
    }
    return item;
  };
  return JSON.stringify(sort(toJson(value))) ?? "null";
};

/** SHA-256 of the canonical JSON form. */
export const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
