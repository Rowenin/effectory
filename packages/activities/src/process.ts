import { AutomationError, InTask } from "@effectory/sdk";
import { Context, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import type { Result } from "./internal/spawn.ts";
import { Input, ProcessError, spawn } from "./internal/spawn.ts";

export { Input, ProcessError, Result } from "./internal/spawn.ts";

/** Defaults applied to every command; a command's own values take precedence. */
export type Defaults = Partial<
  Pick<
    typeof Input.Type,
    "cwd" | "env" | "extendEnv" | "maxOutputBytes" | "timeoutMs"
  >
>;

/** Runs installed executables with literal arguments. Nothing is recorded. */
class Process extends Context.Service<
  Process,
  {
    readonly exec: (
      input: typeof Input.Type
    ) => Effect.Effect<typeof Result.Type, ProcessError | AutomationError>;
  }
>()("effectory/Process") {}
export { Process as Service };

/** A Process layer with defaults for every command. */
export const make = (defaults: Defaults = {}) =>
  Layer.effect(
    Process,
    Effect.gen(function* makeProcess() {
      const spawner = yield* ChildProcessSpawner;
      return Process.of({
        exec: (input) =>
          Schema.decodeEffect(Input)({
            ...defaults,
            ...input,
            env: { ...defaults.env, ...input.env },
          }).pipe(
            Effect.mapError(
              (cause) =>
                new AutomationError({
                  message: String(cause),
                  operation: "process.exec",
                  reason: "invalid-input",
                })
            ),
            Effect.flatMap(spawn),
            Effect.provideService(ChildProcessSpawner, spawner)
          ),
      });
    })
  );

/** The Process layer with built-in defaults. */
export const layer = make();

/**
 * Run a command. Only callable inside a Task, which records the result; a
 * nonzero exit, timeout, or output overflow fails with `ProcessError`.
 */
export const exec = (input: typeof Input.Type) =>
  Effect.gen(function* execInTask() {
    yield* InTask;
    const process = yield* Process;
    return yield* process.exec(input);
  });

/** Errors a Task that runs commands can fail with. */
export const Failure = Schema.Union([ProcessError, AutomationError]);
