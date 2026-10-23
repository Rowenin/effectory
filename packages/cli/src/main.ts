#!/usr/bin/env bun
/** The `effectory` executable. */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, Console, Effect, Exit, Runtime } from "effect";
import { CliError } from "effect/cli";

import { main } from "./cli.ts";
import { exitCode, setExitCode } from "./output.ts";

/** Print failures as one clean line; effect/cli has already rendered its own. */
const report = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) {
    return Effect.failCause(cause);
  }
  const error = Cause.squash(cause);
  if (CliError.isCliError(error)) {
    return setExitCode(1);
  }
  const failure = Cause.hasFails(cause);
  const message =
    failure &&
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : Cause.pretty(cause);
  return Console.error(`effectory: ${message}`).pipe(
    Effect.andThen(setExitCode(1))
  );
};

main(process.argv.slice(2)).pipe(
  Effect.catchCause(report),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain({
    disableErrorReporting: true,
    teardown: (exit, onExit) =>
      Exit.isSuccess(exit)
        ? onExit(exitCode())
        : Runtime.defaultTeardown(exit, onExit),
  })
);
