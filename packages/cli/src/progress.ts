import type { RunWatchFrame } from "@effectory/runtime/history-protocol";
import { Effect } from "effect";

import { formatProgress } from "./progress-format.ts";
import type { ProgressSinkError } from "./text-line.ts";
import { writeTextLine } from "./text-line.ts";

type Frame = typeof RunWatchFrame.Type;

/** One invocation owns these four scalars; no frame history is retained. */
export function createProgress(
  human: boolean,
  afterSequence = 0,
  write: (
    line: string
  ) => Effect.Effect<void, ProgressSinkError> = writeTextLine,
  format: (frame: Frame) => string | undefined = formatProgress
) {
  let enabled = human;
  let through = afterSequence;
  let lastStatus: string | undefined;
  let barrier: number | undefined;

  return {
    get cursor() {
      return through;
    },
    process: <E, R>(
      frame: Frame,
      eligible: (
        snapshot: Extract<Frame, { _tag: "Snapshot" }>
      ) => Effect.Effect<boolean, E, R>
    ) =>
      Effect.gen(function* () {
        if (barrier !== undefined && (!enabled || through >= barrier)) {
          return true;
        }
        if (enabled) {
          if (frame._tag !== "Snapshot" || frame.run.status !== lastStatus) {
            // Formatter defects are deliberately outside the typed sink boundary.
            const line = yield* Effect.sync(() => format(frame));
            if (line !== undefined) {
              yield* write(line).pipe(
                Effect.catchTag("ProgressSinkError", () =>
                  Effect.sync(() => {
                    enabled = false;
                  })
                )
              );
            }
            if (enabled && frame._tag === "Snapshot") {
              lastStatus = frame.run.status;
            }
          }
          if (enabled && frame._tag === "Event") {
            through = frame.event.sequence;
          }
        } else if (!human && frame._tag === "Event") {
          // Machine mode tracks consumption without claiming events were printed.
          through = frame.event.sequence;
        }
        if (barrier !== undefined) {
          return !enabled || through >= barrier;
        }
        if (frame._tag !== "Snapshot" || !(yield* eligible(frame))) {
          return false;
        }
        if (!enabled) {
          return true;
        }
        barrier = frame.run.lastSequence;
        return through >= barrier;
      }),
  };
}
