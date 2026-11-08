import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { terminal } from "@effectory/runtime/protocol";
import { Application, Task } from "@offtree/effectory-sdk";
import { Context, Deferred, Effect, Fiber, Layer, Schema } from "effect";

import { catalogLayer } from "../src/catalog.ts";
import { ExecutionResources } from "../src/execution-resources.ts";
import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { Runner } from "../src/runner.ts";

test.each(["cancel", "shutdown"] as const)(
  "%s retains task capacity and repository ownership until Layer cleanup finishes",
  async (mode) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "effectory-stop-owner-")
    );
    const database = path.join(directory, "state.sqlite");
    const started = Deferred.makeUnsafe<boolean>();
    const releasing = Deferred.makeUnsafe<boolean>();
    const release = Deferred.makeUnsafe<boolean>();
    const stop = Deferred.makeUnsafe<boolean>();
    const ready = Deferred.makeUnsafe<{
      readonly runId: string;
      readonly resources: typeof ExecutionResources.Service;
      readonly store: typeof HostStore.Service;
    }>();
    const events: string[] = [];
    const Resource = Context.Service<number>(`test/StopOwnership/${mode}`);
    const task = Task.make(
      {
        error: Schema.Never,
        id: "held",
        input: Schema.Null,
        replay: "manual",
        success: Schema.Never,
        version: 1,
      },
      () =>
        Effect.gen(function* () {
          yield* Resource;
          events.push("handler");
          yield* Deferred.succeed(started, true);
          return yield* Effect.never;
        })
    ).provide(
      Layer.effect(
        Resource,
        Effect.acquireRelease(
          Effect.sync(() => {
            events.push("acquire");
            return 42;
          }),
          () =>
            Effect.gen(function* () {
              events.push("releasing");
              yield* Deferred.succeed(releasing, true);
              yield* Deferred.await(release);
              events.push("released");
            })
        )
      )
    );
    const app = Application.make({ tasks: [task] });
    const catalog = Layer.unwrap(
      Effect.map(Application.Registry, (registry) =>
        catalogLayer("pinned", new Map([["pinned", registry]]))
      )
    ).pipe(Layer.provide(app.layer));
    const host = Effect.runFork(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const resources = yield* ExecutionResources;
        const runner = yield* Runner;
        const run = yield* runner.submit(
          { input: null, kind: "task", requestKey: "run", targetId: task.id },
          "owner"
        );
        yield* Deferred.await(started);
        yield* Deferred.succeed(ready, { resources, runId: run.runId, store });
        yield* Deferred.await(stop);
      }).pipe(
        Effect.provide(
          hostLayer({ blobs: path.join(directory, "blobs"), catalog, database })
        )
      )
    );
    try {
      const { resources, runId, store } = await Effect.runPromise(
        Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
      );
      await Effect.runPromise(
        mode === "cancel"
          ? store.cancel(runId).pipe(Effect.asVoid)
          : Deferred.succeed(stop, true).pipe(Effect.asVoid)
      );
      await Effect.runPromise(
        Deferred.await(releasing).pipe(Effect.timeout("5 seconds"))
      );
      expect(events).toEqual(["acquire", "handler", "releasing"]);
      expect(resources.active(runId)).toBe(1);
      expect(resources.working(runId)).toBe(1);
      const occupied = await Effect.runPromise(
        resources.global.withPermitsIfAvailable(32)(Effect.void)
      );
      expect(occupied._tag).toBe("None");
      expect(host.pollUnsafe()).toBeUndefined();
      const competing = await Effect.runPromiseExit(
        Effect.scoped(Layer.build(ownershipLayer(`${database}.owner`)))
      );
      expect(competing._tag).toBe("Failure");
      if (mode === "cancel") {
        const current = await Effect.runPromise(store.getRun(runId));
        expect(terminal.has(current.status)).toBe(false);
        expect(current.status).toBe("Cancelling");
      }
      await Effect.runPromise(Deferred.succeed(release, true));
      if (mode === "cancel") {
        await Effect.runPromise(
          Effect.gen(function* () {
            for (let index = 0; index < 300; index += 1) {
              const current = yield* store.getRun(runId);
              if (terminal.has(current.status)) {
                expect(current.status).toBe("Cancelled");
                return;
              }
              yield* Effect.sleep("10 millis");
            }
            return yield* Effect.die("Cancelled task did not finish");
          })
        );
        await Effect.runPromise(Deferred.succeed(stop, true));
      }
      await Effect.runPromise(
        Fiber.join(host).pipe(Effect.timeout("5 seconds"))
      );
      expect(events).toEqual(["acquire", "handler", "releasing", "released"]);
      expect(resources.active(runId)).toBe(0);
      expect(resources.working(runId)).toBe(0);
      const available = await Effect.runPromise(
        resources.global.withPermitsIfAvailable(32)(Effect.void)
      );
      expect(available._tag).toBe("Some");
      await Effect.runPromise(
        Effect.scoped(Layer.build(ownershipLayer(`${database}.owner`)))
      );
    } finally {
      await Effect.runPromise(Deferred.succeed(release, true));
      await Effect.runPromise(Deferred.succeed(stop, true));
      await Effect.runPromise(Fiber.interrupt(host));
      await rm(directory, { force: true, recursive: true });
    }
  },
  20_000
);
