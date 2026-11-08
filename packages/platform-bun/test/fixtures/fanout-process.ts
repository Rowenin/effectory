import { Database } from "bun:sqlite";
import path from "node:path";

import { Application, Task, Workflow } from "@offtree/effectory-sdk";
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
audit.exec(
  "CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, count INTEGER NOT NULL)"
);
const work = Task.make(
  {
    error: Schema.Never,
    id: "work",
    input: Schema.String,
    replay: "manual",
    success: Schema.String,
    version: 1,
  },
  (id) =>
    Effect.sync(() => {
      audit
        .query(
          "INSERT INTO calls VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET count = count + 1"
        )
        .run(id);
      return id.toUpperCase();
    })
);
const Input = Schema.Array(Schema.String);
const flow = Workflow.make(
  {
    error: Schema.Never,
    execution: { concurrency: 2 },
    id: "fanout",
    input: Input,
    success: Input,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const input = yield* graph.input(Input);
    // oxlint-disable-next-line unicorn/no-array-for-each -- Durable graph operator.
    return yield* graph.forEach(
      "items",
      input,
      {
        concurrency: 3,
        item: Schema.String,
        key: (id) => id,
        maxItems: 10,
        success: Schema.String,
      },
      (item) =>
        Effect.gen(function* () {
          const child = yield* Workflow.Builder;
          const value = yield* child.task("work", work, item);
          yield* child.approval("review", {
            after: [value],
            context: { value },
            prompt: "Continue?",
            timeout: "1 hour",
          });
          return value;
        })
    );
  })
);
const app = Application.make({ tasks: [work], workflows: [flow] });
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
          input: ["b", "a", "c"],
          kind: "workflow",
          requestKey: "fanout",
          targetId: flow.id,
        },
        "owner"
      );
      for (let index = 0; index < 800; index += 1) {
        const current = yield* store.getRun(run.runId);
        const waits = yield* store.listWaits(run.runId);
        if (
          mode === "start" &&
          waits.length === 3 &&
          current.status === "Waiting"
        ) {
          yield* Effect.promise(() =>
            writeReady(
              readyFile,
              JSON.stringify({
                runId: run.runId,
                status: current.status,
                waits: waits.map((wait) => wait.waitId).toSorted(),
              })
            )
          );
          return yield* Effect.never;
        }
        if (mode === "finish") {
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
        if (current.status === "Succeeded") {
          yield* Effect.promise(() =>
            writeReady(
              readyFile,
              JSON.stringify({
                result: current.result,
                runId: run.runId,
                status: current.status,
                waits: waits.map((wait) => wait.waitId).toSorted(),
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
      return yield* Effect.die("Fan-out fixture timed out");
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
