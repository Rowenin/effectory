/**
 * The Process service runs installed executables with literal arguments,
 * bounded output, and a deadline. It records nothing by itself: use it inside
 * an Action's `run` (see `Shell`), which records the result.
 */
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

/**
 * Runs one command. A nonzero exit (unless `allowNonZeroExit`), a timeout, an
 * output overflow, a spawn failure, or invalid input fails with `ProcessError`.
 */
export class Service extends Context.Service<
  Service,
  {
    readonly exec: (
      input: typeof Input.Type
    ) => Effect.Effect<typeof Result.Type, ProcessError>;
  }
>()("effectory/Process") {}

/** A Process layer with defaults for every command. */
export const make = (
  defaults: Defaults = {}
): Layer.Layer<Service, never, ChildProcessSpawner> =>
  Layer.effect(
    Service,
    Effect.gen(function* makeProcess() {
      const spawner = yield* ChildProcessSpawner;
      return Service.of({
        exec: (input) =>
          Schema.decodeEffect(Input)({
            ...defaults,
            ...input,
            env: { ...defaults.env, ...input.env },
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProcessError({
                  exitCode: null,
                  message: `Invalid process input: ${String(cause)}`,
                  reason: "invalid-input",
                  stderr: "",
                  stdout: "",
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

/** Run a command through the Process service. */
export const exec = (input: typeof Input.Type) =>
  Effect.flatMap(Service, (process) => process.exec(input));
