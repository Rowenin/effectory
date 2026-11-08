import { Database } from "bun:sqlite";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Exit, Layer, Option, Schedule, Schema } from "effect";
import { Activity, DurableDeferred, Workflow } from "effect/workflow";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";

import { engineLayer } from "../../src/engine.ts";
import { HostStore, hostStoreLayer } from "../../src/host-store.ts";
import { ownershipLayer } from "../../src/ownership.ts";
import { writeReady } from "./ready.ts";

const [filename, mode, readyFile] = process.argv.slice(2);
if (filename === undefined || mode === undefined || readyFile === undefined) {
  throw new Error("Expected database, mode and ready-file arguments");
}

const audit = new Database(`${filename}.audit`);
audit.run(
  "CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, count INTEGER NOT NULL)"
);
const approval = DurableDeferred.make("approval", { success: Schema.String });
const workflow = Workflow.make("EffectoryEngineProof", {
  error: OperationError,
  idempotencyKey: ({ runId }) => runId,
  payload: { runId: Schema.String },
  success: Schema.String,
});
const handler = workflow.toLayer(({ runId }) =>
  Effect.gen(function* () {
    const store = yield* HostStore;
    if (mode.startsWith("manual")) {
      return yield* Activity.make({
        error: OperationError,
        execute: Effect.gen(function* () {
          const admitted = yield* store.admitAttempt(
            runId,
            "manual",
            1,
            "manual"
          );
          if (admitted !== "Admitted") {
            return yield* Workflow.suspend(yield* WorkflowInstance);
          }
          audit
            .query(
              "INSERT INTO effects VALUES ('manual', 1) ON CONFLICT(id) DO UPDATE SET count = count + 1"
            )
            .run();
          yield* Effect.promise(
            async () =>
              await writeReady(
                readyFile,
                JSON.stringify({
                  duplicate: "in-flight",
                  id: "in-flight",
                  status: "InFlight",
                })
              )
          );
          return yield* Effect.never;
        }),
        interruptRetryPolicy: Schedule.recurs(0),
        name: "manual",
        success: Schema.String,
      });
    }
    const value = yield* Activity.make({
      execute: Effect.sync(() => {
        audit
          .query(
            "INSERT INTO effects VALUES ('first', 1) ON CONFLICT(id) DO UPDATE SET count = count + 1"
          )
          .run();
        return "recorded";
      }),
      interruptRetryPolicy: Schedule.recurs(0),
      name: "first",
      success: Schema.String,
    });
    yield* Activity.make({
      error: OperationError,
      execute: store
        .openWait({
          context: null,
          deadline: Date.now() + 60_000,
          kind: "approval",
          nodeId: "approval",
          runId,
        })
        .pipe(Effect.map((wait) => wait.waitId)),
      interruptRetryPolicy: Schedule.recurs(0),
      name: "register-approval",
      success: Schema.String,
    });
    const waitId = yield* DurableDeferred.await(approval);
    const settled = yield* store.getWait(waitId);
    return `${value}:${settled.status.toLowerCase()}`;
  })
);

function deliverDecisions(store: typeof HostStore.Service, id: string) {
  return Effect.gen(function* () {
    for (const intent of yield* store.outbox()) {
      if (intent.kind === "Settle" && intent.waitId !== null) {
        yield* DurableDeferred.succeed(approval, {
          token: DurableDeferred.tokenFromExecutionId(approval, {
            executionId: id,
            workflow,
          }),
          value: intent.waitId,
        });
        yield* store.acknowledge(intent.id);
      }
    }
  });
}

const program = Effect.gen(function* () {
  const store = yield* HostStore;
  const run = yield* store.submit(
    { input: {}, kind: "workflow", requestKey: "same-run", targetId: "proof" },
    "proof-revision",
    "owner"
  );
  if (mode === "accept-only") {
    yield* Effect.promise(
      async () =>
        await writeReady(
          readyFile,
          JSON.stringify({
            duplicate: run.runId,
            id: run.runId,
            status: "Queued",
          })
        )
    );
    return yield* Effect.never;
  }
  const id = yield* workflow.execute({ runId: run.runId }, { discard: true });
  const duplicate = yield* workflow.execute(
    { runId: run.runId },
    { discard: true }
  );
  yield* store.setEngineId(run.runId, id);
  for (const intent of yield* store.outbox()) {
    if (intent.kind === "Dispatch") {
      yield* store.acknowledge(intent.id);
    }
  }
  if (mode === "finish" || mode === "record-answer") {
    const waits = yield* store.listWaits(run.runId);
    const [wait] = waits;
    if (!wait) {
      return yield* Effect.die("Missing approval registration");
    }
    yield* store.settle(
      { operation: "approve", requestKey: "decision-1", waitId: wait.waitId },
      "owner",
      (value) => value
    );
    if (mode === "record-answer") {
      yield* Effect.promise(
        async () =>
          await writeReady(
            readyFile,
            JSON.stringify({ duplicate, id, status: "Recorded" })
          )
      );
      return yield* Effect.never;
    }
    yield* deliverDecisions(store, id);
  }
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (
      mode === "manual-drain" &&
      (yield* Effect.promise(async () => await Bun.file(readyFile).exists()))
    ) {
      return;
    }
    const result = yield* workflow.poll(id);
    if (Option.isSome(result)) {
      const state = result.value;
      if (mode === "manual-recover" && state._tag === "Suspended") {
        const current = yield* store.getRun(run.runId);
        yield* Effect.promise(
          async () =>
            await writeReady(
              readyFile,
              JSON.stringify({ duplicate, id, status: current.status })
            )
        );
        return;
      }
      if (mode === "start" && state._tag === "Suspended") {
        yield* store.project(run.runId, "Waiting");
        yield* Effect.promise(
          async () =>
            await writeReady(
              readyFile,
              JSON.stringify({ duplicate, id, status: "Suspended" })
            )
        );
        return yield* Effect.never;
      }
      if (mode === "finish" && state._tag === "Complete") {
        if (Exit.isFailure(state.exit)) {
          return yield* Effect.failCause(state.exit.cause);
        }
        const resultValue = state.exit.value;
        yield* store.project(run.runId, "Succeeded", resultValue);
        yield* Effect.promise(
          async () =>
            await writeReady(
              readyFile,
              JSON.stringify({ duplicate, id, result: resultValue })
            )
        );
        return;
      }
    }
    yield* Effect.sleep("20 millis");
  }
  return yield* Effect.die("Timed out waiting for persistent workflow proof");
}).pipe(
  Effect.provide(
    handler.pipe(
      Layer.provideMerge(engineLayer(filename)),
      Layer.provideMerge(hostStoreLayer(filename)),
      Layer.provide(ownershipLayer(`${filename}.owner`))
    )
  )
);

try {
  await Effect.runPromise(program);
} finally {
  audit.close();
}
