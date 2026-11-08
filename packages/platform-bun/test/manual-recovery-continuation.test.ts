import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Layer, Option, Schedule, Schema } from "effect";
import { Activity, DurableClock, Workflow } from "effect/workflow";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";

import { engineLayer } from "../src/engine.ts";
import { ExecutionFailure } from "../src/execution-boundary.ts";
import { HostStore, hostStoreLayer } from "../src/host-store.ts";
import { leafExecution } from "../src/interpreter.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { recoveryContinuation } from "../src/recovery-continuation.ts";

const until = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  done: (value: A) => boolean
) =>
  Effect.gen(function* () {
    for (let i = 0; i < 300; i += 1) {
      const value = yield* read;
      if (done(value)) {
        return value;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die("Recovery obligation condition timed out");
  });

// Delaying the rejection-to-Suspended seam makes the real native race reproducible.
const handler = leafExecution.toLayer((payload) =>
  Effect.gen(function* () {
    if (payload.nodeId === "backoff") {
      yield* Activity.make({
        execute: Effect.succeed(1),
        name: "completed-handler",
        success: Schema.Int,
      });
      yield* DurableClock.sleep({
        duration: "30 seconds",
        inMemoryThreshold: 0,
        name: "backoff",
      });
      return 1;
    }
    return yield* Activity.make({
      error: ExecutionFailure,
      execute: Effect.gen(function* () {
        const store = yield* HostStore;
        const admission = yield* store
          .admitAttempt(payload.runId, payload.nodeId, 1, "manual")
          .pipe(Effect.orDie);
        if (admission === "NeedsAttention") {
          if (payload.nodeId === "gated") {
            yield* Effect.sleep("300 millis");
          }
          return yield* Workflow.suspend(yield* WorkflowInstance);
        }
        return admission;
      }),
      interruptRetryPolicy: Schedule.recurs(0),
      name: "handler/1",
      success: Schema.Json,
    });
  })
);

test("durable continuation handles late suspension and re-gating without waiting for unrelated backoff", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-recovery-obligations-")
  );
  const filename = path.join(directory, "state.sqlite");
  const runtime = handler.pipe(
    Layer.provideMerge(engineLayer(filename)),
    Layer.provideMerge(hostStoreLayer(filename)),
    Layer.provide(ownershipLayer(`${filename}.owner`))
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* HostStore;
          const deliver = yield* recoveryContinuation;
          const run = yield* store.submit(
            {
              input: null,
              kind: "workflow",
              requestKey: "run",
              targetId: "test",
            },
            "pinned",
            "owner"
          );
          const launch = (nodeId: string) =>
            Effect.gen(function* () {
              const payload = {
                attemptTimeout: null,
                deadline: null,
                input: null,
                nodeId,
                permits: [],
                retry: null,
                runId: run.runId,
                taskId: nodeId,
              };
              const id = yield* leafExecution.executionId(payload);
              yield* store.registerInvocation(run.runId, nodeId, id, payload);
              yield* leafExecution.execute(payload, { discard: true });
              return id;
            });
          yield* store.admitAttempt(run.runId, "a", 1, "manual");
          yield* store.admitAttempt(run.runId, "late", 1, "manual");
          const a = yield* launch("a");
          yield* until(
            store.recoveryGet({ runId: run.runId }, "owner"),
            (value) => value.state === "Recoverable"
          );
          const gated = yield* launch("gated");
          const backoff = yield* launch("backoff");
          yield* until(
            store.recoveryGet({ runId: run.runId }, "owner"),
            (value) => value.total === 1
          );
          // Wait for the durable gate but not for the delayed native Suspended reply.
          yield* Effect.sleep("100 millis");
          const assessment = yield* store.recoveryGet(
            { runId: run.runId },
            "owner"
          );
          if (assessment.token === null) {
            return yield* Effect.die("Missing recovery token");
          }
          yield* store.recover(
            {
              acknowledgeReexecution: true,
              requestKey: "first",
              runId: run.runId,
              token: assessment.token,
            },
            "owner"
          );
          const late = yield* launch("late");
          yield* until(
            store.recoveryGet({ runId: run.runId }, "owner"),
            (value) => value.total === 1 && value.entries[0]?.taskId === "late"
          );
          yield* deliver;
          expect(
            (yield* store.recoveryGet({ runId: run.runId }, "owner"))
              .latestAuthorization?.continuationPending
          ).toBe(true);
          const next = yield* until(
            deliver.pipe(
              Effect.andThen(store.recoveryGet({ runId: run.runId }, "owner"))
            ),
            (value) => value.state === "Recoverable"
          );
          expect(next.latestAuthorization?.continuationPending).toBe(false);
          expect(next.total).toBe(1);
          const parked = yield* leafExecution.poll(backoff);
          expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended");
          if (next.token === null) {
            return yield* Effect.die("Missing next recovery token");
          }
          yield* store.recover(
            {
              acknowledgeReexecution: true,
              requestKey: "second",
              runId: run.runId,
              token: next.token,
            },
            "owner"
          );
          yield* until(
            deliver.pipe(
              Effect.andThen(store.recoveryGet({ runId: run.runId }, "owner"))
            ),
            (value) => value.latestAuthorization?.continuationPending === false
          );
          for (const id of [a, gated, late]) {
            const result = yield* until(
              leafExecution.poll(id),
              (value) => Option.isSome(value) && value.value._tag === "Complete"
            );
            expect(Option.isSome(result) && result.value._tag).toBe("Complete");
          }
        }).pipe(Effect.provide(runtime))
      )
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 15_000);
