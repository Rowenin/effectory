/* oxlint-disable typescript/no-invalid-void-type, promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Effects return release callbacks; catch composes an Effect, not a Promise. */
import { Deferred, Effect } from "effect";

import { readFailure } from "./artifact-read-errors.ts";
import type { ArtifactReadError } from "./artifact-read-errors.ts";
import { TaskRuntimeError } from "./errors.ts";

function once(body: () => void) {
  let called = false;
  return () => {
    if (!called) {
      called = true;
      body();
    }
  };
}

/** A synchronous direct handoff queue: newcomers never bypass queued owners. */
export function binaryPool(capacity = 4) {
  let available = capacity;
  const queue: { grant: (release: () => void) => void; cancelled: boolean }[] =
    [];
  const release = () => {
    let next = queue.shift();
    while (next?.cancelled === true) {
      next = queue.shift();
    }
    if (next) {
      next.grant(once(release));
    } else {
      available += 1;
    }
  };
  return {
    request(grant: (release: () => void) => void) {
      const ticket = { cancelled: false, grant };
      if (available > 0) {
        available -= 1;
        grant(once(release));
      } else {
        queue.push(ticket);
      }
      return () => {
        ticket.cancelled = true;
        const index = queue.indexOf(ticket);
        if (index !== -1) {
          queue.splice(index, 1);
        }
      };
    },
  };
}
export type BinaryPool = ReturnType<typeof binaryPool>;

/** Shared by all binary reads and publications of one invocation. */
export function binaryOwner(pool: BinaryPool) {
  let closed = false;
  let references = 0;
  let releaseGroup: (() => void) | undefined;
  let cancelGroup: (() => void) | undefined;
  let pendingGroup: Deferred.Deferred<void, ArtifactReadError> | undefined;
  interface Position {
    open: boolean;
    finite: boolean;
  }
  const positions = new Set<Position>();
  const local: {
    deferred: Deferred.Deferred<void, ArtifactReadError>;
    position: Position;
  }[] = [];

  const updateLocal = () => {
    if (closed) {
      for (const waiter of local.splice(0)) {
        Deferred.doneUnsafe(
          waiter.deferred,
          Effect.fail(readFailure("Closed"))
        );
      }
    } else if (
      positions.size === 4 &&
      [...positions].every((p) => p.open && !p.finite)
    ) {
      for (const waiter of local.splice(0)) {
        Deferred.doneUnsafe(
          waiter.deferred,
          Effect.fail(readFailure("ConcurrencyLimit"))
        );
      }
    } else {
      while (positions.size < 4 && local.length > 0) {
        const waiter = local.shift();
        if (!waiter) {
          break;
        }
        positions.add(waiter.position);
        Deferred.doneUnsafe(waiter.deferred, Effect.void);
      }
    }
  };
  const releaseReference = () => {
    references -= 1;
    if (references === 0) {
      cancelGroup?.();
      cancelGroup = undefined;
      releaseGroup?.();
      releaseGroup = undefined;
      pendingGroup = undefined;
    }
  };
  const group = Effect.suspend(() => {
    if (closed) {
      return Effect.fail(readFailure("Closed"));
    }
    references += 1;
    if (!releaseGroup && !pendingGroup) {
      pendingGroup = Deferred.makeUnsafe<void, ArtifactReadError>();
      const waiting = pendingGroup;
      cancelGroup = pool.request((release) => {
        releaseGroup = release;
        Deferred.doneUnsafe(waiting, Effect.void);
      });
    }
    const waiting = pendingGroup;
    return (
      releaseGroup || !waiting ? Effect.void : Deferred.await(waiting)
    ).pipe(
      Effect.as(once(releaseReference)),
      Effect.onInterrupt(() => Effect.sync(releaseReference)),
      Effect.tapError(() => Effect.sync(releaseReference))
    );
  });
  const read = (
    finite: boolean
  ): Effect.Effect<
    { open: () => void; release: () => void },
    ArtifactReadError
  > =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (closed) {
          return yield* readFailure("Closed");
        }
        const position = { finite, open: false };
        const waiter = {
          deferred: Deferred.makeUnsafe<void, ArtifactReadError>(),
          position,
        };
        const remove = once(() => {
          const index = local.indexOf(waiter);
          if (index !== -1) {
            local.splice(index, 1);
          }
          positions.delete(position);
          updateLocal();
        });
        local.push(waiter);
        updateLocal();
        yield* restore(Deferred.await(waiter.deferred)).pipe(
          Effect.onExit((exit) =>
            exit._tag === "Failure" ? Effect.sync(remove) : Effect.void
          )
        );
        const release = yield* restore(group).pipe(
          Effect.onExit((exit) =>
            exit._tag === "Failure" ? Effect.sync(remove) : Effect.void
          )
        );
        return {
          open: () => {
            position.open = true;
            updateLocal();
          },
          release: once(() => {
            remove();
            release();
          }),
        };
      })
    );
  return {
    close: Effect.sync(() => {
      closed = true;
      updateLocal();
      if (pendingGroup && !releaseGroup) {
        cancelGroup?.();
        Deferred.doneUnsafe(pendingGroup, Effect.fail(readFailure("Closed")));
      }
      // Held references are returned by owned operations only after cleanup.
    }),
    publish: <A, E, R>(body: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const release = yield* restore(group).pipe(
            Effect.mapError(
              () =>
                new TaskRuntimeError({
                  code: "InvalidBoundary",
                  message: "Invocation closed",
                })
            )
          );
          return yield* restore(body).pipe(
            Effect.ensuring(Effect.sync(release))
          );
        })
      ),
    read,
  };
}
export type BinaryOwner = ReturnType<typeof binaryOwner>;
