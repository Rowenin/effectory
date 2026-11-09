import { BunServices } from "@effect/platform-bun";
import { OperationError } from "@effectory/runtime/protocol";
import { Context, Effect, Layer, Option, Stream } from "effect";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

interface CommandOptions {
  readonly cwd?: string;
  readonly maximumBytes?: number;
  readonly timeoutMillis?: number;
}
export const SourceCommand = Context.Service<{
  readonly run: (
    executable: string,
    args: readonly string[],
    options?: CommandOptions
  ) => Effect.Effect<Uint8Array, OperationError>;
}>("effectory/SourceCommand");

function bounded<E>(stream: Stream.Stream<Uint8Array, E>, limit: number) {
  return Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let size = 0;
    yield* Stream.runForEach(stream, (bytes) =>
      Effect.suspend(() => {
        size += bytes.length;
        if (size > limit) {
          return Effect.fail(
            new OperationError({
              code: "LimitExceeded",
              message: "Source command output exceeds its limit",
            })
          );
        }
        chunks.push(bytes);
        return Effect.void;
      })
    );
    return Buffer.concat(chunks);
  });
}
export const sourceCommandLayer = Layer.effect(
  SourceCommand,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    return SourceCommand.of({
      run: (executable, args, options = {}) =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(executable, [...args], {
                cwd: options.cwd,
                detached: true,
                env: {
                  ...process.env,
                  GH_DEBUG: "",
                  GH_PROMPT_DISABLED: "1",
                  GIT_TERMINAL_PROMPT: "0",
                  NODE_ENV: "development",
                },
                extendEnv: false,
                forceKillAfter: "1 second",
                stderr: "pipe",
                stdin: "ignore",
                stdout: "pipe",
              })
            );
            const [output, , code] = yield* Effect.all(
              [
                bounded(child.stdout, options.maximumBytes ?? 1_048_576),
                bounded(child.stderr, 65_536),
                child.exitCode,
              ],
              { concurrency: "unbounded" }
            );
            if (code !== 0) {
              return yield* new OperationError({
                code: "Unavailable",
                message:
                  "Git source command failed; check git, gh authentication, Bun, locked dependencies and TypeScript compatibility",
              });
            }
            return output;
          })
        ).pipe(
          // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Effect error mapping is synchronous.
          Effect.mapError((error) =>
            error instanceof OperationError
              ? error
              : new OperationError({
                  code: "Unavailable",
                  message: "Source command could not run",
                })
          ),
          Effect.timeoutOrElse({
            duration: options.timeoutMillis ?? 30_000,
            orElse: () =>
              Effect.fail(
                new OperationError({
                  code: "Unavailable",
                  message: "Source command exceeded its time limit",
                })
              ),
          })
        ),
    });
  })
).pipe(Layer.provide(BunServices.layer));

/** Tests may inject a transport; production always captures an ordinary platform Layer. */
export const sourceCommand = Effect.gen(function* () {
  const supplied = yield* Effect.serviceOption(SourceCommand);
  if (Option.isSome(supplied)) {
    return supplied.value;
  }
  return SourceCommand.of({
    run: (executable, args, options) =>
      Effect.flatMap(SourceCommand, (command) =>
        command.run(executable, args, options)
      ).pipe(Effect.provide(sourceCommandLayer)),
  });
});
