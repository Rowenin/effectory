/**
 * A workflow is a program that declares a graph: its body runs once per run,
 * at plan time, with the decoded input as plain values, and registers nodes.
 */
import type { Effect, Schema } from "effect";

import type { NodeRow, Registry } from "./node.ts";
import type { RecordRow, RunRow, State } from "./state.ts";

/** What a report renders from. */
export interface ReportContext {
  readonly run: RunRow;
  readonly nodes: readonly NodeRow[];
  readonly records: readonly RecordRow[];
}

/** Renders a finished run's records into an artifact. */
export interface Report {
  readonly name: string;
  readonly format: "markdown" | "junit" | "text" | "json";
  readonly render: (
    ctx: ReportContext
  ) => Effect.Effect<string, unknown, State>;
}

/* oxlint-disable typescript/no-explicit-any -- input types are invariant; `any` lets collections hold every workflow. */
export interface Workflow<
  out Name extends string = string,
  in out I = any,
  out O = unknown,
  out R = never,
> {
  readonly _tag: "Workflow";
  readonly name: Name;
  readonly description: string;
  readonly input: Schema.Codec<I, unknown>;
  /** Keys resource state, `rerun: "on-change"` caching, and admission. */
  readonly scope: (input: I) => string;
  readonly reports: readonly Report[];
  readonly body: (input: I) => Effect.Effect<O, unknown, R | Registry>;
}

/** Any workflow. */
export type Any = Workflow<string, any, unknown, any>;

/** Services a workflow needs: its Actions' services and Resources' Providers. */
export type Requirements<W> =
  W extends Workflow<string, infer _I, infer _O, infer R> ? R : never;

export const isWorkflow = (value: unknown): value is Any =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "Workflow";

/**
 * Define a workflow.
 *
 * ```ts
 * export default Workflow.make("verify-pr", {
 *   description: "...",
 *   input: Schema.Struct({ pr: Schema.Int }),
 *   scope: ({ pr }) => `#${pr}`,
 * }, Effect.fn(function* ({ pr }) { ... }));
 * ```
 */
export const make = <
  const Name extends string,
  S extends Schema.Codec<any, any, never, never>,
  O,
  E,
  R,
>(
  name: Name,
  options: {
    readonly description: string;
    readonly input: S;
    readonly scope?: (input: S["Type"]) => string;
    readonly reports?: readonly Report[];
  },
  body: (input: S["Type"]) => Effect.Effect<O, E, R>
): Workflow<Name, S["Type"], O, Exclude<R, Registry>> => ({
  _tag: "Workflow",
  body: body as (
    input: S["Type"]
  ) => Effect.Effect<O, unknown, Exclude<R, Registry> | Registry>,
  description: options.description,
  input: options.input as Schema.Codec<S["Type"], unknown>,
  name,
  reports: options.reports ?? [],
  scope: options.scope ?? (() => "default"),
});
