import { lstatSync } from "node:fs";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Option } from "effect";

export function checksPreflight<E, R>(client: {
  readonly SystemStatus: (
    request: Record<never, never>
  ) => Effect.Effect<{ readonly capabilities: readonly string[] }, E, R>;
}) {
  return client.SystemStatus({}).pipe(
    Effect.flatMap((status) =>
      status.capabilities.includes("run.checks.v1")
        ? Effect.void
        : Effect.fail(
            new OperationError({
              code: "Unavailable",
              message:
                "This daemon does not support checks. Run effectory daemon stop, then effectory daemon start before using check options.",
            })
          )
    )
  );
}

export function checkDestination(destination?: string) {
  return Effect.try({
    catch: (error) =>
      error instanceof OperationError
        ? error
        : new OperationError({
            code: "InvalidInput",
            message: "Cannot inspect the output destination",
          }),
    try: () => {
      if (destination === undefined) {
        return;
      }
      try {
        lstatSync(destination);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          Reflect.get(error, "code") === "ENOENT"
        ) {
          return;
        }
        throw error;
      }
      throw new OperationError({
        code: "InvalidInput",
        message: `Output already exists: ${destination}`,
      });
    },
  });
}

export function checkLaunch(
  config: {
    readonly junit: boolean;
    readonly background: boolean;
    readonly output: Option.Option<string>;
  },
  json: boolean
) {
  return Effect.gen(function* () {
    if (
      (config.junit && (json || config.background)) ||
      (!config.junit && Option.isSome(config.output))
    ) {
      return yield* new OperationError({
        code: "InvalidInput",
        message:
          "--junit conflicts with --json and --background; --output requires --junit",
      });
    }
    yield* checkDestination(Option.getOrUndefined(config.output));
  });
}
