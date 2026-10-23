/**
 * Read earlier records as workflow inputs: "the output of automation becomes
 * input for later automation". Also the parsers behind `effectory data query`.
 */
import { Data, Effect, Schema } from "effect";

import * as Action from "./action.ts";
import * as Node from "./node.ts";
import type { NodeOptions, Registry } from "./node.ts";
import type * as Output from "./output.ts";
import type { RecordRow, Where } from "./state.ts";

/** `Data.parseWhere` or `Data.parseSince` rejected its input. */
export class InvalidQuery extends Data.TaggedError("InvalidQuery")<{
  readonly message: string;
  readonly input: string;
}> {}

/* oxlint-disable typescript/no-explicit-any -- variance escape hatches for sources. */
type AnyCodec<A> = Schema.Codec<A, any, never, never>;

/**
 * Where a record's value schema comes from: an Action, a Resource type (any
 * value with an `attributes` Schema), or a Schema.
 */
export type Source<A> =
  | Action.Action<string, any, any, any>
  | { readonly attributes: AnyCodec<A> }
  | AnyCodec<A>;

/** The decoded value type of a source. */
export type ValueOf<S> =
  S extends Action.Action<string, any, infer O, any>
    ? O
    : S extends { readonly attributes: AnyCodec<infer A> }
      ? A
      : S extends AnyCodec<infer A>
        ? A
        : never;
/* oxlint-enable typescript/no-explicit-any */

/** The value schema of a source. */
export const schemaOf = (source: unknown): Schema.Codec<unknown, unknown> => {
  if (Action.isAction(source)) {
    return source.definition.output as Schema.Codec<unknown, unknown>;
  }
  if (Schema.isSchema(source)) {
    return source as unknown as Schema.Codec<unknown, unknown>;
  }
  if (
    typeof source === "object" &&
    source !== null &&
    "attributes" in source &&
    Schema.isSchema(source.attributes)
  ) {
    return source.attributes as unknown as Schema.Codec<unknown, unknown>;
  }
  throw new TypeError(
    "Data source must be an Action, a Resource type, or a Schema"
  );
};

const unsafe = /[^\w.@:#+-]/gu;

/** A single node-name segment derived from an FQN, e.g. `latest.verify-pr.check.test`. */
export const nameFor = (prefix: string, fqn: string): string =>
  `${prefix}.${fqn.replaceAll("/", ".").replaceAll(unsafe, "-")}`;

/** One stored version of a record. */
export interface Version<A> {
  readonly runId: string;
  readonly createdAt: number;
  readonly value: A;
}

export interface LatestOptions extends NodeOptions {
  /** Read from this scope instead of the run's. */
  readonly scope?: string;
  /** Node name; default `latest.<fqn with dots>`. */
  readonly name?: string;
}

export interface VersionsOptions extends LatestOptions {
  /** Most versions to return, newest first. Default 10. */
  readonly limit?: number;
}

const splitOptions = <O extends LatestOptions>(options: O | undefined) => {
  const { name, scope, ...rest } = options ?? ({} as O);
  const { limit: _limit, ...nodeOptions } = rest as VersionsOptions;
  return { name, nodeOptions: nodeOptions as NodeOptions, scope };
};

const decodeRecord = (codec: Schema.Codec<unknown, unknown>, row: RecordRow) =>
  Schema.decodeUnknownEffect(codec)(row.value).pipe(
    Effect.mapError(
      (issue) =>
        new Node.NodeFailure({
          message: `Record ${row.id} of ${row.fqn} does not match its schema: ${String(issue)}`,
          tag: "InvalidRecord",
        })
    )
  );

/**
 * The newest record of `fqn` (in this run's scope unless `scope` is given),
 * decoded with the source's schema; `undefined` when there is none.
 *
 * ```ts
 * const previous = yield* Data.latest(Shell, "verify-pr/check/test");
 * ```
 */
export const latest = <S extends Source<unknown>>(
  source: S,
  fqn: string,
  options?: LatestOptions
): Effect.Effect<Output.Output<ValueOf<S> | undefined>, never, Registry> => {
  const json = Schema.toCodecJson(schemaOf(source)) as Schema.Codec<
    unknown,
    unknown
  >;
  const { name, nodeOptions, scope } = splitOptions(options);
  return Node.register<ValueOf<S> | undefined>({
    codec: Schema.UndefinedOr(json) as Schema.Codec<unknown, unknown>,
    execute: (ctx) =>
      Effect.gen(function* executeLatest() {
        const [row] = yield* ctx.state.records({
          collection: ctx.collection,
          fqn,
          limit: 1,
          scope: scope ?? ctx.scope,
        });
        return Node.succeeded(
          row === undefined ? row : yield* decodeRecord(json, row)
        );
      }),
    input: { fqn, scope },
    kind: "data",
    name: name ?? nameFor("latest", fqn),
    options: nodeOptions,
    plan: () => Effect.succeed({ action: "run", detail: `read latest ${fqn}` }),
    record: false,
    reuse: "record",
    type: "Data.latest",
  });
};

/**
 * Stored versions of `fqn` (in this run's scope unless `scope` is given),
 * newest first, decoded with the source's schema.
 */
export const versions = <S extends Source<unknown>>(
  source: S,
  fqn: string,
  options?: VersionsOptions
): Effect.Effect<
  Output.Output<readonly Version<ValueOf<S>>[]>,
  never,
  Registry
> => {
  const json = Schema.toCodecJson(schemaOf(source)) as Schema.Codec<
    unknown,
    unknown
  >;
  const limit = options?.limit ?? 10;
  const { name, nodeOptions, scope } = splitOptions(options);
  const codec = Schema.Array(
    Schema.Struct({
      createdAt: Schema.Finite,
      runId: Schema.String,
      value: json,
    })
  ) as unknown as Schema.Codec<unknown, unknown>;
  return Node.register<readonly Version<ValueOf<S>>[]>({
    codec,
    execute: (ctx) =>
      Effect.gen(function* executeVersions() {
        const rows = yield* ctx.state.records({
          collection: ctx.collection,
          fqn,
          limit,
          scope: scope ?? ctx.scope,
        });
        const decoded = yield* Effect.forEach(rows, (row) =>
          decodeRecord(json, row).pipe(
            Effect.map((value) => ({
              createdAt: row.createdAt,
              runId: row.runId,
              value,
            }))
          )
        );
        return Node.succeeded(decoded);
      }),
    input: { fqn, limit, scope },
    kind: "data",
    name: name ?? nameFor("versions", fqn),
    options: nodeOptions,
    plan: () =>
      Effect.succeed({ action: "run", detail: `read versions of ${fqn}` }),
    record: false,
    reuse: "record",
    type: "Data.versions",
  });
};

// --- CLI parsers -----------------------------------------------------------

type Token =
  | { readonly _tag: "word"; readonly text: string }
  | { readonly _tag: "string"; readonly text: string }
  | { readonly _tag: "op"; readonly text: Where["op"] };

const operators: readonly Where["op"][] = ["<=", ">=", "!=", "=", "<", ">"];
const word = /^[\w.$[\]-]+/u;

const readQuoted = (input: string, start: number) => {
  const quote = input[start];
  let text = "";
  let index = start + 1;
  while (index < input.length && input[index] !== quote) {
    if (input[index] === "\\" && index + 1 < input.length) {
      index += 1;
    }
    text += input[index];
    index += 1;
  }
  return index < input.length ? { end: index + 1, text } : undefined;
};

const tokenize = (input: string) =>
  Effect.gen(function* tokenizeWhere() {
    const tokens: Token[] = [];
    let index = 0;
    while (index < input.length) {
      const rest = input.slice(index);
      const space = /^\s+/u.exec(rest);
      const operator = operators.find((op) => rest.startsWith(op));
      const bare = word.exec(rest);
      if (space) {
        index += space[0].length;
      } else if (rest.startsWith("'") || rest.startsWith('"')) {
        const quoted = readQuoted(input, index);
        if (quoted === undefined) {
          return yield* new InvalidQuery({
            input,
            message: `Unterminated string at ${index}`,
          });
        }
        tokens.push({ _tag: "string", text: quoted.text });
        index = quoted.end;
      } else if (operator) {
        tokens.push({ _tag: "op", text: operator });
        index += operator.length;
      } else if (bare) {
        tokens.push({ _tag: "word", text: bare[0] });
        index += bare[0].length;
      } else {
        return yield* new InvalidQuery({
          input,
          message: `Unexpected "${input[index]}" at ${index}`,
        });
      }
    }
    return tokens;
  });

const literal = (token: Token): Where["value"] | undefined => {
  if (token._tag === "string") {
    return token.text;
  }
  if (token._tag !== "word") {
    return undefined;
  }
  if (token.text === "true" || token.text === "false") {
    return token.text === "true";
  }
  if (token.text === "null") {
    return null;
  }
  const number = Number(token.text);
  return token.text.length > 0 && Number.isFinite(number) ? number : undefined;
};

/**
 * Parse `exitCode != 0 and stdout = 'x'` into record filters. Supports
 * `= != < <= > >=`, numbers, booleans, `null`, quoted strings, and `and`.
 */
export const parseWhere = (
  input: string
): Effect.Effect<readonly Where[], InvalidQuery> =>
  Effect.gen(function* parseWhereClauses() {
    const tokens = yield* tokenize(input);
    const clauses: Where[] = [];
    let index = 0;
    while (index < tokens.length) {
      if (clauses.length > 0) {
        const joiner = tokens[index];
        if (joiner?._tag !== "word" || joiner.text.toLowerCase() !== "and") {
          return yield* new InvalidQuery({
            input,
            message: "Expected `and` between conditions",
          });
        }
        index += 1;
      }
      const [path, op, value] = tokens.slice(index, index + 3);
      const parsed = value === undefined ? undefined : literal(value);
      if (
        path?._tag !== "word" ||
        op?._tag !== "op" ||
        value === undefined ||
        parsed === undefined
      ) {
        return yield* new InvalidQuery({
          input,
          message: "Expected `field op value`",
        });
      }
      if (parsed === null && op.text !== "=" && op.text !== "!=") {
        return yield* new InvalidQuery({
          input,
          message: "null only supports = and !=",
        });
      }
      clauses.push({ op: op.text, path: path.text, value: parsed });
      index += 3;
    }
    return clauses;
  });

const units = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 } as const;
const relative = /^(?<amount>\d+)(?<unit>[dhms])$/u;

/** Parse `7d`, `12h`, `30m`, `45s`, or an ISO date into epoch milliseconds. */
export const parseSince = (
  input: string,
  now: number = Date.now()
): Effect.Effect<number, InvalidQuery> => {
  const groups = relative.exec(input.trim())?.groups;
  if (groups) {
    const unit = groups.unit as keyof typeof units;
    return Effect.succeed(now - Number(groups.amount) * units[unit]);
  }
  const date = Date.parse(input);
  return Number.isNaN(date)
    ? Effect.fail(
        new InvalidQuery({
          input,
          message: "Expected a duration like 7d, 12h, 30m, or an ISO date",
        })
      )
    : Effect.succeed(date);
};
