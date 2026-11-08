import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { terminal } from "@effectory/runtime/protocol";
import {
  Application,
  Artifact,
  ArtifactStorage,
  Tag,
  Task,
  Workflow,
} from "@offtree/effectory-sdk";
import { Effect, Layer, Option, Schema } from "effect";

import { catalogLayer } from "../src/catalog.ts";
import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { Lake } from "../src/lake.ts";
import { Runner } from "../src/runner.ts";

test("workflow admission, DI reads and inherited lake metadata agree in a real host", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-tag-runtime-")
  );
  const Team = Tag.make("team", Schema.NonEmptyString);
  const Build = Tag.make("build", Schema.Int);
  const Report = Artifact.make({
    id: "report",
    schema: Schema.Int,
    version: 1,
  });
  let calls = 0;
  const task = Task.make(
    {
      error: Schema.Never,
      id: "report",
      input: Schema.Null,
      outputs: { report: Report },
      replay: "idempotent",
      success: Report.refSchema,
      version: 1,
    },
    (_, context) =>
      Effect.gen(function* () {
        calls += 1;
        const build = Option.getOrElse(yield* Build.value(), () => 0);
        expect(Option.getOrNull(yield* Team.value())).toBe("platform");
        const storage = yield* ArtifactStorage;
        const reference = yield* storage.publish(Report, build, {
          key: "report",
          tags: { kind: "report" },
        });
        expect(
          yield* context.publish("report", build, {
            key: "report",
            tags: { kind: "report" },
          })
        ).toEqual(reference);
        return reference;
      })
  );
  const workflow = Workflow.make(
    {
      error: Schema.Never,
      id: "report",
      input: Schema.Null,
      success: Report.refSchema,
      tags: [Team("platform"), Build],
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      return yield* graph.task("report", task, null);
    })
  );
  const app = Application.make({
    tasks: [task],
    workflows: [workflow],
  }) satisfies Application.Application<never>;
  const catalog = Layer.unwrap(
    Effect.map(Application.Registry, (registry) =>
      catalogLayer("revision", new Map([["revision", registry]]))
    )
  ).pipe(Layer.provide(app.layer));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* Runner;
        const store = yield* HostStore;
        const lake = yield* Lake;
        const request = {
          input: null,
          kind: "workflow" as const,
          requestKey: "one",
          targetId: "report",
        };
        const invalid = yield* runner
          .submit({ ...request, tags: { build: "bad" } }, "owner")
          .pipe(Effect.flip);
        expect(invalid.code).toBe("InvalidInput");
        expect(invalid.message).toContain("build");
        expect(calls).toBe(0);
        expect(
          yield* store.lookupSubmission(
            { ...request, tags: { build: "bad" } },
            "owner"
          )
        ).toBeNull();
        const admitted = yield* runner.submit(
          { ...request, tags: { build: "042" } },
          "owner"
        );
        expect(admitted.tags).toEqual({ build: "042", team: "platform" });
        let run = admitted;
        for (let i = 0; i < 500 && !terminal.has(run.status); i += 1) {
          yield* Effect.sleep("20 millis");
          run = yield* store.getRun(run.runId);
        }
        expect(run.status).toBe("Succeeded");
        const reference = Schema.decodeUnknownSync(Report.refSchema)(
          run.result
        );
        const content = yield* lake.get(
          reference.artifactId,
          reference.version
        );
        expect(content.value).toBe(42);
        expect(content.metadata.tags).toEqual({
          build: "042",
          kind: "report",
          team: "platform",
        });
        expect(
          (yield* store.history(
            { tags: { build: "042", team: "platform" } },
            "owner"
          )).items[0]?.runId
        ).toBe(run.runId);
        expect(
          (yield* runner.submit(
            { ...request, tags: { build: "042" } },
            "owner"
          )).runId
        ).toBe(run.runId);
        const missing = yield* runner.submit(
          { ...request, requestKey: "missing" },
          "owner"
        );
        expect(missing.tags).toEqual({ team: "platform" });
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
}, 30_000);
