import { Context, Deferred, Effect, Fiber, Layer, Option, Scope } from "effect";

import { TaskRuntimeError } from "./errors.ts";

interface OwnedOperation {
  readonly owner: object;
  active: boolean;
}

const Operations = Context.Reference<readonly OwnedOperation[]>(
  "@offtree/effectory-sdk/internal/InvocationOperations",
  { defaultValue: () => [] }
);

/** Private per-execution owner; never shared between attempts or revisions. */
export function publicationLifetime(
  closeReads: Effect.Effect<void> = Effect.void
) {
  const owner = {};
  const nested = (operations: readonly OwnedOperation[]) =>
    operations.some(
      (operation) => operation.owner === owner && operation.active
    );
  let closed = false;
  let acquiring = true;
  const children = new Set<Fiber.Fiber<unknown, unknown>>();
  const acquisitionScopes = new WeakSet<Scope.Scope>();
  const finished = Deferred.makeUnsafe<boolean>();
  const close = Effect.uninterruptible(
    Effect.suspend(() => {
      if (closed) {
        return Effect.asVoid(Deferred.await(finished));
      }
      closed = true;
      return closeReads.pipe(
        Effect.andThen(Fiber.interruptAll([...children])),
        Effect.ensuring(Deferred.succeed(finished, true))
      );
    })
  );

  const base = Layer.makeMemoMapUnsafe();
  // Inherit Effect's private brand; decorate only its public MemoMap methods.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- inherits Effect's unexported MemoMap brand
  const memoMap = Object.create(base) as Layer.MemoMap;
  const methods: Pick<Layer.MemoMap, "get" | "getOrElseMemoize"> = {
    get: (layer, scope) => base.get(layer, scope),
    getOrElseMemoize: (layer, scope, build) =>
      base.getOrElseMemoize(layer, scope, (_, resourceScope) =>
        Effect.gen(function* () {
          // Resources opened by a supervised operation belong to that operation.
          // Their release must not close the invocation and await their own fiber.
          const setup = acquiring && !nested(yield* Operations);
          return yield* build(memoMap, resourceScope).pipe(
            Effect.onExit((exit) => {
              if (!setup) {
                return Effect.void;
              }
              // Close before a failed leaf acquisition unwinds its resources,
              // including leaves inside a composite or parallel Layer.
              return exit._tag === "Failure"
                ? close
                : Scope.addFinalizer(resourceScope, close);
            })
          );
        })
      ),
  };
  Object.assign(memoMap, methods);

  return {
    beginHandler: () => {
      acquiring = false;
    },
    close,
    memoMap,
    run: <A, E, R>(body: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const scope = yield* Effect.serviceOption(Scope.Scope);
          const operations = yield* Operations;
          if (
            closed ||
            (Option.isSome(scope) && scope.value.state._tag === "Closed")
          ) {
            return yield* new TaskRuntimeError({
              code: "InvalidBoundary",
              message: "Invocation closed",
            });
          }
          // Register before forking, also covering a Layer that publishes and
          // then fails during its own acquisition (before Layer.tap can run).
          if (
            acquiring &&
            !nested(operations) &&
            Option.isSome(scope) &&
            !acquisitionScopes.has(scope.value)
          ) {
            acquisitionScopes.add(scope.value);
            yield* Scope.addFinalizer(scope.value, close);
          }
          const operation: OwnedOperation = { active: true, owner };
          const child = yield* Effect.forkDetach(
            restore(body).pipe(
              Effect.provideService(Operations, [
                ...operations.filter((ancestor) => ancestor.active),
                operation,
              ])
            )
          );
          children.add(child);
          child.addObserver(() => {
            // A captured Context must not make later work look like a descendant
            // of an operation that has already finished.
            operation.active = false;
            children.delete(child);
          });
          return yield* restore(Fiber.join(child)).pipe(
            Effect.onInterrupt(() => Fiber.interrupt(child))
          );
        })
      ),
  };
}
