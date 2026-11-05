import { durationMillis } from "@effectory/core/internal/policy";
import { Cause, Context, Effect, Option, Schedule, Schema } from "effect";
import { Activity, DurableClock, DurableDeferred } from "effect/workflow";

import { ExecutionFailure, hostFailure } from "./execution-boundary.ts";
import { HostStore } from "./host-store.ts";

export const ExecutionDeadline = Context.Reference<number>(
  "effectory/ExecutionDeadline",
  { defaultValue: () => Number.POSITIVE_INFINITY }
);

const Outcome = Schema.Union([
  Schema.TaggedStruct("Success", { value: Schema.Json }),
  Schema.TaggedStruct("Failure", { error: ExecutionFailure }),
]);

function outcome<R>(body: Effect.Effect<Schema.Json, ExecutionFailure, R>) {
  return body.pipe(
    Effect.map((value): typeof Outcome.Type => ({ _tag: "Success", value })),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      const failure = Cause.findErrorOption(cause);
      return Effect.succeed<typeof Outcome.Type>({
        _tag: "Failure",
        error: Option.isSome(failure)
          ? failure.value
          : hostFailure("Execution failed unexpectedly"),
      });
    })
  );
}

/** Effect owns the absolute deadline, timer and write-once race outcome. */
export function withDeadline<R, R2>(
  runId: string,
  name: string,
  duration: string,
  body: Effect.Effect<Schema.Json, ExecutionFailure, R>,
  expired: (deadline: number) => Effect.Effect<never, ExecutionFailure, R2>
) {
  return Effect.gen(function* () {
    const parent = yield* ExecutionDeadline;
    const deadline = yield* Activity.make({
      execute: Effect.sync(() =>
        Math.min(parent, Date.now() + durationMillis(duration))
      ),
      interruptRetryPolicy: Schedule.recurs(0),
      name: `deadline-start/${name}`,
      success: Schema.Finite,
    });
    yield* (yield* HostStore)
      .appendEvent(runId, `deadline/${name}`, "DeadlineStarted", {
        deadline,
        name,
      })
      .pipe(Effect.mapError(() => hostFailure("Deadline projection failed")));
    const result = yield* DurableDeferred.raceAll({
      effects: [
        outcome(
          Effect.suspend(
            (): Effect.Effect<Schema.Json, ExecutionFailure, R | R2> =>
              Date.now() >= deadline
                ? expired(deadline)
                : body.pipe(Effect.provideService(ExecutionDeadline, deadline))
          )
        ),
        outcome(
          DurableClock.sleep({
            duration: Math.max(1, deadline - Date.now()),
            inMemoryThreshold: 0,
            name: `deadline/${name}`,
          }).pipe(Effect.andThen(Effect.suspend(() => expired(deadline))))
        ),
      ],
      error: ExecutionFailure,
      name: `deadline/${name}`,
      success: Outcome,
    });
    return result._tag === "Success" ? result.value : yield* result.error;
  });
}
