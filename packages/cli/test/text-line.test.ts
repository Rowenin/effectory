/* oxlint-disable promise/avoid-new, promise/prefer-await-to-callbacks */
// Controlled Writable callbacks exercise asynchronous output ownership.
import { expect, test } from "bun:test";
import { Writable } from "node:stream";

import { Cause, Deferred, Effect, Exit, Fiber } from "effect";

import { writeTextLine } from "../src/text-line.ts";

test("text writes preserve literal content and report only sink failures with the private tag", async () => {
  const writes: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
    },
  });
  await Effect.runPromise(writeTextLine("one 😀", sink));
  expect(writes).toEqual(["one 😀\n"]);
  expect(sink.listenerCount("error")).toBe(0);
  sink.destroy();
  const broken = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("EPIPE"));
    },
  });
  const error = await Effect.runPromise(
    writeTextLine("not written", broken).pipe(Effect.flip)
  );
  expect(error._tag).toBe("ProgressSinkError");
  expect(error.cause).toBeInstanceOf(Error);
  expect(broken.listenerCount("error")).toBeLessThanOrEqual(1);
});

test("a stalled text sink stays interruptible and does not run later writes", async () => {
  let writes = 0;
  let release: (() => void) | undefined;
  const ready = Deferred.makeUnsafe<boolean>();
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      writes += 1;
      release = callback;
      Effect.runSync(Deferred.succeed(ready, true));
    },
  });
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* Effect.forkScoped(
          writeTextLine("first", sink).pipe(
            Effect.andThen(writeTextLine("second", sink))
          )
        );
        yield* Deferred.await(ready);
        yield* Fiber.interrupt(child);
        return yield* Fiber.await(child);
      })
    )
  );
  expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(
    true
  );
  expect(writes).toBe(1);
  release?.();
  sink.destroy();
});
