/* oxlint-disable typescript/no-non-null-assertion -- Tests assert array sizes before use. */
import { expect, test } from "bun:test";

import { Deferred, Effect, Fiber } from "effect";

import { binaryOwner, binaryPool } from "../src/binary-admission.ts";

test("shared groups hand off FIFO and cancelling the first read never strands followers", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const pool = binaryPool(1);
      const held = binaryOwner(pool);
      const waiting = binaryOwner(pool);
      const later = binaryOwner(pool);
      const first = yield* held.read(true);
      const order: string[] = [];
      const a = yield* Effect.forkChild(
        waiting
          .read(true)
          .pipe(Effect.tap(() => Effect.sync(() => order.push("a"))))
      );
      const b = yield* Effect.forkChild(
        waiting
          .read(true)
          .pipe(Effect.tap(() => Effect.sync(() => order.push("b"))))
      );
      const c = yield* Effect.forkChild(
        later
          .read(true)
          .pipe(Effect.tap(() => Effect.sync(() => order.push("c"))))
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(a);
      first.release();
      const second = yield* Fiber.join(b);
      expect(order).toEqual(["b"]);
      second.release();
      const third = yield* Fiber.join(c);
      third.release();
      expect(order).toEqual(["b", "c"]);
    })
  );
});
test("local finite operations queue, all open streams reject overflow, and closing wakes waiters", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const pool = binaryPool(1);
      const owner = binaryOwner(pool);
      const reads = yield* Effect.forEach([0, 1, 2, 3], () =>
        owner.read(false)
      );
      const queued = yield* Effect.forkChild(owner.read(true));
      yield* Effect.yieldNow;
      for (const read of reads) {
        read.open();
      }
      const exit = yield* Fiber.await(queued);
      expect(exit._tag).toBe("Failure");
      for (const read of reads) {
        read.release();
      }
      const finite = yield* Effect.forEach([0, 1, 2, 3], () =>
        owner.read(true)
      );
      const fifth = yield* Effect.forkChild(owner.read(true));
      yield* Effect.yieldNow;
      finite[0]!.release();
      (yield* Fiber.join(fifth)).release();
      for (const read of finite) {
        read.release();
      }
      const holder = binaryOwner(pool);
      const victim = binaryOwner(pool);
      const slot = yield* holder.read(true);
      const pending = yield* Effect.forkChild(
        victim.read(true).pipe(Effect.flip)
      );
      yield* Effect.yieldNow;
      yield* victim.close;
      expect((yield* Fiber.join(pending)).reason).toBe("Closed");
      slot.release();
    })
  );
});
test("publication cleanup retains a group until its writer exits; grant/cancel races leak no capacity", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      for (let i = 0; i < 100; i += 1) {
        const pool = binaryPool(1);
        const owner = binaryOwner(pool);
        const next = binaryOwner(pool);
        const slot = yield* owner.read(true);
        const queued = yield* Effect.forkChild(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const reservation = yield* restore(next.read(true));
              return yield* restore(Effect.never).pipe(
                Effect.ensuring(Effect.sync(reservation.release))
              );
            })
          )
        );
        yield* Effect.yieldNow;
        const cancellation = yield* Effect.forkChild(Fiber.interrupt(queued));
        slot.release();
        yield* Fiber.join(cancellation);
        const another = yield* binaryOwner(pool).read(true);
        another.release();
      }
      const pool = binaryPool(1);
      const owner = binaryOwner(pool);
      const next = binaryOwner(pool);
      const started = yield* Deferred.make<boolean>();
      const cleanup = yield* Deferred.make<boolean>();
      const publication = yield* Effect.forkChild(
        owner.publish(
          Deferred.succeed(started, true).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.await(cleanup))
          )
        )
      );
      yield* Deferred.await(started);
      yield* owner.close;
      let admitted = false;
      const queued = yield* Effect.forkChild(
        next.read(true).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              admitted = true;
            })
          )
        )
      );
      const stop = yield* Effect.forkChild(Fiber.interrupt(publication));
      yield* Effect.yieldNow;
      expect(admitted).toBe(false);
      yield* Deferred.succeed(cleanup, true);
      yield* Fiber.join(stop);
      (yield* Fiber.join(queued)).release();
      expect(admitted).toBe(true);
    })
  );
}, 10_000);
