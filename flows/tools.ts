/** Services the demo flows use: a shell for this repository's own tools. */
// oxlint-disable-next-line max-classes-per-file -- the Shell service and its error belong together.
import { Context, Data, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class ShellError extends Data.TaggedError("ShellError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ShellResult {
  readonly exitCode: number;
  /** stdout and stderr, interleaved. */
  readonly output: string;
}

/** Runs commands in the repository and collects their output. */
export class Shell extends Context.Service<
  Shell,
  {
    readonly run: (
      command: string,
      args: readonly string[]
    ) => Effect.Effect<ShellResult, ShellError>;
  }
>()("effectory/flows/Shell") {
  static readonly layer = Layer.effect(Shell)(
    Effect.gen(function* makeShell() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return Shell.of({
        run: (command, args) =>
          Effect.scoped(
            Effect.gen(function* runCommand() {
              const handle = yield* spawner.spawn(
                ChildProcess.make(command, args, {
                  env: { FORCE_COLOR: "0" },
                  extendEnv: true,
                })
              );
              const output = yield* handle.all.pipe(
                Stream.decodeText(),
                Stream.mkString
              );
              return { exitCode: Number(yield* handle.exitCode), output };
            })
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ShellError({
                  cause,
                  message: `Could not run ${[command, ...args].join(" ")}`,
                })
            )
          ),
      });
    })
  );
}
