import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Application, Report, Task, Workflow } from "@offtree/effectory-sdk";
import { Context, Deferred, Effect, Fiber, Layer, Schema } from "effect";
import type { Scope } from "effect";
import type { MessageStorage } from "effect/cluster/MessageStorage";
import type { WorkflowEngine } from "effect/workflow/WorkflowEngine";

import { catalogLayer } from "../src/catalog.ts";
import { ExecutionResources } from "../src/execution-resources.ts";
import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { execution } from "../src/interpreter.ts";
import type { Lake } from "../src/lake.ts";
import { Runner, tick } from "../src/runner.ts";

type Services =
  | MessageStorage
  | typeof Runner.Service
  | typeof HostStore.Service
  | typeof ExecutionResources.Service
  | typeof Lake.Service
  | WorkflowEngine
  | Scope.Scope;
async function withHost<A, E>(
  app: Application.Application<never>,
  body: Effect.Effect<A, E, Services>
) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-wake-status-")
  );
  const catalog = Layer.unwrap(
    Effect.map(Application.Registry, (registry) =>
      catalogLayer("pinned", new Map([["pinned", registry]]))
    )
  ).pipe(Layer.provide(app.layer));
  try {
    return await Effect.runPromise(
      body.pipe(
        Effect.timeout("10 seconds"),
        Effect.scoped,
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
function until<E, R>(condition: Effect.Effect<boolean, E, R>) {
  return Effect.gen(function* () {
    for (;;) {
      if (yield* condition) {
        return;
      }
      yield* Effect.sleep("10 millis");
    }
  });
}

test.each(["sleep", "retry"] as const)(
  "%s wake projects Running through the handler and Layer cleanup",
  async (mode) => {
    const entered = Deferred.makeUnsafe<boolean>();
    const finish = Deferred.makeUnsafe<boolean>();
    const cleaning = Deferred.makeUnsafe<boolean>();
    const release = Deferred.makeUnsafe<boolean>();
    const Resource = Context.Service<number>(`wake/${mode}`);
    const Again = Schema.TaggedStruct("Again", {});
    let acquired = 0;
    let released = 0;
    let calls = 0;
    const task = Task.make(
      {
        error: Again,
        id: "work",
        input: Schema.Null,
        replay: "idempotent",
        success: Schema.Null,
        version: 1,
      },
      (_, context) =>
        Effect.gen(function* () {
          yield* Resource;
          calls += 1;
          if (mode === "retry" && context.attempt === 1) {
            return yield* Effect.fail({ _tag: "Again" as const });
          }
          yield* Deferred.succeed(entered, true);
          yield* Deferred.await(finish);
          return null;
        })
    ).provide(
      Layer.effect(
        Resource,
        Effect.acquireRelease(
          Effect.sync(() => {
            acquired += 1;
            return acquired;
          }),
          (entry) =>
            Effect.gen(function* () {
              if (mode === "sleep" || entry === 2) {
                yield* Deferred.succeed(cleaning, true);
                yield* Deferred.await(release);
              }
              released += 1;
            })
        )
      )
    );
    const flow = Workflow.make(
      {
        error: Again,
        id: "wake",
        input: Schema.Null,
        success: Schema.Null,
        version: 1,
      },
      Effect.gen(function* () {
        const g = yield* Workflow.Builder;
        const delay = yield* g.sleep("delay", "200 millis");
        return yield* g.task("work", task, null, {
          after: [delay],
          ...(mode === "retry"
            ? { retry: { attempts: 2, delay: "200 millis", when: ["Again"] } }
            : {}),
        });
      })
    );
    await withHost(
      Application.make({ tasks: [task], workflows: [flow] }),
      Effect.gen(function* () {
        const runner = yield* Runner;
        const store = yield* HostStore;
        const resources = yield* ExecutionResources;
        const run = yield* runner.submit(
          {
            input: null,
            kind: "workflow",
            requestKey: "wake",
            targetId: flow.id,
          },
          "owner"
        );
        yield* until(
          store
            .getRun(run.runId)
            .pipe(Effect.map((current) => current.status === "Waiting"))
        );
        yield* Deferred.await(entered);
        yield* tick;
        expect((yield* store.getRun(run.runId)).status).toBe("Running");
        expect(resources.active(run.runId)).toBe(1);
        yield* Deferred.succeed(finish, true);
        yield* Deferred.await(cleaning);
        yield* tick;
        expect((yield* store.getRun(run.runId)).status).toBe("Running");
        expect(resources.active(run.runId)).toBe(1);
        yield* Deferred.succeed(release, true);
        yield* until(
          store
            .getRun(run.runId)
            .pipe(Effect.map((current) => current.status === "Succeeded"))
        );
        expect(resources.active(run.runId)).toBe(0);
        expect(calls).toBe(mode === "sleep" ? 1 : 2);
        expect(released).toBe(acquired);
      }).pipe(
        Effect.ensuring(
          Effect.all([
            Deferred.succeed(finish, true),
            Deferred.succeed(release, true),
          ])
        )
      )
    );
  }
);

test.each(["finish", "cancel"] as const)(
  "retry queued for global capacity projects Running and can %s without leaking work",
  async (mode) => {
    const failed = Deferred.makeUnsafe<boolean>();
    const taken = Deferred.makeUnsafe<boolean>();
    const release = Deferred.makeUnsafe<boolean>();
    const Again = Schema.TaggedStruct("Again", {});
    let calls = 0;
    const task = Task.make(
      {
        error: Again,
        id: "retry",
        input: Schema.Null,
        replay: "idempotent",
        success: Schema.Null,
        version: 1,
      },
      (_, context) =>
        Effect.gen(function* () {
          calls += 1;
          if (context.attempt === 1) {
            yield* Deferred.succeed(failed, true);
            return yield* Effect.fail({ _tag: "Again" as const });
          }
          return null;
        })
    );
    const flow = Workflow.make(
      {
        error: Again,
        id: "queued",
        input: Schema.Null,
        success: Schema.Null,
        version: 1,
      },
      Effect.gen(function* () {
        const g = yield* Workflow.Builder;
        return yield* g.task("retry", task, null, {
          retry: { attempts: 2, delay: "400 millis", when: ["Again"] },
        });
      })
    );
    await withHost(
      Application.make({ tasks: [task], workflows: [flow] }),
      Effect.gen(function* () {
        const resources = yield* ExecutionResources;
        const store = yield* HostStore;
        const runner = yield* Runner;
        const run = yield* runner.submit(
          {
            input: null,
            kind: "workflow",
            requestKey: "queue",
            targetId: flow.id,
          },
          "owner"
        );
        yield* Deferred.await(failed);
        const holder = yield* Effect.forkScoped(
          resources.global.withPermits(32)(
            Deferred.succeed(taken, true).pipe(
              Effect.andThen(Deferred.await(release))
            )
          )
        );
        yield* Deferred.await(taken);
        yield* until(Effect.sync(() => resources.working(run.runId) === 0));
        yield* until(Effect.sync(() => resources.working(run.runId) === 1));
        yield* tick;
        const current = yield* store.getRun(run.runId);
        expect(current.status).toBe("Running");
        expect(resources.active(run.runId)).toBe(0);
        expect(calls).toBe(1);
        if (current.engineId === null) {
          return yield* Effect.die("Missing engine id");
        }
        expect(yield* execution.poll(current.engineId)).toMatchObject({
          _tag: "Some",
          value: { _tag: "Suspended" },
        });
        if (mode === "cancel") {
          yield* store.cancel(run.runId);
          yield* until(
            store
              .getRun(run.runId)
              .pipe(Effect.map((value) => value.status === "Cancelled"))
          );
          // The queued entry must interrupt without needing the unavailable permits.
          expect(resources.working(run.runId)).toBe(0);
          expect(calls).toBe(1);
        }
        yield* Deferred.succeed(release, true);
        yield* Fiber.join(holder);
        if (mode === "finish") {
          yield* until(
            store
              .getRun(run.runId)
              .pipe(Effect.map((value) => value.status === "Succeeded"))
          );
          expect(calls).toBe(2);
        }
        expect(resources.working(run.runId)).toBe(0);
        expect(resources.active(run.runId)).toBe(0);
      }).pipe(Effect.ensuring(Deferred.succeed(release, true)))
    );
  }
);

test("report permit queues are invocation work and report status stays synchronized", async () => {
  const taken = Deferred.makeUnsafe<boolean>();
  const release = Deferred.makeUnsafe<boolean>();
  let calls = 0;
  const source = Task.make(
    {
      error: Schema.Never,
      id: "source",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.Null,
      version: 1,
    },
    () => Effect.succeed(null)
  );
  const reporter = Task.make(
    {
      error: Schema.Never,
      id: "reporter",
      input: Report.sourceOf(source),
      replay: "idempotent",
      success: Report.result(Schema.Null),
      version: 1,
    },
    () =>
      Effect.sync(() => {
        calls += 1;
        return { data: null, markdown: "done" };
      })
  );
  await withHost(
    Application.make({
      reports: [
        Report.make({
          id: "report",
          scope: "run",
          target: source,
          task: reporter,
        }),
      ],
      tasks: [source, reporter],
    }),
    Effect.gen(function* () {
      const store = yield* HostStore;
      const runner = yield* Runner;
      const resources = yield* ExecutionResources;
      const holder = yield* Effect.forkScoped(
        resources.reports.withPermits(4)(
          Deferred.succeed(taken, true).pipe(
            Effect.andThen(Deferred.await(release))
          )
        )
      );
      yield* Deferred.await(taken);
      const root = yield* runner.submit(
        {
          input: null,
          kind: "task",
          requestKey: "report",
          targetId: source.id,
        },
        "owner"
      );
      let reportId = "";
      let runId = "";
      yield* until(
        Effect.gen(function* () {
          const [id] = yield* store.reportIds(root.runId);
          if (id === undefined) {
            return false;
          }
          reportId = id;
          const record = yield* store.reportGet(id);
          runId = record.reportRunId ?? "";
          return runId !== "" && resources.working(runId) === 1;
        })
      );
      yield* tick;
      expect((yield* store.getRun(runId)).status).toBe("Running");
      expect((yield* store.reportGet(reportId)).reportRunStatus).toBe(
        "Running"
      );
      const sequence = (yield* store.getRun(runId)).lastSequence;
      yield* tick;
      yield* tick;
      expect((yield* store.getRun(runId)).lastSequence).toBe(sequence);
      expect(resources.active(runId)).toBe(0);
      expect(calls).toBe(0);
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(holder);
      yield* until(
        store
          .getRun(runId)
          .pipe(Effect.map((value) => value.status === "Succeeded"))
      );
      expect((yield* store.reportGet(reportId)).reportRunStatus).toBe(
        "Succeeded"
      );
      expect(calls).toBe(1);
      expect(resources.working(runId)).toBe(0);
    }).pipe(Effect.ensuring(Deferred.succeed(release, true)))
  );
});

test("workflow permit queue and sibling approval stay Running until work drains", async () => {
  const finish = Deferred.makeUnsafe<boolean>();
  let calls = 0;
  const task = Task.make(
    {
      error: Schema.Never,
      id: "serial",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.Null,
      version: 1,
    },
    () =>
      Effect.sync(() => {
        calls += 1;
      }).pipe(Effect.andThen(Deferred.await(finish)), Effect.as(null))
  );
  const flow = Workflow.make(
    {
      error: Schema.Never,
      execution: { concurrency: 1 },
      id: "siblings",
      input: Schema.Null,
      success: Schema.Null,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      const delay = yield* graph.sleep("delay", "100 millis");
      yield* graph.approval("review", {
        after: [delay],
        prompt: "Continue?",
        timeout: "1 hour",
      });
      yield* graph.task("first", task, null, { after: [delay] });
      return yield* graph.task("second", task, null, { after: [delay] });
    })
  );
  await withHost(
    Application.make({ tasks: [task], workflows: [flow] }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const resources = yield* ExecutionResources;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "siblings",
          targetId: flow.id,
        },
        "owner"
      );
      yield* until(
        Effect.sync(() => resources.working(run.runId) === 2 && calls === 1)
      );
      yield* tick;
      expect((yield* store.getRun(run.runId)).status).toBe("Running");
      expect(resources.active(run.runId)).toBe(1);
      yield* Deferred.succeed(finish, true);
      yield* until(
        store
          .getRun(run.runId)
          .pipe(Effect.map((snapshot) => snapshot.status === "Waiting"))
      );
      expect(calls).toBe(2);
      expect(resources.working(run.runId)).toBe(0);
      yield* store.cancel(run.runId);
      yield* until(
        store
          .getRun(run.runId)
          .pipe(Effect.map((snapshot) => snapshot.status === "Cancelled"))
      );
    }).pipe(Effect.ensuring(Deferred.succeed(finish, true)))
  );
});

test("a durable timer without tasks waits without inventing invocation work", async () => {
  const flow = Workflow.make(
    {
      error: Schema.Never,
      id: "timer-only",
      input: Schema.Null,
      success: Schema.Null,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      const slept = yield* graph.sleep("delay", "300 millis");
      return yield* graph.map(
        "result",
        { input: slept, success: Schema.Null },
        () => null
      );
    })
  );
  await withHost(
    Application.make({ workflows: [flow] }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const resources = yield* ExecutionResources;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "timer",
          targetId: flow.id,
        },
        "owner"
      );
      yield* until(
        store
          .getRun(run.runId)
          .pipe(Effect.map((snapshot) => snapshot.status === "Waiting"))
      );
      expect(resources.working(run.runId)).toBe(0);
      yield* until(
        store
          .getRun(run.runId)
          .pipe(Effect.map((snapshot) => snapshot.status === "Succeeded"))
      );
      expect(resources.working(run.runId)).toBe(0);
      expect(resources.active(run.runId)).toBe(0);
    })
  );
});
