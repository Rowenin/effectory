/* oxlint-disable promise/avoid-new, promise/prefer-await-to-callbacks */
// Node Writable exposes a callback-based completion/error boundary.
import type { Writable } from "node:stream";

import { Effect } from "effect";

/** Await each write before pulling another frame from the RPC stream. */
export function writeJsonLine(
  value: unknown,
  output: Writable = process.stdout
) {
  return Effect.tryPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        output.once("error", failed);
        try {
          output.write(`${JSON.stringify(value)}\n`, (error) => {
            if (error) {
              // Writable emits its error after this callback; keep the listener for it.
              reject(error);
            } else {
              output.removeListener("error", failed);
              resolve();
            }
          });
        } catch (error) {
          output.removeListener("error", failed);
          reject(error);
        }
      })
  );
}
