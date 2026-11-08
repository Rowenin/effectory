import type { RunWatchFrame } from "@effectory/runtime/history-protocol";
import { OperationError, terminal } from "@effectory/runtime/protocol";
import { Context, Effect, Layer, Option, Stream } from "effect";

import { HostStore } from "./host-store.ts";

export function createRunWatcher(store: typeof HostStore.Service) {
  let observers = 0;
  const watch = (runId: string, principal: string, afterSequence = 0) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Authorization and range checks precede observer admission.
        yield* store.observation(runId, principal, afterSequence);
        yield* Effect.acquireRelease(
          Effect.suspend(() => {
            if (observers >= 16) {
              return Effect.fail(
                new OperationError({
                  code: "LimitExceeded",
                  message: "Repository observer limit reached (16)",
                })
              );
            }
            observers += 1;
            return Effect.void;
          }),
          () =>
            Effect.sync(() => {
              observers -= 1;
            })
        );
        return Stream.paginate(
          { after: afterSequence, initial: true, lastSent: Date.now() },
          (state) =>
            Effect.gen(function* () {
              const { run, events } = yield* store.observation(
                runId,
                principal,
                state.after
              );
              const frames: (typeof RunWatchFrame.Type)[] = [];
              if (state.initial) {
                frames.push({ _tag: "Snapshot", run });
              }
              for (const event of events) {
                frames.push({ _tag: "Event", event });
              }
              if (events.length > 0) {
                frames.push({ _tag: "Snapshot", run });
              }
              const after = events.at(-1)?.sequence ?? state.after;
              if (terminal.has(run.status) && after >= run.lastSequence) {
                return [frames, Option.none()] as const;
              }
              if (frames.length === 0 && Date.now() - state.lastSent >= 5000) {
                frames.push({
                  _tag: "Heartbeat",
                  at: new Date().toISOString(),
                  lastSequence: run.lastSequence,
                  runId,
                });
              }
              if (frames.length === 0) {
                yield* Effect.sleep("100 millis");
              }
              return [
                frames,
                Option.some({
                  after,
                  initial: false,
                  lastSent: frames.length === 0 ? state.lastSent : Date.now(),
                }),
              ] as const;
            })
        );
      })
    );
  return {
    get active() {
      return observers;
    },
    watch,
  };
}

export class RunWatcher extends Context.Service<
  RunWatcher,
  ReturnType<typeof createRunWatcher>
>()("effectory/RunWatcher") {}
export const runWatcherLayer = Layer.effect(
  RunWatcher,
  Effect.map(HostStore, createRunWatcher)
);
