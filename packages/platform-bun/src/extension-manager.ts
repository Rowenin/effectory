import { Database } from "bun:sqlite";
import path from "node:path";

import type {
  OperationListRequest,
  OperationPage,
  ExtensionChange,
  ExtensionLock,
  ExtensionOperation,
} from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Cause, Context, Effect, Layer, Option } from "effect";

import { Catalog } from "./catalog.ts";
import {
  assertTrusted,
  assertWritableBindings,
  trustLock,
} from "./extension-bindings.ts";
import { restoreCache } from "./extension-cache.ts";
import { createExtensionJournal } from "./extension-journal.ts";
import { resolveExtensionChange } from "./extension-resolver.ts";
import { ExtensionSource } from "./extension-source.ts";
import { HostStore } from "./host-store.ts";
import { RepositoryLease } from "./ownership.ts";
import { Runner } from "./runner.ts";
import { assertRuntimeWriter } from "./runtime-writer-guard.ts";

const failure = (cause: unknown) =>
  cause instanceof OperationError
    ? cause
    : new OperationError({
        code: "Unavailable",
        message:
          "Extension operation failed; check repository storage and permissions",
      });
const perform = <A>(body: () => A) => Effect.try({ catch: failure, try: body });
function openJournal(repository: string) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    yield* perform(() => {
      lease.assertActive();
      assertRuntimeWriter(repository);
    });
    const database = yield* Effect.acquireRelease(
      perform(
        () => new Database(path.join(repository, ".effectory/state.sqlite"))
      ),
      (db) => Effect.sync(() => db.close())
    );
    return yield* perform(() =>
      createExtensionJournal(database, repository, lease)
    );
  });
}
/** Reconcile filesystem/database publication before loading any application. */
export const recoverExtensionOperations = (repository: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const journal = yield* openJournal(repository);
      yield* perform(journal.recover);
    })
  );

export class ExtensionManager extends Context.Service<
  ExtensionManager,
  {
    readonly accept: (
      request: typeof ExtensionChange.Type,
      actor: string
    ) => Effect.Effect<typeof ExtensionOperation.Type, OperationError>;
    readonly get: (
      id: string,
      actor: string
    ) => Effect.Effect<typeof ExtensionOperation.Type, OperationError>;
    readonly operations: (
      request: typeof OperationListRequest.Type,
      actor: string
    ) => Effect.Effect<typeof OperationPage.Type, OperationError>;
    readonly installed: Effect.Effect<
      {
        readonly lock: typeof ExtensionLock.Type;
        readonly revision: string;
        readonly applicationRevision: string;
      },
      OperationError
    >;
    readonly stopAccepting: Effect.Effect<void>;
  }
>()("effectory/ExtensionManager") {}

export const extensionManagerLayer = (
  repository: string,
  fatal: Effect.Effect<void>
) =>
  Layer.effect(
    ExtensionManager,
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      const source = yield* ExtensionSource;
      const lease = yield* RepositoryLease;
      const runner = yield* Runner;
      const store = yield* HostStore;
      const journal = yield* openJournal(repository);
      let accepting = true;
      const execute = (
        operation: NonNullable<ReturnType<typeof journal.next>>
      ) =>
        Effect.gen(function* () {
          const { snapshot, request } = operation;
          const id = snapshot.operationId;
          const { actor } = snapshot;
          yield* perform(() => {
            if (
              snapshot.baseApplicationRevision !== catalog.active ||
              snapshot.expectedRevision !== journal.registry().revision
            ) {
              throw new OperationError({
                code: "Conflict",
                message:
                  "Installed or active application revision changed before the operation could run",
              });
            }
            journal.start(id, actor);
          });
          const current = yield* perform(journal.registry);
          const lock =
            operation.candidate ??
            (yield* resolveExtensionChange(
              repository,
              current.lock,
              request,
              operation.resolutions,
              (resolutions) =>
                perform(() => journal.checkpoint(id, actor, resolutions))
            ).pipe(
              Effect.provideService(ExtensionSource, source),
              Effect.provideService(RepositoryLease, lease)
            ));
          yield* perform(() => journal.candidate(id, actor, lock));
          yield* restoreCache(repository, lock, {
            trust: request.kind !== "Remove" && request.trust,
          }).pipe(
            Effect.provideService(ExtensionSource, source),
            Effect.provideService(RepositoryLease, lease)
          );
          yield* perform(() => {
            lease.assertActive();
            assertWritableBindings(repository);
            if (request.kind !== "Remove" && request.trust) {
              trustLock(repository, lock);
            }
            assertTrusted(repository, lock);
          });
          const candidate = yield* catalog.prepare(lock);
          if (candidate.baseRevision !== snapshot.baseApplicationRevision) {
            return yield* new OperationError({
              code: "Conflict",
              message:
                "Active application changed while the extension candidate was prepared",
            });
          }
          yield* catalog.activate(candidate, () => {
            journal.begin(id, actor, candidate.revision);
            journal.publish();
          });
          yield* perform(journal.finish);
        }).pipe(Effect.scoped);
      const processNext = Effect.gen(function* () {
        const operation = yield* perform(journal.next);
        if (operation === null) {
          return;
        }
        yield* execute(operation).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) {
              return Effect.failCause(cause);
            }
            const error = Cause.findErrorOption(cause);
            return perform(() =>
              journal.fail(
                operation.snapshot.operationId,
                operation.snapshot.actor,
                Option.isSome(error) ? error.value : failure(null)
              )
            );
          })
        );
      });
      yield* Effect.gen(function* () {
        while (true) {
          const result = yield* Effect.result(processNext);
          if (result._tag === "Failure") {
            // A publication intent may be partially visible. Stop admission and force a
            // startup reconciliation instead of serving mismatched registry pointers.
            accepting = false;
            yield* runner.stopAccepting;
            yield* fatal;
            return;
          }
          yield* Effect.sleep("25 millis");
        }
      }).pipe(Effect.forkScoped);
      return {
        accept: (request, actor) =>
          perform(() =>
            journal.accept(request, actor, catalog.active, accepting)
          ),
        get: (id, actor) => perform(() => journal.get(id, actor)),
        installed: perform(() => ({
          ...journal.registry(),
          applicationRevision: catalog.active,
        })),
        operations: (request, actor) =>
          perform(() => journal.page(request, actor, store.pagination)),
        stopAccepting: Effect.sync(() => {
          accepting = false;
        }),
      };
    })
  );
