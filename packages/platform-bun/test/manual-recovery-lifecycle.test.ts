import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Application, Task } from "@offtree/effectory-sdk";
import { Context, Deferred, Effect, Layer, Schema } from "effect";

import { catalogLayer } from "../src/catalog.ts";
import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { Runner, tick } from "../src/runner.ts";

const Resource = Context.Service<number>("recovery-test/Finalizer");
test("real task Layer finalization keeps its recovery reservation until cleanup finishes", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-recovery-finalizer-")
  );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const releasing = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        const task = Task.make(
          {
            error: Schema.Never,
            id: "task",
            input: Schema.Null,
            replay: "manual",
            success: Schema.Int,
            version: 1,
          },
          () => Resource
        ).provide(
          Layer.effect(
            Resource,
            Effect.acquireRelease(Effect.succeed(42), () =>
              Deferred.succeed(releasing, true).pipe(
                Effect.andThen(Deferred.await(release))
              )
            )
          )
        );
        const app = Application.make({ tasks: [task] });
        const catalog = Layer.unwrap(
          Effect.map(Application.Registry, (registry) =>
            catalogLayer("pinned", new Map([["pinned", registry]]))
          )
        ).pipe(Layer.provide(app.layer));
        yield* Effect.gen(function* () {
          const runner = yield* Runner;
          const store = yield* HostStore;
          const run = yield* runner.submit(
            { input: null, kind: "task", requestKey: "run", targetId: "task" },
            "owner"
          );
          yield* Deferred.await(releasing);
          const page = yield* store.reportInvocationScan(run.runId, "owner", {
            limit: 10,
          });
          const [invocation] = page.rows;
          if (!invocation) {
            return yield* Effect.die("Missing invocation");
          }
          const details = yield* store.reportInvocationDetails(
            run.runId,
            invocation.engineId
          );
          expect(
            yield* store.admitAttempt(run.runId, details.nodeId, 1, "manual")
          ).toBe("NeedsAttention");
          expect(
            (yield* store.recoveryGet({ runId: run.runId }, "owner")).state
          ).toBe("ExecutionActive");
          yield* tick;
          expect((yield* store.getRun(run.runId)).status).toBe(
            "NeedsAttention"
          );
          yield* Deferred.succeed(release, true);
          for (let i = 0; i < 300; i += 1) {
            const current = yield* store.getRun(run.runId);
            if (current.status === "Succeeded") {
              expect(current.result).toBe(42);
              expect(
                (yield* store.recoveryGet({ runId: run.runId }, "owner")).token
              ).toBeNull();
              return;
            }
            yield* Effect.sleep("10 millis");
          }
          return yield* Effect.die("Finalization did not complete");
        }).pipe(
          Effect.ensuring(Deferred.succeed(release, true)),
          Effect.provide(
            hostLayer({
              blobs: path.join(directory, "blobs"),
              catalog,
              database: path.join(directory, "state.sqlite"),
            })
          )
        );
      })
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 10_000);
