/* oxlint-disable promise/prefer-await-to-callbacks -- Effect error mapping, not Promise callbacks. */
import { Effect, Stream } from "effect";
import type { Redacted } from "effect";
import * as ChildProcess from "effect/process/ChildProcess";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { AgentError } from "./contracts.ts";

export type Spawner = typeof ChildProcessSpawner.Service;
export function spawn(
  spawner: Spawner,
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | Redacted.Redacted>>,
  input?: string
) {
  return spawner
    .spawn(
      ChildProcess.make(executable, [...args], {
        cwd,
        detached: true,
        env: { ...env },
        extendEnv: false,
        forceKillAfter: "1 second",
        stderr: "pipe",
        stdin:
          input === undefined
            ? "ignore"
            : Stream.succeed(new TextEncoder().encode(input)),
        stdout: "pipe",
      })
    )
    .pipe(
      Effect.mapError(
        () =>
          new AgentError({
            code: "ExecutionFailed",
            message: "Agent process could not be started",
          })
      )
    );
}
export function bounded<E>(
  stream: Stream.Stream<Uint8Array, E>,
  maximum: number
) {
  return Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let size = 0;
    yield* Stream.runForEach(stream, (chunk) =>
      Effect.suspend(() => {
        size += chunk.byteLength;
        if (size > maximum) {
          return Effect.fail(
            new AgentError({
              code: "OutputLimit",
              message: "Agent output exceeded its byte limit",
            })
          );
        }
        chunks.push(chunk);
        return Effect.void;
      })
    );
    return yield* Effect.try({
      catch: () =>
        new AgentError({
          code: "ProtocolError",
          message: "Agent output is not valid UTF-8",
        }),
      try: () =>
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    });
  });
}
export function command(
  spawner: Spawner,
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | Redacted.Redacted>>,
  maximum: number,
  input?: string
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawn(spawner, executable, args, cwd, env, input);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          bounded(child.stdout, maximum),
          bounded(child.stderr, 65_536),
          child.exitCode,
        ],
        { concurrency: "unbounded" }
      );
      return { exitCode, stderr, stdout };
    })
  ).pipe(
    Effect.mapError((error) =>
      error instanceof AgentError
        ? error
        : new AgentError({
            code: "ExecutionFailed",
            message: "Agent process failed",
          })
    )
  );
}
