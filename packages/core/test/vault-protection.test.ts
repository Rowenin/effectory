import { expect, test } from "bun:test";

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Schema,
  SchemaGetter,
} from "effect";

import { decode } from "../src/vault-state.ts";
import { clear, make, protect, register, scrub } from "../src/vault-tracker.ts";

const canary = "CANARY-interrupted-codec-value";
test("decoder finalizer defects cannot leak on external interruption, including admin reads", async () => {
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<boolean>();
      const codec = Schema.String.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transformEffect((value: string) =>
            Effect.scoped(
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() => Effect.die(new Error(value)));
                yield* Deferred.succeed(ready, true);
                return yield* Effect.never;
              })
            )
          ),
          encode: SchemaGetter.transform((value: string) => value),
        })
      );
      const fiber = yield* Effect.forkChild(
        decode("test", "token", codec, canary)
      );
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    })
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(Cause.pretty(exit.cause)).not.toContain(canary);
  }
});

test("attempt protection retains needles through interruption finalizers then clears", async () => {
  const tracker = make();
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<boolean>();
      const fiber = yield* Effect.forkChild(
        protect((owned) =>
          Effect.scoped(
            Effect.gen(function* () {
              register(owned, "test", "token", canary, true);
              yield* Effect.addFinalizer(() => Effect.die(new Error(canary)));
              yield* Deferred.succeed(ready, true);
              return yield* Effect.never;
            })
          )
        )
      );
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    })
  );
  if (Exit.isFailure(exit)) {
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(Cause.pretty(exit.cause)).not.toContain(canary);
  } else {
    throw new Error("expected interruption");
  }
  register(tracker, "test", "token", canary, true);
  clear(tracker);
  expect(tracker.needles.size).toBe(0);
  expect(scrub(tracker, "late public message")).toBe("[late output omitted]");
});

test("structured registration bounds and escaped matching", () => {
  const tracker = make();
  register(
    tracker,
    "test",
    "json",
    JSON.stringify({ region: "us-central-1", token: 'long-secret-"quoted"' }),
    true
  );
  expect(scrub(tracker, 'encoded=long-secret-\\"quoted\\"')).toBe(
    "[vault secret omitted]"
  );
  expect(scrub(tracker, "region=us-central-1")).toBe("[vault secret omitted]");
  expect(() =>
    register(
      make(),
      "test",
      "too-deep",
      JSON.stringify(Array.from({ length: 257 }, (_, n) => `token-value-${n}`)),
      true
    )
  ).toThrow();
});
