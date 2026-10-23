import { Clock, Effect, Schema, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

const argument = Schema.String.check(
  Schema.makeFilter((value) => !value.includes("\0"), {
    expected: "a string without NUL characters",
  })
);
const nonEmptyArgument = argument.check(Schema.isMinLength(1));
const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

export const Input = Schema.Struct({
  // Return a nonzero exit as a result instead of failing with `non-zero-exit`.
  allowNonZeroExit: Schema.optionalKey(Schema.Boolean),
  args: Schema.optionalKey(Schema.Array(argument)),
  command: nonEmptyArgument,
  cwd: Schema.optionalKey(nonEmptyArgument),
  env: Schema.optionalKey(
    Schema.Record(Schema.String, argument).check(
      Schema.makeFilter(
        (value) =>
          Object.keys(value).every(
            (key) => key.length > 0 && !key.includes("=") && !key.includes("\0")
          ),
        {
          expected:
            "nonempty environment variable names without '=' or NUL characters",
        }
      )
    )
  ),
  extendEnv: Schema.optionalKey(Schema.Boolean),
  maxOutputBytes: Schema.optionalKey(positiveInteger),
  stdin: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(positiveInteger),
});

export const Result = Schema.Struct({
  durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  exitCode: Schema.Int,
  stderr: Schema.String,
  stdout: Schema.String,
});

// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError is a schema class factory.
export class ProcessError extends Schema.TaggedError<
  ProcessError,
  { readonly brand: unique symbol }
>()("ProcessError", {
  exitCode: Schema.NullOr(Schema.Int),
  message: Schema.String,
  reason: Schema.Literals([
    "invalid-input",
    "spawn",
    "io",
    "non-zero-exit",
    "timeout",
    "output-limit",
  ]),
  stderr: Schema.String,
  stdout: Schema.String,
}) {}

// Recorded node errors keep only `message`, so it carries the end of stderr.
const diagnosticChars = 2000;
const withDiagnostic = (message: string, stderr: string) => {
  const tail = stderr.trim().slice(-diagnosticChars);
  return tail.length === 0 ? message : `${message}: ${tail}`;
};

/** Run one subprocess with bounded output and a deadline. Input is already validated. */
export const spawn = (input: typeof Input.Type) =>
  Effect.suspend(() => {
    const output = { stderr: [] as Uint8Array[], stdout: [] as Uint8Array[] };
    let bytes = 0;
    let exitCode: number | null = null;
    const text = (channel: keyof typeof output) => {
      const decoder = new TextDecoder();
      return (
        output[channel]
          .map((chunk) => decoder.decode(chunk, { stream: true }))
          .join("") + decoder.decode()
      );
    };
    const failure = (reason: ProcessError["reason"], message: string) =>
      new ProcessError({
        exitCode,
        message,
        reason,
        stderr: text("stderr"),
        stdout: text("stdout"),
      });
    const platformFailure = (reason: "spawn" | "io") =>
      Effect.mapError((cause: PlatformError) =>
        failure(reason, `Process ${reason} failed (${cause.reason._tag})`)
      );

    return Effect.gen(function* executeProcess() {
      // Callers supply validated input: the Process service decodes it first.
      const options = input;
      const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
      const timeoutMs = options.timeoutMs ?? 60_000;
      const collect = (
        channel: keyof typeof output,
        stream: Stream.Stream<Uint8Array, PlatformError>
      ) =>
        Stream.runForEach(
          stream.pipe(
            Stream.mapError((cause) =>
              failure("io", `Process output failed (${cause.reason._tag})`)
            )
          ),
          (chunk) =>
            Effect.suspend(() => {
              bytes += chunk.byteLength;
              if (bytes > maxOutputBytes) {
                return Effect.fail(
                  failure(
                    "output-limit",
                    `Process output exceeded ${maxOutputBytes} bytes`
                  )
                );
              }
              output[channel].push(chunk);
              return Effect.void;
            })
        );

      const operation = Effect.gen(function* runProcess() {
        const spawner = yield* ChildProcessSpawner;
        const start = yield* Clock.currentTimeNanos;
        const child = yield* spawner
          .spawn(
            ChildProcess.make(options.command, options.args ?? [], {
              cwd: options.cwd,
              env: { ...options.env },
              extendEnv: options.extendEnv ?? true,
              forceKillAfter: 1000,
              // Effect owns group cleanup, including descendants after the leader
              // exits. Escalate if SIGTERM does not stop them.
              killSignal: "SIGTERM",
              stderr: "pipe",
              stdin:
                options.stdin === undefined
                  ? "ignore"
                  : Stream.make(new TextEncoder().encode(options.stdin)),
              stdout: "pipe",
            })
          )
          .pipe(platformFailure("spawn"));
        yield* Effect.all(
          [
            child.exitCode.pipe(
              Effect.tap((code) =>
                Effect.sync(() => {
                  exitCode = code;
                })
              ),
              platformFailure("io")
            ),
            collect("stdout", child.stdout),
            collect("stderr", child.stderr),
          ],
          { concurrency: "unbounded" }
        );
        if (exitCode !== 0 && options.allowNonZeroExit !== true) {
          return yield* failure(
            "non-zero-exit",
            withDiagnostic(
              `Process exited with code ${exitCode}`,
              text("stderr")
            )
          );
        }
        const end = yield* Clock.currentTimeNanos;
        return {
          durationMs: Number(end - start) / 1_000_000,
          exitCode: exitCode ?? 0,
          stderr: text("stderr"),
          stdout: text("stdout"),
        };
      });

      return yield* operation.pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(
              failure("timeout", `Process timed out after ${timeoutMs}ms`)
            ),
        })
      );
    });
  });
