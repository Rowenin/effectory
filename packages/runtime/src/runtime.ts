import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect } from "effect";

import { startControlServer } from "./control.ts";
import type { RuntimeOptions } from "./control.ts";
import { initializeWorkspace } from "./workspace.ts";

/** Initialize and own a local runner. Call close() to release its socket and engine. */
export const startRuntime = async (
  workspace: string,
  options: RuntimeOptions = {}
) => {
  await Effect.runPromise(
    initializeWorkspace(workspace).pipe(Effect.provide(BunServices.layer))
  );
  return startControlServer(workspace, options);
};
