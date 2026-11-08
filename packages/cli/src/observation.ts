import type { RunWatchFrame } from "@effectory/runtime/history-protocol";
import { OperationError, terminal } from "@effectory/runtime/protocol";
import { Cause, Effect, Exit, Fiber } from "effect";

/** Await the child's Exit without re-raising remote interruption in the parent. */
export const consumeObservation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.forkScoped(effect);
      const result = yield* Fiber.await(child);
      if (Exit.isSuccess(result)) {
        return result.value;
      }
      if (Cause.hasInterruptsOnly(result.cause)) {
        return yield* new OperationError({
          code: "Unavailable",
          message: "Observation disconnected from the daemon",
        });
      }
      return yield* Effect.failCause(result.cause);
    })
  );

export function stopForeground<E, R>(
  frame: typeof RunWatchFrame.Type,
  openWait: () => Effect.Effect<boolean, E, R>
) {
  if (frame._tag !== "Snapshot") {
    return Effect.succeed(false);
  }
  if (terminal.has(frame.run.status) || frame.run.status === "NeedsAttention") {
    return Effect.succeed(true);
  }
  return frame.run.status === "Waiting" ? openWait() : Effect.succeed(false);
}
