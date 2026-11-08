import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Application, Task, Workflow } from "@offtree/effectory-sdk";
import { Context, Effect, Layer, Schema } from "effect";

import { catalogLayer } from "../src/catalog.ts";
import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { Runner } from "../src/runner.ts";

const Transient = Schema.TaggedStruct("Transient", {});

test("cleanup crashes never become domain retries, while ordinary failures still retry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-cleanup-"));
  const cases = ["handler", "acquire", "release", "ordinary"] as const;
  const definitions = cases.map((mode) => {
    const Service = Context.Service<number>(`test/Cleanup/${mode}`);
    let entries = 0;
    const handlers: number[] = [];
    const releases: number[] = [];
    const resource = Effect.acquireRelease(
      Effect.sync(() => {
        entries += 1;
        return entries;
      }),
      (entry) =>
        Effect.gen(function* () {
          releases.push(entry);
          if (entry === 1 && (mode === "acquire" || mode === "release")) {
            return yield* Effect.die("cleanup failed");
          }
        })
    ).pipe(
      Effect.filterOrFail(
        (entry) => !(mode === "acquire" && entry === 1),
        () => ({ _tag: "Transient" }) as const
      )
    );
    const task = Task.make(
      {
        error: Transient,
        id: mode,
        input: Schema.Null,
        replay: "idempotent",
        success: Schema.String,
        version: 1,
      },
      () =>
        Effect.gen(function* () {
          const entry = yield* Service;
          handlers.push(entry);
          if (entry === 1) {
            return yield* Effect.fail({ _tag: "Transient" } as const).pipe(
              Effect.ensuring(
                mode === "handler" ? Effect.die("cleanup failed") : Effect.void
              )
            );
          }
          return "retried";
        })
    ).provide(Layer.effect(Service, resource));
    const workflow = Workflow.make(
      {
        error: Transient,
        id: mode,
        input: Schema.Null,
        success: Schema.String,
        version: 1,
      },
      Effect.gen(function* () {
        const graph = yield* Workflow.Builder;
        return yield* graph.task("task", task, null, {
          retry: { attempts: 2, delay: "1 millis", when: ["Transient"] },
        });
      })
    );
    return { handlers, mode, releases, task, workflow };
  });
  const app = Application.make({
    tasks: definitions.map(({ task }) => task),
    workflows: definitions.map(({ workflow }) => workflow),
  });
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
        for (const { handlers, mode, releases } of definitions) {
          const receipt = yield* runner.submit(
            {
              input: null,
              kind: "workflow",
              requestKey: mode,
              targetId: mode,
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
          const events = yield* store.events(run.runId);
          if (mode === "ordinary") {
            expect(run.status).toBe("Succeeded");
            expect(run.result).toBe("retried");
            expect(handlers).toEqual([1, 2]);
            expect(releases).toEqual([1, 2]);
            expect(
              events.filter((event) => event.tag === "RetryScheduled")
            ).toHaveLength(1);
          } else {
            expect(run.status).toBe("Failed");
            expect(run.result).toBeNull();
            expect(run.error).toEqual({ message: "Graph failed unexpectedly" });
            expect(handlers).toEqual(mode === "acquire" ? [] : [1]);
            expect(releases).toEqual([1]);
            expect(events.some((event) => event.tag === "RetryScheduled")).toBe(
              false
            );
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
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 15_000);
