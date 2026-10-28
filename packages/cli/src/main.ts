#!/usr/bin/env bun
/** The `flow` executable. */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, Console, Effect } from "effect";
import { CliError } from "effect/cli";

import { main } from "./cli.ts";

/** Print a failure as one line; effect/cli has already rendered its own. */
const report = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) {
    return Effect.failCause(cause);
  }
  process.exitCode = 1;
  const error = Cause.squash(cause);
  if (CliError.isCliError(error)) {
    return Effect.void;
  }
  const message =
    Cause.hasFails(cause) && error instanceof Error
      ? error.message
      : Cause.pretty(cause);
  return Console.error(`flow: ${message}`);
};

main(process.argv.slice(2)).pipe(
  Effect.catchCause(report),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain({ disableErrorReporting: true })
);
