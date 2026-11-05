import { TaskRuntimeError } from "./errors.ts";

export const jsonLimits = Object.freeze({
  bytes: 1_048_576,
  depth: 64,
  values: 100_000,
});
const limit = () =>
  new TaskRuntimeError({
    code: "LimitExceeded",
    message: "JSON boundary exceeds its byte, depth or value-count limit",
  });
const invalid = () =>
  new TaskRuntimeError({
    code: "BoundaryValidation",
    message: "Boundary value is not finite, acyclic JSON",
  });

export interface JsonBudget {
  readonly bytes: number;
  readonly depth: number;
  readonly values: number;
}
function stringBytes(text: string, maximum: number) {
  if (text.length > maximum) {
    throw limit();
  }
  return new TextEncoder().encode(JSON.stringify(text)).byteLength;
}
function scalarBytes(value: unknown, maximum: number) {
  if (value === null) {
    return 4;
  }
  if (typeof value === "string") {
    return stringBytes(value, maximum);
  }
  if (typeof value === "boolean") {
    return value ? 4 : 5;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value).length;
  }
  throw invalid();
}

/** Iterative preflight avoids recursive schema/serializer work on oversized inputs. */
export function checkJsonBudget(
  value: unknown,
  maximum: JsonBudget = jsonLimits
) {
  const active = new WeakSet<object>();
  const pending: {
    readonly value: unknown;
    readonly depth: number;
    readonly leaving?: object;
  }[] = [{ depth: 0, value }];
  let bytes = 0;
  let values = 0;
  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame) {
      break;
    }
    if (frame.leaving) {
      active.delete(frame.leaving);
      continue;
    }
    values += 1;
    if (values > maximum.values || frame.depth > maximum.depth) {
      throw limit();
    }
    const current = frame.value;
    if (current !== null && typeof current === "object") {
      if (active.has(current)) {
        throw invalid();
      }
      active.add(current);
      pending.push({ depth: frame.depth, leaving: current, value: null });
      const entries = Array.isArray(current)
        ? current
        : Object.entries(current);
      if (entries.length > maximum.values - values) {
        throw limit();
      }
      bytes += 2 + Math.max(0, entries.length - 1);
      if (Array.isArray(current)) {
        for (const item of current) {
          pending.push({ depth: frame.depth + 1, value: item });
        }
      } else {
        for (const [key, item] of Object.entries(current)) {
          bytes += stringBytes(key, maximum.bytes) + 1;
          if (bytes > maximum.bytes) {
            throw limit();
          }
          pending.push({ depth: frame.depth + 1, value: item });
        }
      }
    } else {
      bytes += scalarBytes(current, maximum.bytes);
    }
    if (
      bytes > maximum.bytes ||
      pending.length > maximum.values + maximum.depth
    ) {
      throw limit();
    }
  }
}
