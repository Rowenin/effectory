/**
 * A Target is a named, versioned input preset for a workflow:
 * `effectory run verify-pr --target cypress-app --input pr=12`.
 */
import { Data } from "effect";

import * as Json from "./json.ts";
import type * as Workflow from "./workflow.ts";

export class InvalidTarget extends Data.TaggedError("InvalidTarget")<{
  readonly message: string;
}> {}

/** `T` with every nested property optional (arrays are replaced, not merged). */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends Record<string, unknown>
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface Target<W extends Workflow.Any = Workflow.Any> {
  readonly _tag: "Target";
  readonly workflow: W;
  readonly name: string;
  /** Encoded input preset; CLI overrides are merged over it. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly description: string;
  /** Given, or the first 12 hex digits of the preset's digest. */
  readonly version: string;
}

/** Any Target. */
export type Any = Target;

export const isTarget = (value: unknown): value is Any =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "Target";

const segment = /^[\w.@:#+-]+$/u;

/** The decoded input type of a workflow, whatever its requirements. */
type WorkflowInput<W> =
  W extends Workflow.Workflow<string, infer I, unknown, infer _R> ? I : never;

/**
 * Define a Target.
 *
 * ```ts
 * export const cypressApp = Target.make(verifyPr, "cypress-app", {
 *   repo: { owner: "cypress-io", name: "app" },
 * });
 * ```
 */
export const make = <W extends Workflow.Any>(
  workflow: W,
  name: string,
  input: DeepPartial<WorkflowInput<W>>,
  options?: { readonly description?: string; readonly version?: string }
): Target<W> => {
  if (!segment.test(name)) {
    throw new InvalidTarget({
      message: `Invalid target name "${name}": use letters, digits, and . _ - @ : # +`,
    });
  }
  const preset = Json.toJson(input) as Record<string, unknown>;
  return {
    _tag: "Target",
    description: options?.description ?? "",
    input: preset,
    name,
    version: options?.version ?? Json.digest(preset).slice(0, 12),
    workflow,
  };
};

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/** Deep-merge `override` over `base`; plain objects merge, everything else replaces. */
export const merge = (base: unknown, override: unknown): unknown => {
  if (!(isPlain(base) && isPlain(override))) {
    return override === undefined ? base : override;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key !== "__proto__") {
      result[key] = merge(base[key], value);
    }
  }
  return result;
};

/** Expand dotted keys: `{ "repo.name": "app" }` → `{ repo: { name: "app" } }`. */
export const expand = (
  values: Readonly<Record<string, unknown>>
): Record<string, unknown> => {
  let result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    let nested: unknown = value;
    for (const part of key.split(".").toReversed()) {
      nested = { [part]: nested };
    }
    result = merge(result, nested) as Record<string, unknown>;
  }
  return result;
};

/**
 * The target's preset with `overrides` deep-merged over it. Override keys
 * may be dotted (`repo.name`). Returns the encoded workflow input.
 */
export const resolve = (
  target: Any,
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> =>
  merge(target.input, expand(overrides)) as Record<string, unknown>;

const parseValue = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/**
 * Parse CLI `--input` assignments: `["pr=12", "repo.name=app", 'flags=["a"]']`
 * → `{ pr: 12, repo: { name: "app" }, flags: ["a"] }`. Values that parse as
 * JSON are JSON; anything else is a string.
 */
export const parseAssignments = (
  assignments: readonly string[]
): Record<string, unknown> => {
  const flat: Record<string, unknown> = {};
  for (const assignment of assignments) {
    const index = assignment.indexOf("=");
    if (index <= 0) {
      throw new InvalidTarget({
        message: `Expected key=value, got "${assignment}"`,
      });
    }
    flat[assignment.slice(0, index)] = parseValue(assignment.slice(index + 1));
  }
  return expand(flat);
};
