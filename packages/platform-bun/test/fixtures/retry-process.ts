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
const audit = new Database(path.join(directory, "audit.sqlite"));
audit.exec("CREATE TABLE IF NOT EXISTS calls (attempt INTEGER, key TEXT)");
const RetryError = Schema.TaggedStruct("RetryLater", {});
const task = Task.make(
  {
    error: RetryError,
    id: "retry",
    input: Schema.Null,
    replay: "idempotent",
    success: Schema.String,
    version: 1,
  },
  (_, context) =>
    Effect.gen(function* () {
      audit
        .query("INSERT INTO calls VALUES (?, ?)")
        .run(context.attempt, context.key("operation"));
      if (context.attempt === 1) {
        return yield* Effect.fail({ _tag: "RetryLater" as const });
      }
      return "done";
    })
);
const flow = Workflow.make(
  {
    error: RetryError,
    id: "retry-flow",
    input: Schema.Null,
    success: Schema.String,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    return yield* graph.task("retry", task, null, {
      retry: { attempts: 2, delay: "2 seconds", when: ["RetryLater"] },
    });
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
          requestKey: "retry",
          targetId: flow.id,
        },
        "owner"
      );
      for (let index = 0; index < 800; index += 1) {
        const current = yield* store.getRun(run.runId);
        const events = yield* store.events(run.runId);
        const retry = events.find((event) => event.tag === "RetryScheduled");
        if (mode === "start" && retry && current.status === "Waiting") {
          yield* Effect.promise(() =>
            writeReady(
              readyFile,
              JSON.stringify({
                result: retry.payload,
                runId: run.runId,
                status: current.status,
              })
            )
          );
          return yield* Effect.never;
        }
        if (current.status === "Succeeded") {
          yield* Effect.promise(() =>
            writeReady(
              readyFile,
              JSON.stringify({
                result: retry?.payload,
                runId: run.runId,
                status: current.status,
              })
            )
          );
          return;
        }
        if (current.status === "Failed") {
          return yield* Effect.die(JSON.stringify(current.error));
        }
        yield* Effect.sleep("20 millis");
      }
      return yield* Effect.die("Retry fixture timed out");
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
