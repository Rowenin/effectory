import { Effect, Option, Scope } from "effect";

import { HostStore } from "./host-store.ts";
import { leafExecution } from "./interpreter.ts";

/** Bounded, scoped delivery. Native resume retries must never block the runner. */
export const recoveryContinuation = Effect.gen(function* () {
  const store = yield* HostStore;
  const scope = yield* Scope.Scope;
  const running = new Set<string>();
  let after = 0;
  // Setup returns the delivery Effect, which shares this state across polls.
  // @effect-diagnostics-next-line returnEffectInGen:off
  return Effect.gen(function* () {
    if (running.size >= 16) {
      return;
    }
    const rows = yield* store.recoveryWork(after);
    for (const row of rows) {
      if (running.size >= 16) {
        break;
      }
      after = row.position;
      if (running.has(row.engineId)) {
        continue;
      }
      running.add(row.engineId);
      yield* Effect.gen(function* () {
        const result = yield* leafExecution.poll(row.engineId);
        if (Option.isNone(result)) {
          return;
        }
        if (result.value._tag === "Complete") {
          yield* store.recoveryComplete(row.runId, row.nodeId);
        } else if (row.needsResume) {
          yield* leafExecution.resume(row.engineId);
        }
      }).pipe(
        Effect.timeout("2 seconds"),
        Effect.ignoreCause,
        Effect.ensuring(Effect.sync(() => running.delete(row.engineId))),
        Effect.forkIn(scope)
      );
    }
    if (
      (rows.length < 50 && after === rows.at(-1)?.position) ||
      rows.length === 0
    ) {
      after = 0;
    }
  });
});
