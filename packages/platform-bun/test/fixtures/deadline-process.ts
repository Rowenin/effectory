import { Database } from "bun:sqlite";
import path from "node:path";

import { Application, Task, Workflow } from "@effectory/core";
import { Effect, Layer, Schema } from "effect";

import { catalogLayer } from "../../src/catalog.ts";
import { HostStore } from "../../src/host-store.ts";
import { hostLayer } from "../../src/host.ts";
import { Runner } from "../../src/runner.ts";
import { writeReady } from "./ready.ts";

const [directory, mode, readyFile] = process.argv.slice(2);
if (!(directory && mode && readyFile)) {
  throw new Error("Missing fixture arguments");
}
const [variant, phase] = mode.split("-");
const audit = new Database(path.join(directory, "audit.sqlite"));
audit.exec(
  "CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY AUTOINCREMENT)"
);
const task = Task.make(
  {
    error: Schema.Never,
    id: "work",
    input: Schema.Null,
    replay: "idempotent",
    success: Schema.String,
    version: 1,
  },
  () =>
    Effect.gen(function* () {
      audit.query("INSERT INTO calls DEFAULT VALUES").run();
      if (variant === "attempt") {
        return yield* Effect.never;
      }
      return "done";
    })
);
const flow = Workflow.make(
  {
    error: Schema.Never,
    id: "deadline-flow",
    input: Schema.Null,
    success: Schema.String,
    version: 1,
    ...(variant === "workflow" ? { execution: { timeout: "2 seconds" } } : {}),
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    if (variant === "workflow") {
      const approval = yield* graph.approval("review", {
        prompt: "Continue",
        timeout: "1 minute",
      });
      return yield* graph.task("work", task, null, { after: [approval] });
    }
    const value = yield* graph.task(
      "work",
      task,
      null,
      variant === "attempt"
        ? { attemptTimeout: "2 seconds" }
        : { timeout: "2 seconds" }
    );
    if (variant === "completed") {
      yield* graph.approval("review", {
        after: [value],
        prompt: "Continue",
        timeout: "1 minute",
      });
    }
    return value;
  })
);
const app = Application.make({ tasks: [task], workflows: [flow] });
const catalog = Layer.unwrap(
  Effect.map(Application.Registry, (registry) =>
    catalogLayer("fixture", new Map([["fixture", registry]]))
  )
).pipe(Layer.provide(app.layer));
try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "deadline",
          targetId: flow.id,
        },
        "owner"
      );
      for (let index = 0; index < 800; index += 1) {
        const current = yield* store.getRun(run.runId);
        const waits = yield* store.listWaits(run.runId);
        const events = yield* store.events(run.runId);
        const started = events.find(
          (event) =>
            event.tag ===
            (variant === "attempt" ? "AttemptStarted" : "DeadlineStarted")
        );
        const running =
          variant === "attempt"
            ? audit.query("SELECT id FROM calls LIMIT 1").get() !== null
            : current.status === "Waiting";
        if (phase === "start" && started && running) {
          yield* Effect.promise(() =>
            writeReady(
              readyFile,
              JSON.stringify({
                result: started.payload,
                runId: run.runId,
                status: current.status,
                waits: waits.map((wait) => wait.waitId),
              })
            )
          );
          return yield* Effect.never;
        }
        if (phase === "finish" && variant === "completed") {
          for (const wait of waits) {
            if (wait.status === "Open") {
              yield* runner.settle(
                {
                  operation: "approve",
                  requestKey: wait.waitId,
                  waitId: wait.waitId,
                },
                "owner"
              );
            }
          }
        }
        if (current.status === "Succeeded" || current.status === "TimedOut") {
          yield* Effect.promise(() =>
            writeReady(
              readyFile,
              JSON.stringify({
                result: started?.payload,
                runId: run.runId,
                status: current.status,
                waits: waits.map((wait) => wait.waitId),
              })
            )
          );
          return;
        }
        if (
          current.status === "Failed" ||
          current.status === "NeedsAttention"
        ) {
          return yield* Effect.die(JSON.stringify(current));
        }
        yield* Effect.sleep("20 millis");
      }
      return yield* Effect.die("Deadline fixture timed out");
    }).pipe(
      Effect.provide(
        hostLayer({
          blobs: path.join(directory, "blobs"),
          catalog,
          database: path.join(directory, "state.sqlite"),
        })
      )
    )
  );
} finally {
  audit.close();
}
