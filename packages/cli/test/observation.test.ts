import { expect, test } from "bun:test";

import type { RunWatchFrame } from "@effectory/runtime/history-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect";

import { consumeObservation, stopForeground } from "../src/observation.ts";

const snapshot = (
  status: "Waiting" | "Running" | "NeedsAttention" | "Succeeded"
): typeof RunWatchFrame.Type => ({
  _tag: "Snapshot",
  run: {
    acceptedAt: new Date(0).toISOString(),
    kind: "workflow",
    lastSequence: 0,
    revision: "revision",
    runId: "run",
    status,
    tags: {},
    targetId: "workflow",
  },
});

test("foreground checks every Waiting snapshot and stays through timers until outside action opens", async () => {
  let queries = 0;
  const frames = [
    snapshot("Waiting"),
    snapshot("Waiting"),
    snapshot("Waiting"),
    snapshot("Succeeded"),
  ];
  const seen = await Effect.runPromise(
    Stream.fromIterable(frames).pipe(
      Stream.takeUntilEffect((frame) =>
        stopForeground(frame, () =>
          Effect.sync(() => {
            queries += 1;
            return queries === 3;
          })
        )
      ),
      Stream.runCollect
    )
  );
  expect(queries).toBe(3);
  expect(seen).toHaveLength(3);
  expect(
    await Effect.runPromise(
      stopForeground(snapshot("NeedsAttention"), () =>
        Effect.die("must not query")
      )
    )
  ).toBe(true);
  expect(
    await Effect.runPromise(
      stopForeground(snapshot("Running"), () => Effect.die("must not query"))
    )
  ).toBe(false);
});

test("remote child interruption becomes Unavailable and typed limits retain their identity", async () => {
  const remote = await Effect.runPromise(
    consumeObservation(Effect.interrupt).pipe(Effect.flip)
  );
  expect(remote.code).toBe("Unavailable");
  const limit = new OperationError({
    code: "LimitExceeded",
    message: "capacity",
  });
  expect(
    await Effect.runPromise(
      consumeObservation(Effect.fail(limit)).pipe(Effect.flip)
    )
  ).toBe(limit);
});

test("local parent interruption stays interrupted and releases the child", async () => {
  let released = false;
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<boolean>();
        const child = yield* Effect.forkScoped(
          consumeObservation(
            Deferred.succeed(started, true).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  released = true;
                })
              )
            )
          )
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(child);
        return yield* Fiber.await(child);
      })
    )
  );
  expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(
    true
  );
  expect(released).toBe(true);
});
