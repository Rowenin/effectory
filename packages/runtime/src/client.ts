import { realpath } from "node:fs/promises";

import { Data, Effect, Schema } from "effect";

import { workspacePaths } from "./paths.ts";
import { ControlResponse } from "./protocol.ts";
import type { ControlMessage } from "./protocol.ts";

export class RuntimeClientError extends Data.TaggedError("RuntimeClientError")<{
  message: string;
  unavailable?: boolean;
}> {}

/** Other CLI invocations talk to the sole owner; they never open the engine database. */
export const requestControl = (workspace: string, message: ControlMessage) =>
  Effect.tryPromise({
    catch: (error) =>
      error instanceof RuntimeClientError
        ? error
        : new RuntimeClientError({
            message: error instanceof Error ? error.message : String(error),
          }),
    try: async () => {
      const root = await realpath(workspace);
      let response: Response;
      try {
        response = await fetch("http://localhost/control", {
          body: JSON.stringify(message),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          unix: workspacePaths(root).socket,
        });
      } catch (error) {
        throw new RuntimeClientError({
          message: `Cannot reach the local runtime for ${root}. ${String(error)}`,
          unavailable: true,
        });
      }
      return response.json() as Promise<unknown>;
    },
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ControlResponse)),
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(result.value)
        : Effect.fail(new RuntimeClientError({ message: result.error }))
    )
  );
