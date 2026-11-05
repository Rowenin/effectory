import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Application, Ref, Task, Workflow } from "@effectory/core";
import { terminal } from "@effectory/runtime/protocol";
import { Deferred, Effect, Layer, Schema } from "effect";
import type { WorkflowEngine } from "effect/workflow/WorkflowEngine";

import { catalogLayer } from "../src/catalog.ts";
import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { runOutputs } from "../src/run-outputs.ts";
import { Runner } from "../src/runner.ts";

async function withHost<A, E>(
  app: Application.Application<never>,
  body: Effect.Effect<
    A,
    E,
    typeof Runner.Service | typeof HostStore.Service | WorkflowEngine
  >
) {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-operators-"));
  const catalog = Layer.unwrap(
    Effect.map(Application.Registry, (registry) =>
      catalogLayer("revision", new Map([["revision", registry]]))
    )
  ).pipe(Layer.provide(app.layer));
  try {
    return await Effect.runPromise(
      body.pipe(
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
}
const settle = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* HostStore;
    for (let index = 0; index < 500; index += 1) {
      const run = yield* store.getRun(runId);
      if (terminal.has(run.status) || run.status === "NeedsAttention") {
        return run;
      }
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die("Operator run did not settle");
  });

const disconnectedSignal = () => Effect.die("Receiver not connected");

test("uninterruptible task cleanup is held for attention without blocking unrelated runs", () => {
  const release = Deferred.makeUnsafe<null>();
  let active = false;
  const task = Task.make(
    {
      error: Schema.Never,
      id: "uninterruptible",
      input: Schema.Null,
      replay: "manual",
      success: Schema.String,
      version: 1,
    },
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          active = true;
        }),
        () =>
          Deferred.await(release).pipe(
            Effect.uninterruptible,
            Effect.as("done")
          ),
        () =>
          Effect.sync(() => {
            active = false;
          })
      )
  );
  const healthy = Task.make(
    {
      error: Schema.Never,
      id: "healthy",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.String,
      version: 1,
    },
    () => Effect.succeed("healthy")
  );
  const flow = Workflow.make(
    {
      error: Schema.Never,
      execution: { timeout: "2 seconds" },
      id: "stalled",
      input: Schema.Null,
      success: Schema.String,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      return yield* graph.task("work", task, null);
    })
  );
  return withHost(
    Application.make({ tasks: [task, healthy], workflows: [flow] }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "stalled",
          targetId: flow.id,
        },
        "owner"
      );
      const stalled = yield* settle(run.runId);
      expect(stalled.status).toBe("NeedsAttention");
      expect(active).toBe(true);
      const other = yield* runner.submit(
        {
          input: null,
          kind: "task",
          requestKey: "healthy",
          targetId: healthy.id,
        },
        "owner"
      );
      expect((yield* settle(other.runId)).status).toBe("Succeeded");
      yield* Deferred.succeed(release, null);
      const store = yield* HostStore;
      for (let index = 0; index < 200; index += 1) {
        const current = yield* store.getRun(run.runId);
        if (terminal.has(current.status)) {
          expect(current.status).toBe("TimedOut");
          expect(active).toBe(false);
          return;
        }
        yield* Effect.sleep("20 millis");
      }
      return yield* Effect.die("Cleanup did not settle after release");
    }).pipe(Effect.ensuring(Deferred.succeed(release, null)))
  );
}, 20_000);

test.each(["task", "attempt", "child", "workflow"] as const)(
  "%s deadline interrupts active work and waits for resource cleanup",
  (kind) => {
    let active = false;
    let calls = 0;
    const task = Task.make(
      {
        error: Schema.Never,
        id: "deadline-work",
        input: Schema.Null,
        replay: "manual",
        success: Schema.String,
        version: 1,
      },
      () =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            calls += 1;
            active = true;
          }),
          () => Effect.never,
          () =>
            Effect.sync(() => {
              active = false;
            })
        )
    );
    const child = Workflow.make(
      {
        error: Schema.Never,
        execution: { timeout: "2 seconds" },
        id: "deadline-child",
        input: Schema.Null,
        success: Schema.String,
        version: 1,
      },
      Effect.gen(function* () {
        const graph = yield* Workflow.Builder;
        return yield* graph.task("work", task, null);
      })
    );
    const flow = Workflow.make(
      {
        error: Schema.Never,
        id: "deadline-flow",
        input: Schema.Null,
        success: Schema.String,
        version: 1,
        ...(kind === "workflow" ? { execution: { timeout: "2 seconds" } } : {}),
      },
      Effect.gen(function* () {
        const graph = yield* Workflow.Builder;
        if (kind === "child") {
          return yield* graph.workflow("child", child, null, {
            timeout: "1 minute",
          });
        }
        const options: Pick<
          Workflow.NodeOptions,
          "timeout" | "attemptTimeout"
        > = {
          ...(kind === "task" ? { timeout: "2 seconds" } : {}),
          ...(kind === "attempt" ? { attemptTimeout: "50 millis" } : {}),
        };
        return yield* graph.task("work", task, null, options);
      })
    );
    return withHost(
      Application.make({ tasks: [task], workflows: [flow] }),
      Effect.gen(function* () {
        const run = yield* (yield* Runner).submit(
          {
            input: null,
            kind: "workflow",
            requestKey: "deadline",
            targetId: flow.id,
          },
          "owner"
        );
        const result = yield* settle(run.runId);
        expect(result.status).toBe("TimedOut");
        expect(active).toBe(false);
        expect(calls).toBe(1);
      })
    );
  },
  15_000
);

test("workflow deadline closes an open approval without an answer", () => {
  const flow = Workflow.make(
    {
      error: Schema.Never,
      execution: { timeout: "1 second" },
      id: "deadline-wait",
      input: Schema.Null,
      success: Schema.String,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      yield* graph.approval("review", { prompt: "Wait", timeout: "1 minute" });
      return "done";
    })
  );
  return withHost(
    Application.make({ tasks: [], workflows: [flow] }),
    Effect.gen(function* () {
      const run = yield* (yield* Runner).submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "deadline",
          targetId: flow.id,
        },
        "owner"
      );
      expect((yield* settle(run.runId)).status).toBe("TimedOut");
      const waits = yield* (yield* HostStore).listWaits(run.runId);
      expect(waits.length).toBe(1);
      expect(waits[0]?.status).toBe("Cancelled");
    })
  );
}, 15_000);

test("total task deadline includes retry backoff", () => {
  let calls = 0;
  const RetryError = Schema.TaggedStruct("RetryLater", {});
  const task = Task.make(
    {
      error: RetryError,
      id: "backoff",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.String,
      version: 1,
    },
    () =>
      Effect.suspend(() => {
        calls += 1;
        return Effect.fail({ _tag: "RetryLater" as const });
      })
  );
  const flow = Workflow.make(
    {
      error: RetryError,
      id: "deadline-backoff",
      input: Schema.Null,
      success: Schema.String,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      return yield* graph.task("retry", task, null, {
        retry: { attempts: 3, delay: "5 seconds", when: ["RetryLater"] },
        timeout: "1 second",
      });
    })
  );
  return withHost(
    Application.make({ tasks: [task], workflows: [flow] }),
    Effect.gen(function* () {
      const run = yield* (yield* Runner).submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "deadline",
          targetId: flow.id,
        },
        "owner"
      );
      expect((yield* settle(run.runId)).status).toBe("TimedOut");
      expect(calls).toBe(1);
    })
  );
}, 15_000);

test.each(["RateLimited", "Permanent"] as const)(
  "task retries select declared error tags (%s)",
  (tag) => {
    const attempts: number[] = [];
    const keys: string[] = [];
    const RetryError = Schema.Union([
      Schema.TaggedStruct("RateLimited", {}),
      Schema.TaggedStruct("Permanent", {}),
    ]);
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
          attempts.push(context.attempt);
          keys.push(context.key("external"));
          yield* context.progress({ message: `Attempt ${context.attempt}` });
          if (context.attempt < 2) {
            return yield* Effect.fail({ _tag: tag });
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
          retry: { attempts: 3, delay: "50 millis", when: ["RateLimited"] },
        });
      })
    );
    return withHost(
      Application.make({ tasks: [task], workflows: [flow] }),
      Effect.gen(function* () {
        const run = yield* (yield* Runner).submit(
          {
            input: null,
            kind: "workflow",
            requestKey: "retry",
            targetId: flow.id,
          },
          "owner"
        );
        const result = yield* settle(run.runId);
        expect(result.status).toBe(
          tag === "RateLimited" ? "Succeeded" : "Failed"
        );
        expect(attempts).toEqual(tag === "RateLimited" ? [1, 2] : [1]);
        expect(new Set(keys).size).toBe(1);
        const events = yield* (yield* HostStore).events(run.runId);
        expect(events.filter((event) => event.tag === "Progress").length).toBe(
          attempts.length
        );
        expect(
          events.filter((event) => event.tag === "RetryScheduled").length
        ).toBe(attempts.length - 1);
      })
    );
  },
  15_000
);

test.each([false, true])(
  "a callback before trigger completion preserves the trigger outcome (failure=%s)",
  (failTrigger) => {
    let calls = 0;
    let signal: (waitId: string) => Effect.Effect<void> = disconnectedSignal;
    const trigger = Task.make(
      {
        error: Schema.Literal("TriggerFailed"),
        id: "trigger",
        input: Workflow.SignalAddress,
        replay: "manual",
        success: Schema.String,
        version: 1,
      },
      (address) =>
        Effect.gen(function* () {
          calls += 1;
          yield* signal(address.waitId);
          yield* Effect.sleep("250 millis");
          if (failTrigger) {
            return yield* Effect.fail("TriggerFailed" as const);
          }
          return "started";
        })
    );
    const flow = Workflow.make(
      {
        error: trigger.errorSchema,
        id: "callback",
        input: Schema.Null,
        success: Schema.Int,
        version: 1,
      },
      Effect.gen(function* () {
        const graph = yield* Workflow.Builder;
        const receiver = yield* graph.registerSignal("completion", {
          schema: Schema.Int,
          timeout: "1 minute",
        });
        const started = yield* graph.task("trigger", trigger, receiver.address);
        return yield* graph.awaitSignal("result", receiver, {
          after: [started],
        });
      })
    );
    return withHost(
      Application.make({ tasks: [trigger], workflows: [flow] }),
      Effect.gen(function* () {
        const runner = yield* Runner;
        const store = yield* HostStore;
        signal = (waitId) =>
          runner
            .settle(
              {
                input: 42,
                operation: "signal",
                requestKey: "callback",
                waitId,
              },
              "owner"
            )
            .pipe(Effect.asVoid, Effect.orDie);
        const run = yield* runner.submit(
          {
            input: null,
            kind: "workflow",
            requestKey: "callback",
            targetId: flow.id,
          },
          "owner"
        );
        const result = yield* settle(run.runId);
        expect(result.status).toBe(failTrigger ? "Failed" : "Succeeded");
        expect(failTrigger ? result.error : result.result).toEqual(
          failTrigger ? "TriggerFailed" : 42
        );
        expect(calls).toBe(1);
        expect(
          (yield* store.listWaits(run.runId)).map((wait) => wait.status)
        ).toEqual(["Signaled"]);
      })
    );
  },
  15_000
);

test("a child workflow cannot leak an error outside its declared boundary", () => {
  const task = Task.make(
    {
      error: Schema.Literal("Oops"),
      id: "failure",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.String,
      version: 1,
    },
    () => Effect.fail("Oops" as const)
  );
  const child = Workflow.make(
    {
      error: Schema.Never,
      id: "narrow-child",
      input: Schema.Null,
      success: Schema.String,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      return yield* graph.task("failure", task, null);
    })
  );
  const parent = Workflow.make(
    {
      error: task.errorSchema,
      id: "wide-parent",
      input: Schema.Null,
      success: Schema.String,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      return yield* graph.workflow("child", child, null);
    })
  );
  return withHost(
    Application.make({ tasks: [task], workflows: [parent] }),
    Effect.gen(function* () {
      const run = yield* (yield* Runner).submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "error",
          targetId: parent.id,
        },
        "owner"
      );
      const result = yield* settle(run.runId);
      expect(result.status).toBe("Failed");
      expect(result.error).toEqual({
        message: "Workflow error boundary validation failed",
      });
    })
  );
}, 15_000);

const Input = Schema.Struct({ choice: Schema.Boolean });
test("an inactive branch capture does not delay the selected branch", () => {
  let called = false;
  const task = Task.make(
    {
      error: Schema.Never,
      id: "active",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.String,
      version: 1,
    },
    () =>
      Effect.sync(() => {
        called = true;
        return "active";
      })
  );
  const flow = Workflow.make(
    {
      error: Schema.Never,
      id: "inactive-capture",
      input: Schema.Boolean,
      success: Schema.String,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      const condition = yield* graph.input(Schema.Boolean);
      const answer = yield* graph.requestInput("unrelated", {
        prompt: "Answer",
        schema: Schema.String,
        timeout: "1 minute",
      });
      return yield* graph.branch("choice", condition, {
        onFalse: Effect.succeed(answer),
        onTrue: Effect.gen(function* () {
          const child = yield* Workflow.Builder;
          return yield* child.task("active", task, null);
        }),
        success: Schema.String,
      });
    })
  );
  return withHost(
    Application.make({ tasks: [task], workflows: [flow] }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        {
          input: true,
          kind: "workflow",
          requestKey: "active",
          targetId: flow.id,
        },
        "owner"
      );
      for (let i = 0; i < 200; i += 1) {
        if (called) {
          break;
        }
        yield* Effect.sleep("10 millis");
      }
      expect(called).toBe(true);
      const [wait] = yield* store.listWaits(run.runId);
      if (!wait) {
        return yield* Effect.die("Missing activated wait");
      }
      expect((yield* store.getRun(run.runId)).status).not.toBe("Succeeded");
      yield* runner.settle(
        {
          input: "unused",
          operation: "respond",
          requestKey: "answer",
          waitId: wait.waitId,
        },
        "owner"
      );
      expect((yield* settle(run.runId)).result).toBe("active");
    })
  );
}, 15_000);
test("only the selected branch executes and captures parent values with shadowed node names", () => {
  const calls: string[] = [];
  const task = Task.make(
    {
      error: Schema.Never,
      id: "echo",
      input: Schema.String,
      replay: "idempotent",
      success: Schema.String,
      version: 1,
    },
    (value) =>
      Effect.sync(() => {
        calls.push(value);
        return value;
      })
  );
  const flow = Workflow.make(
    {
      error: Schema.Never,
      id: "branch",
      input: Input,
      success: Schema.String,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      const input = yield* graph.input(Input);
      const value = yield* graph.task("same", task, "parent");
      return yield* graph.branch("choice", Ref.field(input, "choice"), {
        onFalse: Effect.gen(function* () {
          const branch = yield* Workflow.Builder;
          return yield* branch.task("same", task, "inactive");
        }),
        onTrue: Effect.gen(function* () {
          const branch = yield* Workflow.Builder;
          return yield* branch.task("same", task, value);
        }),
        success: Schema.String,
      });
    })
  );
  return withHost(
    Application.make({ tasks: [task], workflows: [flow] }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const run = yield* runner.submit(
        {
          input: { choice: true },
          kind: "workflow",
          requestKey: "one",
          targetId: flow.id,
        },
        "owner"
      );
      const result = yield* settle(run.runId);
      expect(result.status).toBe("Succeeded");
      expect(result.result).toBe("parent");
      expect(calls).toEqual(["parent", "parent"]);
    })
  );
}, 15_000);

test("keyed fan-out preserves result order and nested leaf limits without controller deadlock", () => {
  const Target = Schema.Struct({ id: Schema.String, value: Schema.Int });
  let active = 0;
  let maximum = 0;
  const task = Task.make(
    {
      error: Schema.Never,
      id: "work",
      input: Target,
      replay: "idempotent",
      success: Schema.Int,
      version: 1,
    },
    (item) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          active += 1;
          maximum = Math.max(maximum, active);
        }),
        () => Effect.sleep(item.value * 20).pipe(Effect.as(item.value)),
        () =>
          Effect.sync(() => {
            active -= 1;
          })
      )
  );
  const child = Workflow.make(
    {
      error: Schema.Never,
      execution: { concurrency: 1 },
      id: "child",
      input: Target,
      success: Schema.Int,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      const input = yield* graph.input(Target);
      return yield* graph.task("task", task, input);
    })
  );
  const Items = Schema.Array(Target);
  const flow = Workflow.make(
    {
      error: Schema.Never,
      execution: { concurrency: 2 },
      id: "fanout",
      input: Items,
      success: Schema.Array(Schema.Int),
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      const items = yield* graph.input(Items);
      // oxlint-disable-next-line unicorn/no-array-for-each -- This declares a durable graph operator.
      return yield* graph.forEach(
        "items",
        items,
        {
          concurrency: 3,
          item: Target,
          key: (item) => item.id,
          maxItems: 10,
          success: Schema.Int,
        },
        (item) =>
          Effect.gen(function* () {
            const itemGraph = yield* Workflow.Builder;
            return yield* itemGraph.workflow("child", child, item);
          })
      );
    })
  );
  return withHost(
    Application.make({ tasks: [task], workflows: [flow] }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const run = yield* runner.submit(
        {
          input: [
            { id: "slow", value: 3 },
            { id: "fast", value: 1 },
            { id: "middle", value: 2 },
          ],
          kind: "workflow",
          requestKey: "items",
          targetId: flow.id,
        },
        "owner"
      );
      const result = yield* settle(run.runId);
      expect(result.status).toBe("Succeeded");
      expect(result.result).toEqual([3, 1, 2]);
      expect(maximum).toBe(2);
    })
  );
}, 15_000);

test("answering a concurrent gate does not replay an in-flight manual sibling", () => {
  let calls = 0;
  let active = false;
  const task = Task.make(
    {
      error: Schema.Never,
      id: "manual",
      input: Schema.Null,
      replay: "manual",
      success: Schema.String,
      version: 1,
    },
    () =>
      Effect.gen(function* () {
        calls += 1;
        active = true;
        yield* Effect.sleep("400 millis");
        active = false;
        return "done";
      })
  );
  const flow = Workflow.make(
    {
      error: Schema.Never,
      id: "concurrent-gate",
      input: Schema.Null,
      success: Schema.String,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      yield* graph.approval("approval", {
        prompt: "Approve?",
        timeout: "1 minute",
      });
      return yield* graph.task("manual", task, null);
    })
  );
  return withHost(
    Application.make({ tasks: [task], workflows: [flow] }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "gate",
          targetId: flow.id,
        },
        "owner"
      );
      let answeredWhileRunning = false;
      for (let index = 0; index < 100; index += 1) {
        const [wait] = yield* store.listWaits(run.runId);
        if (wait && active) {
          answeredWhileRunning = true;
          yield* runner.settle(
            {
              operation: "approve",
              requestKey: "approved",
              waitId: wait.waitId,
            },
            "owner"
          );
          break;
        }
        yield* Effect.sleep("10 millis");
      }
      const result = yield* settle(run.runId);
      expect(result.status).toBe("Succeeded");
      expect(result.result).toBe("done");
      expect(calls).toBe(1);
      expect(answeredWhileRunning).toBe(true);
    })
  );
}, 15_000);

test("a short durable sleep can wake without interrupting a manual sibling", () => {
  let calls = 0;
  const task = Task.make(
    {
      error: Schema.Never,
      id: "manual-sleep",
      input: Schema.Null,
      replay: "manual",
      success: Schema.String,
      version: 1,
    },
    () =>
      Effect.gen(function* () {
        calls += 1;
        yield* Effect.sleep("350 millis");
        return "done";
      })
  );
  const flow = Workflow.make(
    {
      error: Schema.Never,
      id: "sleep",
      input: Schema.Null,
      success: Schema.String,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      yield* graph.sleep("short", "50 millis");
      return yield* graph.task("manual", task, null);
    })
  );
  return withHost(
    Application.make({ tasks: [task], workflows: [flow] }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "sleep",
          targetId: flow.id,
        },
        "owner"
      );
      const result = yield* settle(run.runId);
      expect(result.status).toBe("Succeeded");
      expect(calls).toBe(1);
    })
  );
}, 15_000);

test.each(["reject", "cancel", "expire"] as const)(
  "%s closes sibling waits and quiesces manual work before the terminal projection",
  (operation) => {
    let active = false;
    let calls = 0;
    const task = Task.make(
      {
        error: Schema.Never,
        id: "long-manual",
        input: Schema.Null,
        replay: "manual",
        success: Schema.String,
        version: 1,
      },
      () =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            calls += 1;
            active = true;
          }),
          () => Effect.never,
          () =>
            Effect.sync(() => {
              active = false;
            })
        )
    );
    const flow = Workflow.make(
      {
        error: Schema.Never,
        id: "reject",
        input: Schema.Null,
        success: Schema.String,
        version: 1,
      },
      Effect.gen(function* () {
        const graph = yield* Workflow.Builder;
        yield* graph.approval("review", {
          prompt: "Approve?",
          timeout: "1 minute",
        });
        yield* graph.requestInput("unused", {
          prompt: "Input?",
          schema: Schema.String,
          timeout: "1 minute",
        });
        return yield* graph.task("manual", task, null);
      })
    );
    return withHost(
      Application.make({ tasks: [task], workflows: [flow] }),
      Effect.gen(function* () {
        const runner = yield* Runner;
        const store = yield* HostStore;
        const run = yield* runner.submit(
          {
            input: null,
            kind: "workflow",
            requestKey: "reject",
            targetId: flow.id,
          },
          "owner"
        );
        for (let index = 0; index < 100; index += 1) {
          const wait = (yield* store.listWaits(run.runId)).find(
            (item) => item.kind === "approval"
          );
          if (wait && active) {
            if (operation === "cancel") {
              yield* store.cancel(run.runId);
            } else if (operation === "expire") {
              yield* store.expire(wait.deadline);
            } else {
              yield* runner.settle(
                {
                  operation: "reject",
                  requestKey: "rejected",
                  waitId: wait.waitId,
                },
                "owner"
              );
            }
            break;
          }
          yield* Effect.sleep("10 millis");
        }
        const result = yield* settle(run.runId);
        expect(result.status).toBe(
          (
            {
              cancel: "Cancelled",
              expire: "TimedOut",
              reject: "Rejected",
            } as const
          )[operation]
        );
        expect(active).toBe(false);
        expect(calls).toBe(1);
        expect(
          (yield* store.listWaits(run.runId)).every(
            (wait) => wait.status !== "Open"
          )
        ).toBe(true);
      })
    );
  },
  15_000
);

test("duplicate fan-out keys fail before any item handler starts", () => {
  let calls = 0;
  const task = Task.make(
    {
      error: Schema.Never,
      id: "duplicate-item",
      input: Schema.String,
      replay: "idempotent",
      success: Schema.String,
      version: 1,
    },
    (value) =>
      Effect.sync(() => {
        calls += 1;
        return value;
      })
  );
  const Items = Schema.Array(Schema.String);
  const flow = Workflow.make(
    {
      error: Schema.Never,
      id: "duplicate-keys",
      input: Items,
      success: Items,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      const input = yield* graph.input(Items);
      // oxlint-disable-next-line unicorn/no-array-for-each -- This declares a durable graph operator.
      return yield* graph.forEach(
        "items",
        input,
        {
          concurrency: 2,
          item: Schema.String,
          key: (value) => value,
          maxItems: 10,
          success: Schema.String,
        },
        (value) =>
          Effect.gen(function* () {
            const item = yield* Workflow.Builder;
            return yield* item.task("task", task, value);
          })
      );
    })
  );
  return withHost(
    Application.make({ tasks: [task], workflows: [flow] }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const run = yield* runner.submit(
        {
          input: ["same", "same"],
          kind: "workflow",
          requestKey: "duplicates",
          targetId: flow.id,
        },
        "owner"
      );
      expect((yield* settle(run.runId)).status).toBe("Failed");
      expect(calls).toBe(0);
    })
  );
}, 15_000);

test("an oversized task result becomes a bounded host failure without replaying a manual handler", () => {
  let calls = 0;
  const task = Task.make(
    {
      error: Schema.Never,
      id: "oversized-result",
      input: Schema.Null,
      replay: "manual",
      success: Schema.String,
      version: 1,
    },
    () =>
      Effect.sync(() => {
        calls += 1;
        return "x".repeat(1_048_576);
      })
  );
  return withHost(
    Application.make({ tasks: [task] }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const receipt = yield* runner.submit(
        {
          input: null,
          kind: "task",
          requestKey: "oversized",
          targetId: task.id,
        },
        "owner"
      );
      const result = yield* settle(receipt.runId);
      expect(result.status).toBe("Failed");
      expect(result.error).toHaveProperty("code", "LimitExceeded");
      expect(result.result).toBeNull();
      expect(calls).toBe(1);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
    })
  );
}, 15_000);

test("task Effect logs are attributed and native output inspection pages by byte budget", () => {
  let executions = 0;
  const task = Task.make(
    {
      error: Schema.Never,
      id: "inspection/task",
      input: Schema.String,
      replay: "manual",
      success: Schema.String,
      version: 1,
    },
    (input, context) =>
      Effect.gen(function* () {
        executions += 1;
        yield* Effect.logInfo("Starting", { input });
        yield* context.progress({ message: "Building output" });
        yield* Effect.logWarning("Completed");
        return input.repeat(800_000);
      })
  );
  const workflow = Workflow.make(
    {
      error: Schema.Never,
      id: "inspection/workflow",
      input: Schema.Null,
      success: Schema.Null,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      yield* graph.task("a", task, "a");
      yield* graph.task("b", task, "b");
      yield* graph.task("c", task, "c");
      return null;
    })
  );
  return withHost(
    Application.make({ tasks: [task], workflows: [workflow] }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "inspection",
          targetId: workflow.id,
        },
        "owner"
      );
      expect((yield* settle(run.runId)).status).toBe("Succeeded");
      const logs = yield* store.logPage(
        { level: "Warn", runId: run.runId },
        "owner"
      );
      expect(logs.items).toHaveLength(3);
      expect(new Set(logs.items.map((log) => log.nodeId)).size).toBe(3);
      expect(logs.items[0]?.message).toEqual(["Completed"]);
      expect(logs.items[0]?.attempt).toBe(1);
      const first = yield* runOutputs({ runId: run.runId }, "owner");
      expect(first.items).toHaveLength(2);
      expect(
        first.items.every(
          (item) =>
            item.status === "Succeeded" &&
            typeof item.result === "string" &&
            item.result.length === 800_000
        )
      ).toBe(true);
      if (first.cursor === null) {
        return yield* Effect.die("Expected output cursor");
      }
      const second = yield* runOutputs(
        { cursor: first.cursor, runId: run.runId },
        "owner"
      );
      expect(second.items).toHaveLength(1);
      expect(second.cursor).toBeNull();
      expect(
        new Set([...first.items, ...second.items].map((item) => item.nodeId))
          .size
      ).toBe(3);
      expect(executions).toBe(3);
      expect(
        (yield* Effect.result(runOutputs({ runId: run.runId }, "other")))._tag
      ).toBe("Failure");
    })
  );
});
