import { Effect, Schema } from "effect";
import * as NativeActivity from "effect/workflow/Activity";

import { AutomationError, requireName } from "./authoring.ts";
import type { Codec } from "./authoring.ts";

/**
 * Reusable operation. Supply a stable key for each distinct invocation in a workflow.
 * @deprecated Use `Task.make`: Tasks can call services that require `InTask` and nest child Tasks.
 */
export const define = <
  I extends Codec,
  S extends Codec,
  E extends Codec,
  R,
>(options: {
  readonly name: string;
  readonly input: I;
  readonly success: S;
  readonly error: E;
  readonly execute: (
    input: I["Type"]
  ) => Effect.Effect<NoInfer<S["Type"]>, NoInfer<E["Type"]>, R>;
}) => {
  requireName(options.name);
  const error = Schema.Union([options.error, AutomationError]);
  const inputSchema = Schema.toType(options.input);
  const successSchema = Schema.toType(options.success);
  return (input: I["Type"], invocation?: { readonly key: string }) =>
    NativeActivity.make<R, S, typeof error>({
      error,
      execute: Effect.suspend(() =>
        Schema.decodeUnknownEffect(inputSchema)(input).pipe(
          Effect.mapError(
            (cause) =>
              new AutomationError({
                message: String(cause),
                operation: options.name,
                reason: "invalid-input",
              })
          ),
          Effect.flatMap(options.execute),
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(successSchema)(value).pipe(
              Effect.mapError(
                (cause) =>
                  new AutomationError({
                    message: String(cause),
                    operation: options.name,
                    reason: "invalid-output",
                  })
              )
            )
          )
        )
      ),
      name: `effectory/activity/${options.name.length}:${options.name}/${invocation ? `key:${invocation.key}` : "once"}`,
      success: options.success,
    });
};
