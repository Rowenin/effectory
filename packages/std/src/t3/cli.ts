import { Effect, Schema } from "effect";

import * as Process from "../process.ts";

export const text = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 && !value.includes("\0"), {
    expected: "a nonempty string without NUL characters",
  })
);
// Flags use --name=value; only positional values could be mistaken for flags.
export const positional = text.check(
  Schema.makeFilter((input) => !input.startsWith("-"), {
    expected: "a value that does not start with '-'",
  })
);
export const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
export const message = Schema.String.check(Schema.isMinLength(1));

/** Input fields shared by every `t3 thread` Action. */
export const options = {
  baseDir: Schema.optionalKey(text),
  cwd: Schema.optionalKey(text),
  executable: Schema.optionalKey(text),
  maxOutputBytes: Schema.optionalKey(positiveInteger),
  timeoutMs: Schema.optionalKey(positiveInteger),
};
export interface Options {
  readonly baseDir?: string;
  readonly cwd?: string;
  readonly executable?: string;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

/** The T3 CLI printed something other than the JSON it documents. */
// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError is a schema class factory.
export class T3Error extends Schema.TaggedError<
  T3Error,
  { readonly brand: unique symbol }
>()("T3Error", {
  message: Schema.String,
  operation: Schema.String,
  reason: Schema.Literals(["invalid-output"]),
}) {}

export const flag = (name: string, value: string | number | undefined) =>
  value === undefined ? [] : [`--${name}=${value}`];

/** Run `t3 thread <command> ... --json` through Process and decode stdout. */
export const runJson = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  operation: string,
  schema: S,
  invocation: Options & {
    readonly command: string;
    readonly flags: readonly string[];
    readonly positionals: readonly string[];
    readonly stdin?: string;
  }
) =>
  Process.exec({
    args: [
      "thread",
      invocation.command,
      ...flag("base-dir", invocation.baseDir),
      ...invocation.flags,
      "--json",
      ...invocation.positionals,
    ],
    command: invocation.executable ?? "t3",
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    ...(invocation.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: invocation.maxOutputBytes }),
    ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
    ...(invocation.timeoutMs === undefined
      ? {}
      : { timeoutMs: invocation.timeoutMs }),
  }).pipe(
    Effect.flatMap((result) =>
      Schema.decodeEffect(Schema.fromJsonString(schema))(
        result.stdout.trim()
      ).pipe(
        Effect.mapError(
          (cause) =>
            new T3Error({
              message: `Unexpected T3 output: ${String(cause)}`,
              operation,
              reason: "invalid-output",
            })
        )
      )
    )
  );
