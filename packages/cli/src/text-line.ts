/* oxlint-disable promise/avoid-new, promise/prefer-await-to-callbacks */
// Node Writable exposes a callback-based completion/error boundary.
import type { Writable } from "node:stream";

import { Data, Effect } from "effect";

/** Private boundary: only write failures may disable human progress. */
export class ProgressSinkError extends Data.TaggedError("ProgressSinkError")<{
  readonly cause: unknown;
}> {}

/** Await the callback before pulling another frame. Formatting happens outside. */
export function writeTextLine(text: string, output: Writable = process.stderr) {
  return Effect.tryPromise({
    catch: (cause) => new ProgressSinkError({ cause }),
    try: async () =>
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        output.once("error", failed);
        try {
          output.write(`${text}\n`, (error) => {
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
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
  });
}
