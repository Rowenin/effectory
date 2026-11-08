import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { terminal } from "@effectory/runtime/protocol";
import { Application, Report, Task, Workflow } from "@offtree/effectory-sdk";
import { Effect, Layer, Schema } from "effect";
import type { MessageStorage } from "effect/cluster/MessageStorage";
import type { SqlClient } from "effect/sql/SqlClient";
import type { WorkflowEngine } from "effect/workflow/WorkflowEngine";

import { catalogLayer } from "../src/catalog.ts";
import { ExecutionResources } from "../src/execution-resources.ts";
import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { runOutputs } from "../src/run-outputs.ts";
import { Runner } from "../src/runner.ts";

async function withHost<A, E>(
  app: Application.Application<never>,
  body: Effect.Effect<
    A,
    E,
    | typeof Runner.Service
    | typeof HostStore.Service
    | typeof ExecutionResources.Service
    | WorkflowEngine
    | MessageStorage
    | SqlClient
  >
) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-report-reconciliation-")
  );
  const catalog = Layer.unwrap(
    Effect.map(Application.Registry, (registry) =>
      catalogLayer("pinned", new Map([["pinned", registry]]))
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

const eventually = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean
) =>
  Effect.gen(function* () {
    for (let index = 0; index < 400; index += 1) {
      const value = yield* read;
      if (predicate(value)) {
        return value;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die("Report source did not reach expected state");
  });
const reporter = Task.make(
  {
    error: Schema.Never,
    id: "summary",
    input: Report.Source,
    replay: "idempotent",
    success: Report.result(Schema.Null),
    version: 1,
  },
  () => Effect.succeed({ data: null, markdown: "summary" })
);

test("a successful invocation becomes reportable while its root waits for approval", async () => {
  let calls = 0;
  const task = Task.make(
    {
      error: Schema.Never,
      id: "work",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.String,
      version: 1,
    },
    () =>
      Effect.sync(() => {
        calls += 1;
        return "done";
      })
  );
  const flow = Workflow.make(
    {
      error: Schema.Never,
      id: "flow",
      input: Schema.Null,
      success: Schema.String,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      const work = yield* graph.task("work", task, null);
      yield* graph.approval("review", {
        after: [work],
        prompt: "Review",
        timeout: "1 minute",
      });
      return work;
    })
  );
  const reports = [
    Report.make({ id: "root", target: flow, task: reporter }),
    ...Array.from({ length: 16 }, (_, index) =>
      Report.make({
        id: `leaf-${index}`,
        scope: "invocation",
        target: task,
        task: reporter,
      })
    ),
  ];
  return await withHost(
    Application.make({ reports, tasks: [task, reporter], workflows: [flow] }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "waiting",
          targetId: "flow",
        },
        "owner"
      );
      const ready = yield* eventually(
        store.reportPendingSources("Materialized"),
        (rows) => rows.length === 1
      );
      expect(ready[0]?.source).toMatchObject({
        revision: "pinned",
        scope: "invocation",
        status: "Succeeded",
        targetId: "work",
      });
      expect(
        (yield* store.reportPendingSources("Armed"))[0]?.source.scope
      ).toBe("run");
      yield* eventually(
        store.getRun(run.runId),
        (value) => value.status === "Waiting"
      );
      expect(calls).toBe(1);
      yield* store.cancel(run.runId);
      yield* eventually(store.getRun(run.runId), (value) =>
        terminal.has(value.status)
      );
      const settled = yield* store.reportPendingSources("Materialized");
      expect(settled).toHaveLength(2);
      expect(
        settled.find((row) => row.invocationId !== null)?.source.status
      ).toBe("Succeeded");
      expect(
        settled.find((row) => row.invocationId === null)?.source.status
      ).toBe("Cancelled");
    })
  );
}, 10_000);

test.each(["reject", "cancel", "expire"] as const)(
  "%s maps interrupted task sources consistently with run outputs",
  async (operation) => {
    let active = false;
    const task = Task.make(
      {
        error: Schema.Never,
        id: "work",
        input: Schema.Null,
        replay: "idempotent",
        success: Schema.Null,
        version: 1,
      },
      () =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
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
        id: "flow",
        input: Schema.Null,
        success: Schema.Null,
        version: 1,
      },
      Effect.gen(function* () {
        const graph = yield* Workflow.Builder;
        yield* graph.approval("review", {
          prompt: "Review",
          timeout: "1 minute",
        });
        return yield* graph.task("work", task, null);
      })
    );
    return await withHost(
      Application.make({
        reports: [
          Report.make({
            id: "leaf",
            scope: "invocation",
            target: task,
            task: reporter,
          }),
        ],
        tasks: [task, reporter],
        workflows: [flow],
      }),
      Effect.gen(function* () {
        const runner = yield* Runner;
        const store = yield* HostStore;
        const run = yield* runner.submit(
          {
            input: null,
            kind: "workflow",
            requestKey: operation,
            targetId: "flow",
          },
          "owner"
        );
        const waits = yield* eventually(
          store.listWaits(run.runId),
          (values) => active && values.length === 1
        );
        const [wait] = waits;
        if (!wait) {
          return yield* Effect.die("Missing approval");
        }
        if (operation === "cancel") {
          yield* store.cancel(run.runId);
        } else if (operation === "expire") {
          yield* store.expire(wait.deadline);
        } else {
          yield* runner.settle(
            { operation: "reject", requestKey: "reject", waitId: wait.waitId },
            "owner"
          );
        }
        const ready = yield* eventually(
          store.reportPendingSources("Materialized"),
          (values) => values.length === 1
        );
        const status = operation === "expire" ? "TimedOut" : "Cancelled";
        expect(ready[0]?.source.status).toBe(status);
        expect(ready[0]?.ineligibleReason).toBeNull();
        expect(active).toBe(false);
        const outputs = yield* runOutputs({ runId: run.runId }, "owner");
        expect(outputs.items[0]?.status).toBe(status);
        expect(outputs.items[0]?.error).toMatchObject({
          category: "Control",
          detail: { stoppedBy: operation === "reject" ? "Rejected" : status },
        });
      })
    );
  },
  10_000
);

test("a terminal source without native execution is never dispatched to manufacture a report outcome", async () => {
  let calls = 0;
  const task = Task.make(
    {
      error: Schema.Never,
      id: "work",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.Null,
      version: 1,
    },
    () =>
      Effect.sync(() => {
        calls += 1;
        return null;
      })
  );
  return await withHost(
    Application.make({
      reports: [
        Report.make({
          id: "leaf",
          scope: "invocation",
          target: task,
          task: reporter,
        }),
      ],
      tasks: [task, reporter],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "task",
          requestKey: "never-dispatched",
          targetId: "work",
        },
        "owner"
      );
      yield* store.registerInvocation(run.runId, "never", "missing-native", {
        taskId: "work",
      });
      yield* store.project(run.runId, "Failed", null, "Defect");
      const ready = yield* eventually(
        store.reportPendingSources("Materialized"),
        (values) => values.length === 1
      );
      expect(ready[0]?.ineligibleReason).toBe("NoNativeExecution");
      expect(ready[0]?.source.status).toBeNull();
      expect(calls).toBe(0);
    })
  );
}, 10_000);

test.each(["Domain", "Host"] as const)(
  "root reports retain the %s category instead of guessing from error JSON",
  async (category) => {
    const Error = Schema.TaggedStruct("DomainError", {
      message: Schema.String,
    });
    const task = Task.make(
      {
        error: Error,
        id: "work",
        input: Schema.Null,
        replay: "idempotent",
        success: Schema.String,
        version: 1,
      },
      () =>
        category === "Domain"
          ? Effect.fail({ _tag: "DomainError" as const, message: "failed" })
          : Effect.succeed("x".repeat(1_048_576))
    );
    return await withHost(
      Application.make({
        reports: [
          Report.make({
            id: "root",
            scope: "run",
            target: task,
            task: reporter,
          }),
        ],
        tasks: [task, reporter],
      }),
      Effect.gen(function* () {
        const runner = yield* Runner;
        const store = yield* HostStore;
        const run = yield* runner.submit(
          { input: null, kind: "task", requestKey: category, targetId: "work" },
          "owner"
        );
        const ready = yield* eventually(
          store.reportPendingSources("Materialized"),
          (values) => values.length === 1
        );
        expect(ready[0]?.failureCategory).toBe(category);
        expect(ready[0]?.source.status).toBe("Failed");
        expect((yield* store.getRun(run.runId)).status).toBe("Failed");
      })
    );
  },
  10_000
);

test("domain retries settle one logical report source after the final attempt", async () => {
  let calls = 0;
  const Transient = Schema.TaggedStruct("Transient", {});
  const task = Task.make(
    {
      error: Transient,
      id: "work",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.String,
      version: 1,
    },
    () =>
      Effect.suspend(() => {
        calls += 1;
        return calls === 1
          ? Effect.fail({ _tag: "Transient" as const })
          : Effect.succeed("recovered");
      })
  );
  const flow = Workflow.make(
    {
      error: Transient,
      id: "flow",
      input: Schema.Null,
      success: Schema.String,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      return yield* graph.task("work", task, null, {
        retry: { attempts: 2, delay: "10 millis", when: ["Transient"] },
      });
    })
  );
  return await withHost(
    Application.make({
      reports: [
        Report.make({
          id: "leaf",
          scope: "invocation",
          target: task,
          task: reporter,
        }),
      ],
      tasks: [task, reporter],
      workflows: [flow],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "retry",
          targetId: "flow",
        },
        "owner"
      );
      const ready = yield* eventually(
        store.reportPendingSources("Materialized"),
        (values) => values.length === 1
      );
      const [source] = ready;
      if (source === undefined || source.invocationId === null) {
        return yield* Effect.die("Missing settled invocation");
      }
      expect(source.source.status).toBe("Succeeded");
      expect(calls).toBe(2);
      expect(
        (yield* store.reportInvocationDetails(run.runId, source.invocationId))
          .attemptCount
      ).toBe(2);
    })
  );
}, 10_000);

test("a deadline before the first admitted attempt records NotStarted without invoking a handler", async () => {
  let calls = 0;
  const task = Task.make(
    {
      error: Schema.Never,
      id: "work",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.Null,
      version: 1,
    },
    () =>
      Effect.sync(() => {
        calls += 1;
        return null;
      })
  );
  const flow = Workflow.make(
    {
      error: Schema.Never,
      execution: { timeout: "1 second" },
      id: "flow",
      input: Schema.Null,
      success: Schema.Null,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      return yield* graph.task("work", task, null);
    })
  );
  return await withHost(
    Application.make({
      reports: [
        Report.make({
          id: "leaf",
          scope: "invocation",
          target: task,
          task: reporter,
        }),
      ],
      tasks: [task, reporter],
      workflows: [flow],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const resources = yield* ExecutionResources;
      return yield* resources.global.withPermits(32)(
        Effect.gen(function* () {
          yield* runner.submit(
            {
              input: null,
              kind: "workflow",
              requestKey: "deadline-before-attempt",
              targetId: "flow",
            },
            "owner"
          );
          const ready = yield* eventually(
            store.reportPendingSources("Materialized"),
            (values) => values.length === 1
          );
          expect(ready[0]?.source.status).toBe("TimedOut");
          expect(ready[0]?.ineligibleReason).toBe("NotStarted");
          expect(calls).toBe(0);
        })
      );
    })
  );
}, 10_000);
