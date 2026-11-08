import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Application,
  Task,
  TaskRuntimeError,
  Vault,
} from "@offtree/effectory-sdk";
import { Context, Effect, Layer, Redacted, Schema } from "effect";

import { catalogLayer } from "../src/catalog.ts";
import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { Runner } from "../src/runner.ts";

test("Layer errors and secrets first read at finalization never reach persisted task results", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-finalization-")
  );
  const canary = "CANARY-persistent-task-finalization";
  const credentials = Vault.make({
    id: "finalization",
    secrets: { token: Schema.String },
  });
  const modes = ["acquire", "result", "error", "runtime"] as const;
  const tasks = modes.map((mode) => {
    const Client = Context.Service<boolean>(`test/Finalization/${mode}`);
    const read = credentials.get("token").pipe(Effect.orDie);
    const client = Layer.effect(
      Client,
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.succeed(true), () =>
          Effect.gen(function* () {
            const secret = Redacted.value(yield* read);
            if (mode === "acquire") {
              return yield* Effect.die(new Error(secret));
            }
          })
        );
        if (mode === "acquire" || mode === "runtime") {
          const secret = Redacted.value(yield* read);
          return yield* mode === "runtime"
            ? new TaskRuntimeError({ code: "Unavailable", message: secret })
            : Effect.fail({ _tag: "Transient", message: secret } as const);
        }
        return true;
      })
    );
    return Task.make(
      {
        error: Schema.TaggedStruct("Transient", { message: Schema.String }),
        id: mode,
        input: Schema.Null,
        replay: "idempotent",
        success: Schema.String,
        version: 1,
      },
      () =>
        mode === "error"
          ? Effect.fail({ _tag: "Transient", message: canary } as const)
          : Effect.succeed(canary)
    )
      .provide(client)
      .provide(Vault.layer(credentials, Vault.memory({ token: canary })));
  });
  const app = Application.make({ tasks });
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
        for (const task of tasks) {
          const receipt = yield* runner.submit(
            {
              input: null,
              kind: "task",
              requestKey: task.id,
              targetId: task.id,
            },
            "owner"
          );
          const run = yield* Effect.gen(function* () {
            for (let poll = 0; poll < 500; poll += 1) {
              const current = yield* store.getRun(receipt.runId);
              if (
                current.status === "Succeeded" ||
                current.status === "Failed"
              ) {
                return current;
              }
              yield* Effect.sleep("10 millis");
            }
            return yield* Effect.die("Run did not finish");
          });
          expect(run.status).toBe("Failed");
          expect(run.result).toBeNull();
          expect(JSON.stringify(run)).not.toContain(canary);
          if (task.id === "result" || task.id === "error") {
            expect(run.error).toMatchObject({ code: "SecretInOutput" });
          }
          if (task.id === "runtime") {
            expect(run.error).toEqual({
              code: "Unavailable",
              message: "[vault secret omitted]",
            });
          }
        }
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
    // This Catalog is in memory, so the canary is never application source in
    // the store. Check native Activity rows and any WAL as well as Run replies.
    const entries = await readdir(directory);
    const files = entries.filter((name) => name.startsWith("state.sqlite"));
    const contents = await Promise.all(
      files.map((name) => readFile(path.join(directory, name)))
    );
    expect(contents.length).toBeGreaterThan(0);
    for (const content of contents) {
      expect(content.includes(Buffer.from(canary))).toBe(false);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 15_000);
