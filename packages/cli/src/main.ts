#!/usr/bin/env bun
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Cause, Console, Effect } from "effect";

import { run } from "./index.ts";

run.pipe(
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : Console.error(Cause.pretty(cause))
  ),
  BunRuntime.runMain({ disableErrorReporting: true })
);
