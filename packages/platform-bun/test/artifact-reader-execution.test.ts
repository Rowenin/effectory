import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Application,
  Artifact,
  ArtifactReader,
  ArtifactReadError,
  ArtifactUnavailable,
  ArtifactStorage,
  Report,
  Task,
} from "@offtree/effectory-sdk";
import { Context, Effect, Layer, Schema } from "effect";

import { catalogLayer } from "../src/catalog.ts";
import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { Runner } from "../src/runner.ts";

const Value = Artifact.make({
  id: "execution-value",
  schema: Schema.Struct({ value: Schema.Int }),
  version: 1,
});
const ReadValue = Context.Service<{ value: number }>("test/ReaderLayer");
const Producer = Task.make(
  {
    error: Schema.Never,
    id: "produce",
    input: Schema.Null,
    outputs: { value: Value },
    replay: "idempotent",
    success: Value.refSchema,
    version: 1,
  },
  () =>
    Effect.gen(function* () {
      return yield* (yield* ArtifactStorage).publish(
        Value,
        { value: 42 },
        { key: "latest" }
      );
    })
);
const Consumer = Task.make(
  {
    error: Schema.Union([ArtifactReadError, ArtifactUnavailable]),
    id: "consume",
    input: Value.refSchema,
    replay: "idempotent",
    success: Schema.Int,
    version: 1,
  },
  () => Effect.map(ReadValue, (value) => value.value)
).provide(
  Layer.effect(
    ReadValue,
    Effect.gen(function* () {
      const reader = yield* ArtifactReader;
      const ref = yield* reader.latest(Value, {
        key: "latest",
        output: "value",
        taskId: Producer.id,
      });
      return yield* reader.get(Value, ref);
    })
  )
);
const Reporter = Task.make(
  {
    error: Schema.Union([ArtifactReadError, ArtifactUnavailable]),
    id: "report",
    input: Report.sourceOf(Producer),
    replay: "idempotent",
    success: Report.result(Schema.Int),
    version: 1,
  },
  () =>
    Effect.gen(function* () {
      const history = yield* Report.History;
      const source = yield* history.outcome(Producer);
      if (source._tag !== "Succeeded") {
        return { data: 0, markdown: "No result" };
      }
      const value = yield* (yield* ArtifactReader).get(Value, source.value);
      return { data: value.value, markdown: "# Result" };
    })
);
const app = Application.make({
  reports: [
    Report.make({
      id: "summary",
      scope: "run",
      target: Producer,
      task: Reporter,
    }),
  ],
  tasks: [Producer, Consumer, Reporter],
}) satisfies Application.Application<never>;

test("real runner provides artifact reads to task Layers and automatically queued reporters", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-reader-execution-")
  );
  const catalog = Layer.unwrap(
    Effect.map(Application.Registry, (registry) =>
      catalogLayer("pinned", new Map([["pinned", registry]]))
    )
  ).pipe(Layer.provide(app.layer));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* Runner;
        const store = yield* HostStore;
        const wait = (runId: string) =>
          Effect.gen(function* () {
            for (let i = 0; i < 500; i += 1) {
              const run = yield* store.getRun(runId);
              if (
                [
                  "Succeeded",
                  "Failed",
                  "Cancelled",
                  "TimedOut",
                  "Rejected",
                ].includes(run.status)
              ) {
                return run;
              }
              yield* Effect.sleep("10 millis");
            }
            return yield* Effect.die("Run did not finish");
          });
        const first = yield* runner.submit(
          {
            input: null,
            kind: "task",
            requestKey: "producer",
            targetId: Producer.id,
          },
          "owner"
        );
        const produced = yield* wait(first.runId);
        expect(produced.status).toBe("Succeeded");
        const consumer = yield* runner.submit(
          {
            input: produced.result,
            kind: "task",
            requestKey: "consumer",
            targetId: Consumer.id,
          },
          "owner"
        );
        expect((yield* wait(consumer.runId)).result).toBe(42);
        for (let i = 0; i < 500; i += 1) {
          const ids = yield* store.reportIds(first.runId);
          if (ids[0] !== undefined) {
            const report = yield* store.reportGet(ids[0]);
            if (report.reportRunId !== null) {
              const result = yield* wait(report.reportRunId);
              expect(result.status).toBe("Succeeded");
              expect(result.result).toEqual({ data: 42, markdown: "# Result" });
              return;
            }
          }
          yield* Effect.sleep("10 millis");
        }
        return yield* Effect.die("Report was not admitted");
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
    await rm(directory, { force: true, recursive: true });
  }
}, 15_000);
