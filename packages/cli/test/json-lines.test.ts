/* oxlint-disable promise/avoid-new, promise/prefer-await-to-callbacks */
// Controlled Node Writable callbacks exercise real backpressure and broken pipes.
import { expect, test } from "bun:test";
import { Writable } from "node:stream";

import { Effect, Stream } from "effect";

import { writeJsonLine } from "../src/json-lines.ts";

test("JSON-Lines does not pull the next frame until the sink accepts the previous write", async () => {
  const writes: string[] = [];
  let release: (() => void) | undefined;
  let firstWrite: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    firstWrite = resolve;
  });
  const sink = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      writes.push(chunk.toString());
      if (writes.length === 1) {
        release = callback;
        firstWrite?.();
      } else {
        return callback();
      }
    },
  });
  let checkpoint = 0;
  const done = Effect.runPromise(
    Stream.fromIterable([1, 2, 3]).pipe(
      Stream.runForEach((sequence) =>
        writeJsonLine({ sequence }, sink).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              checkpoint = sequence;
            })
          )
        )
      )
    )
  );
  await ready;
  expect(writes).toEqual(['{"sequence":1}\n']);
  expect(checkpoint).toBe(0);
  release?.();
  await done;
  expect(writes.map((line) => JSON.parse(line) as unknown)).toEqual([
    { sequence: 1 },
    { sequence: 2 },
    { sequence: 3 },
  ]);
  expect(checkpoint).toBe(3);
  expect(sink.listenerCount("error")).toBe(0);
  sink.destroy();
});

test("a broken JSON-Lines sink fails without advancing its checkpoint", async () => {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("closed sink"));
    },
  });
  let advanced = false;
  const outcome = await Effect.runPromiseExit(
    writeJsonLine({ sequence: 1 }, sink).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          advanced = true;
        })
      )
    )
  );
  expect(outcome._tag).toBe("Failure");
  expect(advanced).toBe(false);
});
