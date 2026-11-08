import { Database } from "bun:sqlite";

import {
  Application,
  Artifact,
  ArtifactStorage,
  Task,
  Workflow,
} from "@offtree/effectory-sdk";
import { Context, Effect, Layer, Schema } from "effect";

import { catalogLayer } from "../../src/catalog.ts";
import { HostStore, hostStoreLayer } from "../../src/host-store.ts";
import { hostLayer } from "../../src/host.ts";
import { ownershipLayer } from "../../src/ownership.ts";
import { Runner } from "../../src/runner.ts";
import { writeReady } from "./ready.ts";

const [filename, mode, readyFile] = process.argv.slice(2);
if (!filename || !mode || !readyFile) {
  throw new Error("Expected database, mode and ready path");
}
const audit = new Database(`${filename}.audit`);
audit.exec(
  "CREATE TABLE IF NOT EXISTS actions (name TEXT PRIMARY KEY,count INTEGER NOT NULL)"
);
const bump = (name: string) =>
  audit
    .query(
      "INSERT INTO actions VALUES (?,1) ON CONFLICT(name) DO UPDATE SET count=count+1"
    )
    .run(name);
const first = Task.make(
  {
    error: Schema.Never,
    id: "first",
    input: Schema.Null,
    replay: "idempotent",
    success: Schema.Int,
    version: 1,
  },
  () =>
    Effect.sync(() => {
      bump("first");
      return 1;
    })
);
const receipt = Artifact.make({
  id: "receipt",
  schema: Schema.Int,
  version: 1,
});
const resource = Context.Service<number>("recovery-fixture/Resource");
const charge = Task.make(
  {
    error: Schema.Never,
    id: "charge",
    input: Schema.Int,
    outputs: { receipt },
    replay: "manual",
    success: Schema.Int,
    version: 1,
  },
  (value) =>
    Effect.gen(function* () {
      yield* resource;
      bump("charge");
      yield* (yield* ArtifactStorage).publish(receipt, value, { key: "same" });
      if (mode !== "complete") {
        yield* Effect.promise(() =>
          writeReady(readyFile, JSON.stringify({ status: "Action" }))
        );
        return yield* Effect.never;
      }
      return value + 1;
    })
).provide(
  Layer.effect(
    resource,
    Effect.acquireRelease(
      Effect.sync(() => {
        bump("acquire");
        return 1;
      }),
      () =>
        Effect.sync(() => {
          bump("release");
        })
    )
  )
);
const flow = Workflow.make(
  {
    error: Schema.Never,
    id: "flow",
    input: Schema.Null,
    success: Schema.Int,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const value = yield* graph.task("first", first, null);
    return yield* graph.task("charge", charge, value, {
      attemptTimeout: "1 second",
    });
  })
);
const app = Application.make({ tasks: [first, charge], workflows: [flow] });
const catalog = Layer.unwrap(
  Effect.map(Application.Registry, (registry) =>
    catalogLayer("pinned", new Map([["pinned", registry]]))
  )
).pipe(Layer.provide(app.layer));
const program = Effect.gen(function* () {
  const store = yield* HostStore;
  const runner = yield* Runner;
  const run = yield* runner.submit(
    { input: null, kind: "workflow", requestKey: "original", targetId: "flow" },
    "owner"
  );
  if (mode === "start") {
    return yield* Effect.never;
  }
  for (let i = 0; i < 1000; i += 1) {
    const current = yield* store.getRun(run.runId);
    if (mode === "hold" && current.status === "NeedsAttention") {
      const assessment = yield* store.recoveryGet(
        { runId: run.runId },
        "owner"
      );
      if (assessment.state === "Recoverable") {
        yield* Effect.promise(() =>
          writeReady(readyFile, JSON.stringify(assessment))
        );
        return yield* Effect.never;
      }
    }
    if (mode === "complete" && current.status === "NeedsAttention") {
      const assessment = yield* store.recoveryGet(
        { runId: run.runId },
        "owner"
      );
      if (assessment.token) {
        yield* store.recover(
          {
            acknowledgeReexecution: true,
            requestKey: "finish",
            runId: run.runId,
            token: assessment.token,
          },
          "owner"
        );
      }
    }
    if (mode === "complete" && current.status === "Succeeded") {
      yield* Effect.promise(() =>
        writeReady(readyFile, JSON.stringify(current))
      );
      return;
    }
    if (["Failed", "TimedOut", "Cancelled"].includes(current.status)) {
      return yield* Effect.die(JSON.stringify(current));
    }
    yield* Effect.sleep("20 millis");
  }
  return yield* Effect.die("Recovery fixture timed out");
});
const accept = Effect.gen(function* () {
  const store = yield* HostStore;
  const [run] = yield* store.listRuns();
  if (!run) {
    return yield* Effect.die("Missing run");
  }
  const assessment = yield* store.recoveryGet({ runId: run.runId }, "owner");
  if (!assessment.token) {
    return yield* Effect.die(JSON.stringify(assessment));
  }
  const accepted = yield* store.recover(
    {
      acknowledgeReexecution: true,
      requestKey: "accepted-before-kill",
      runId: run.runId,
      token: assessment.token,
    },
    "owner"
  );
  yield* Effect.promise(() => writeReady(readyFile, JSON.stringify(accepted)));
});
const effect =
  mode === "accept"
    ? accept.pipe(
        Effect.provide(
          hostStoreLayer(filename).pipe(
            Layer.provide(ownershipLayer(`${filename}.owner`))
          )
        )
      )
    : program.pipe(
        Effect.provide(
          hostLayer({ blobs: `${filename}.blobs`, catalog, database: filename })
        )
      );
await Effect.runPromise(effect).finally(() => audit.close());
