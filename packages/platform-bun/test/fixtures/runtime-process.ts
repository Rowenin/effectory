import { Database } from "bun:sqlite";
import path from "node:path";

import {
  Application,
  Artifact,
  Ref,
  Task,
  Workflow,
} from "@offtree/effectory-sdk";
import { Effect, Layer, Schema } from "effect";

import { catalogLayer } from "../../src/catalog.ts";
import { HostStore } from "../../src/host-store.ts";
import { hostLayer } from "../../src/host.ts";
import { Lake } from "../../src/lake.ts";
import { Runner } from "../../src/runner.ts";
import { writeReady } from "./ready.ts";

const [directory, mode, readyFile] = process.argv.slice(2);
if (directory === undefined || mode === undefined || readyFile === undefined) {
  throw new Error("Expected directory, mode and ready-file arguments");
}
const audit = new Database(path.join(directory, "audit.sqlite"));
audit.run(
  "CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, count INTEGER NOT NULL)"
);
const Input = Schema.Struct({ name: Schema.String });
const Output = Artifact.make({
  fields: [["greeting"]],
  id: "example/greeting",
  schema: Schema.Struct({ greeting: Schema.String }),
  version: 1,
});
const greet = Task.make(
  {
    error: Schema.Never,
    id: "example/greet",
    input: Input,
    replay: "idempotent",
    success: Schema.String,
    version: 1,
  },
  ({ name }) =>
    Effect.sync(() => {
      audit
        .query(
          "INSERT INTO calls VALUES ('greet', 1) ON CONFLICT(id) DO UPDATE SET count = count + 1"
        )
        .run();
      return `Hello ${name}`;
    })
);
const publish = Task.make(
  {
    error: Schema.Never,
    id: "example/publish",
    input: Schema.String,
    outputs: { greeting: Output },
    replay: "idempotent",
    success: Output.refSchema,
    version: 1,
  },
  (greeting, context) =>
    Effect.gen(function* () {
      const reference = yield* context.publish(
        "greeting",
        { greeting },
        { key: "main", tags: { source: "example" } }
      );
      if (mode === "publish-crash") {
        yield* Effect.promise(
          async () =>
            await writeReady(
              readyFile,
              JSON.stringify({ runId: context.runId, status: "Published" })
            )
        );
        return yield* Effect.never;
      }
      return reference;
    })
);
const flow = Workflow.make(
  {
    error: Schema.Never,
    id: "example/welcome",
    input: Input,
    success: Output.refSchema,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const input = yield* graph.input(Input);
    const greeting = yield* graph.task("greet", greet, {
      name: Ref.field(input, "name"),
    });
    const approval = yield* graph.approval("review", {
      after: [greeting],
      context: { greeting },
      prompt: "Publish greeting?",
      timeout: "1 hours",
    });
    return yield* graph.task("publish", publish, greeting, {
      after: [approval],
    });
  })
);
const app = Application.make({ tasks: [greet, publish], workflows: [flow] });
const catalog = Layer.unwrap(
  Effect.map(Application.Registry, (registry) =>
    catalogLayer("fixture-revision", new Map([["fixture-revision", registry]]))
  )
).pipe(Layer.provide(app.layer));
try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const lake = yield* Lake;
      const invalid = yield* Effect.exit(
        runner.submit(
          {
            input: { name: 10 },
            kind: "workflow",
            requestKey: "invalid",
            targetId: flow.id,
          },
          "owner"
        )
      );
      if (invalid._tag !== "Failure") {
        return yield* Effect.die("Invalid input was accepted");
      }
      const run = yield* runner.submit(
        {
          input: { name: "Ada" },
          kind: "workflow",
          requestKey: "greet-ada",
          targetId: flow.id,
        },
        "owner"
      );
      for (let index = 0; index < 800; index += 1) {
        const current = yield* store.getRun(run.runId);
        const [wait] = yield* store.listWaits(run.runId);
        if (current.status === "Waiting" && wait && mode === "start") {
          yield* Effect.promise(
            async () =>
              await writeReady(
                readyFile,
                JSON.stringify({
                  runId: run.runId,
                  status: "Waiting",
                  waitId: wait.waitId,
                })
              )
          );
          return yield* Effect.never;
        }
        if (wait?.status === "Open" && mode !== "start") {
          yield* store.settle(
            {
              operation: "approve",
              requestKey: "approved",
              waitId: wait.waitId,
            },
            "owner",
            (value) => value
          );
        }
        if (current.status === "Succeeded") {
          const results = yield* lake.query(
            {
              artifact: { schemaId: Output.id, schemaVersion: 1 },
              limit: 50,
              version: 1,
              versions: "all",
            },
            "owner"
          );
          yield* Effect.promise(
            async () =>
              await writeReady(
                readyFile,
                JSON.stringify({
                  artifacts: results.rows,
                  result: current.result,
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
      return yield* Effect.die("Runtime fixture timed out");
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
