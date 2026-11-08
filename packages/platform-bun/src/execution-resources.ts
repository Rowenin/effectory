import { Context, Effect, Layer, Scope, Semaphore } from "effect";

export const ExecutionResources = Context.Service<{
  readonly active: (runId: string) => number;
  /** Invocation execution includes permit queues and cleanup, but not durable sleeps. */
  readonly working: (runId: string) => number;
  readonly trackWork: <A, E, R>(
    runId: string,
    body: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  readonly global: Semaphore.Semaphore;
  readonly reports: Semaphore.Semaphore;
  readonly interrupt: (
    runId: string,
    id: string,
    request: Effect.Effect<void>
  ) => Effect.Effect<void>;
  readonly track: <A, E, R>(
    runId: string,
    body: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  readonly permits: (
    runId: string,
    path: string,
    concurrency: number
  ) => Semaphore.Semaphore;
  readonly release: (runId: string) => void;
}>("effectory/ExecutionResources");

function track<A, E, R>(
  counts: Map<string, number>,
  runId: string,
  body: Effect.Effect<A, E, R>
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      counts.set(runId, (counts.get(runId) ?? 0) + 1);
    }),
    () => body,
    () =>
      Effect.sync(() => {
        const count = (counts.get(runId) ?? 1) - 1;
        if (count === 0) {
          counts.delete(runId);
        } else {
          counts.set(runId, count);
        }
      })
  );
}

export const executionResourcesLayer = Layer.effect(
  ExecutionResources,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const runs = new Map<string, Map<string, Semaphore.Semaphore>>();
    const active = new Map<string, number>();
    const work = new Map<string, number>();
    const interrupts = new Map<string, Set<string>>();
    return {
      active: (runId) => active.get(runId) ?? 0,
      global: Semaphore.makeUnsafe(32),
      interrupt: (runId, id, request) =>
        Effect.suspend(() => {
          let interrupting = interrupts.get(runId);
          if (!interrupting) {
            interrupting = new Set();
            interrupts.set(runId, interrupting);
          }
          if (interrupting.has(id)) {
            return Effect.void;
          }
          interrupting.add(id);
          return request.pipe(
            Effect.catchCause(() =>
              Effect.sync(() => {
                interrupts.get(runId)?.delete(id);
              }).pipe(
                Effect.andThen(
                  Effect.logWarning("Execution interruption will retry")
                )
              )
            ),
            Effect.forkIn(scope),
            Effect.asVoid
          );
        }),
      permits: (runId, path, concurrency) => {
        let scopes = runs.get(runId);
        if (!scopes) {
          scopes = new Map();
          runs.set(runId, scopes);
        }
        let semaphore = scopes.get(path);
        if (!semaphore) {
          semaphore = Semaphore.makeUnsafe(concurrency);
          scopes.set(path, semaphore);
        }
        return semaphore;
      },
      release: (runId) => {
        runs.delete(runId);
        interrupts.delete(runId);
      },
      reports: Semaphore.makeUnsafe(4),
      track: (runId, body) => track(active, runId, body),
      trackWork: (runId, body) => track(work, runId, body),
      working: (runId) => work.get(runId) ?? 0,
    };
  })
);
