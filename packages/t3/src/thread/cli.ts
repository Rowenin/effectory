import { Process } from "@effectory/activities";
import { AutomationError } from "@effectory/sdk";
import type { Codec } from "@effectory/sdk/authoring";
import { Effect, Schema } from "effect";

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

/** Input fields shared by every `t3 thread` activity. */
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

export const ThreadActivityError = Schema.Union([
  Process.ProcessError,
  AutomationError,
]);

export const flag = (name: string, value: string | number | undefined) =>
  value === undefined ? [] : [`--${name}=${value}`];

/** Run `t3 thread <command> ... --json` and decode stdout inside the calling activity. */
export const runJson = <S extends Codec>(
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
            new AutomationError({
              message: `Unexpected T3 output: ${String(cause)}`,
              operation,
              reason: "invalid-output",
            })
        )
      )
    )
  );
