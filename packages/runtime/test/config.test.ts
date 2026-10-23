/* eslint-disable no-await-in-loop */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openEngine } from "@effectory/runtime/engine";
import {
  canonicalJson,
  digestJson,
  RuntimeStore,
} from "@effectory/runtime/store";
import type { RegisteredTask } from "@effectory/runtime/task";
import { ArtifactStore, Automation, Effectory } from "@effectory/sdk";
import { RuntimeError } from "@effectory/sdk/errors";
import type { ArtifactRecord } from "@effectory/sdk/records";
import { Context, Effect, Layer, Schema } from "effect";

class Greeting extends Context.Service<Greeting, { readonly text: string }>()(
  "test/Greeting"
) {}

test("service-free registration defaults to an empty native layer", () => {
  const config = Effectory.make({ workflows: [] });
  expect(config.services).toBe(Layer.empty);
  expect(Layer.isLayer(config.services)).toBe(true);
});

const finish = async (
  engine: Awaited<ReturnType<typeof openEngine>>,
  id: string
) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await engine.inspectRun(id);
    if (run.status === "succeeded" || run.status === "failed") {
      return run;
    }
    await Bun.sleep(25);
  }
  throw new Error("Run did not finish");
};

test("configured services are scoped once and artifact writes and reads share the selected backend", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "factory-config-"));
  const records = new Map<string, ArtifactRecord>();
  let acquired = 0;
  let released = 0;
  const backend = ArtifactStore.of({
    get: (id) => Effect.sync(() => records.get(id)),
    list: (runId) =>
      Effect.sync(() =>
        [...records.values()].filter((a) => !runId || a.runId === runId)
      ),
    publish: (options) =>
      Effect.try({
        catch: (cause) => new RuntimeError({ cause, message: String(cause) }),
        try: () => {
          const id = digestJson([options.runId, options.name]);
          const digest = digestJson(options.value);
          const schemaVersion = options.schemaVersion ?? 1;
          const old = records.get(id);
          if (old) {
            if (old.digest !== digest || old.schemaVersion !== schemaVersion) {
              throw new Error("Artifact conflict");
            }
            return old;
          }
          const record = {
            ...options,
            createdAt: new Date().toISOString(),
            digest,
            id,
            schemaVersion,
            value: JSON.parse(canonicalJson(options.value)),
          };
          records.set(id, record);
          return record;
        },
      }),
  });
  const config = Effectory.make({
    services: Layer.mergeAll(
      Layer.succeed(ArtifactStore, backend),
      Layer.effect(
        Greeting,
        Effect.acquireRelease(
          Effect.sync(() => {
            acquired += 1;
            return { text: "configured" };
          }),
          () =>
            Effect.sync(() => {
              released += 1;
            })
        )
      )
    ),
  });
  const definition = Automation.define({
    description: "Uses configured services",
    error: Schema.Never,
    execute: () =>
      Effect.gen(function* execute() {
        const greeting = yield* Greeting;
        yield* Automation.publish("greeting", {
          schema: Schema.String,
          value: greeting.text,
        });
        return greeting.text;
      }),
    idempotencyKey: (input) => input.key,
    input: Schema.Struct({ key: Schema.String }),
    name: "configured",
    success: Schema.String,
  });
  const task: RegisteredTask = {
    ...definition,
    directory: ".",
    entrypoint: import.meta.path,
    fingerprint: { digest: "config-v1", files: [] },
    inputSchema: Schema.toJsonSchemaDocument(definition.workflow.payloadSchema),
  };
  let engine = await openEngine({
    config,
    tasks: [task],
    workspace,
  });
  try {
    const run = await engine.submit({
      input: { key: "one" },
      requestKey: "one",
      task: task.name,
    });
    const done = await finish(engine, run.id);
    expect(done.result).toBe("configured");
    expect(acquired).toBe(1);
    const artifacts = await engine.listArtifacts(run.id);
    expect(artifacts).toHaveLength(1);
    expect(await engine.listArtifacts("other-run")).toEqual([]);
    const [artifact] = artifacts;
    if (!artifact) {
      throw new Error("Missing configured artifact");
    }
    expect(await engine.getArtifact(artifact.id)).toEqual(artifact);
    const local = new RuntimeStore(workspace);
    try {
      expect(
        local.db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) as count FROM effectory_artifacts"
          )
          .get()?.count
      ).toBe(0);
    } finally {
      local.close();
    }
    await engine.close();
    expect(released).toBe(1);
    engine = await openEngine({
      config,
      execute: false,
      tasks: [task],
      workspace,
    });
    expect(await engine.getArtifact(artifact.id)).toEqual(artifact);
    expect(await engine.listArtifacts(run.id)).toEqual(artifacts);
    await expect(engine.getArtifact("missing")).rejects.toThrow(
      "Unknown artifact"
    );
  } finally {
    await engine.close();
    rmSync(workspace, { force: true, recursive: true });
  }
  expect(acquired).toBe(2);
  expect(released).toBe(2);
});

test("failed service acquisition releases runtime ownership", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "factory-config-fail-"));
  try {
    await expect(
      openEngine({
        config: Effectory.make({
          services: Layer.effect(
            Greeting,
            Effect.fail(new RuntimeError({ message: "backend unavailable" }))
          ),
        }),
        tasks: [],
        workspace,
      })
    ).rejects.toThrow("backend unavailable");
    const engine = await openEngine({ tasks: [], workspace });
    await engine.close();
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});
