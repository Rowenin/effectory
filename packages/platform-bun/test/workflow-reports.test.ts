import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Application,
  Artifact,
  ArtifactStorage,
  Extension,
  Ref,
  Report,
  Task,
  Workflow,
  WorkflowPatch,
} from "@offtree/effectory-sdk";
import { Effect, Layer, Schema, Option } from "effect";
import type { MessageStorage } from "effect/cluster";
import { WorkflowEngine } from "effect/workflow/WorkflowEngine";

import { catalogLayer } from "../src/catalog.ts";
import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { pollWorkflowInvocation } from "../src/interpreter.ts";
import { normalizeWorkflowInvocation } from "../src/invocation-outcome.ts";
import { Runner } from "../src/runner.ts";

async function withHost<A, E>(
  app: Application.Application<never>,
  body: Effect.Effect<
    A,
    E,
    | typeof Runner.Service
    | typeof HostStore.Service
    | WorkflowEngine
    | MessageStorage.MessageStorage
  >
) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-report-execution-")
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
const awaitReports = (runId: string, count: number) =>
  Effect.gen(function* () {
    const store = yield* HostStore;
    for (let index = 0; index < 800; index += 1) {
      const records = yield* Effect.forEach(
        yield* store.reportIds(runId),
        (id) => store.reportGet(id)
      );
      if (
        records.length === count &&
        records.every((record) =>
          ["Succeeded", "Failed", "Cancelled", "NotApplicable"].includes(
            record.status
          )
        )
      ) {
        return records;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die("Reports did not finish");
  });

const artifact = Artifact.make({
  id: "child-value",
  schema: Schema.Number,
  version: 1,
});
const leaf = Task.make(
  {
    error: Schema.Never,
    id: "child-leaf",
    input: Schema.Number,
    outputs: { value: artifact },
    replay: "idempotent",
    success: Schema.Number,
    version: 1,
  },
  (value) =>
    Effect.gen(function* () {
      yield* Effect.log(`child log ${value}`);
      const storage = yield* ArtifactStorage;
      yield* storage.publish(artifact, value, { key: "value" });
      return value + 1;
    })
);
const child = Workflow.make(
  {
    error: Schema.Never,
    execution: { timeout: "30 seconds" },
    id: "child",
    input: Schema.Number,
    success: Schema.Number,
    version: 1,
  },
  Effect.gen(function* () {
    const g = yield* Workflow.Builder;
    return yield* g.task("leaf", leaf, yield* g.input(Schema.Number), {
      timeout: "30 seconds",
    });
  })
);
const reporter = Task.make(
  {
    error: Schema.Never,
    id: "child-summary",
    input: Report.Source,
    replay: "idempotent",
    success: Report.result(Schema.Json),
    version: 1,
  },
  () =>
    Effect.gen(function* () {
      const h = yield* Report.History;
      const outcome = yield* h.outcome();
      const tasks = [];
      let cursor: string | null = null;
      do {
        const page: Report.InvocationPage = yield* h.invocations({
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        tasks.push(...page.items.map((row) => row.pathPreview.text));
        ({ cursor } = page);
      } while (cursor);
      const events = [];
      cursor = null;
      do {
        const page: Report.EventPage = yield* h.events({
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        events.push(
          ...page.items.map((row) => ({ payload: row.payload, tag: row.tag }))
        );
        ({ cursor } = page);
      } while (cursor);
      return { data: { events, outcome, tasks }, markdown: "Child summary" };
    })
);
const attach = (target: Workflow.Definition, id = "child-summary-attachment") =>
  Report.make({ id, scope: "invocation", target, task: reporter });

test("child reports finish independently with subtree history, publications and source-workflow search", () => {
  const parent = Workflow.make(
    {
      error: Schema.Never,
      id: "parent",
      input: Schema.Null,
      success: Schema.Number,
      version: 1,
    },
    Effect.gen(function* () {
      const g = yield* Workflow.Builder;
      const first = yield* g.workflow("first", child, 41);
      const second = yield* g.workflow("first-sibling", child, 99);
      yield* g.approval("parent-gate", {
        after: [first, second],
        prompt: "Wait",
        timeout: "1 hour",
      });
      return first;
    })
  );
  return withHost(
    Application.make({
      reports: [attach(child)],
      tasks: [leaf, reporter],
      workflows: [parent],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const source = yield* runner.submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "children",
          targetId: parent.id,
        },
        "owner"
      );
      const records = yield* awaitReports(source.runId, 2);
      const cached = yield* pollWorkflowInvocation(
        { ...(yield* store.getRun(source.runId)), engineId: null },
        '["first"]'
      );
      expect(cached).toMatchObject({
        _tag: "Some",
        value: { _tag: "Complete", exit: { _tag: "Success", value: 42 } },
      });
      expect((yield* store.getRun(source.runId)).status).toBe("Waiting");
      expect(new Set(records.map((row) => row.source.invocationId)).size).toBe(
        2
      );
      for (const record of records) {
        expect(record.status).toBe("Succeeded");
        if (!record.reportRunId) {
          return yield* Effect.die("No report run");
        }
        const run = yield* store.getRun(record.reportRunId);
        const result = Schema.decodeUnknownSync(
          Schema.Struct({
            data: Schema.Struct({
              events: Schema.Array(
                Schema.Struct({ payload: Schema.Json, tag: Schema.String })
              ),
              outcome: Schema.Json,
              tasks: Schema.Array(Schema.String),
            }),
          })
        )(run.result);
        const own =
          record.pathPreview?.text === '["first"]' ? "first" : "first-sibling";
        expect(result.data.tasks).toEqual([JSON.stringify([own, "leaf"])]);
        expect(result.data.outcome).toEqual({
          _tag: "Succeeded",
          value: own === "first" ? 42 : 100,
        });
        expect(result.data.events.map((event) => event.tag)).toContain(
          "ArtifactPublished"
        );
        expect(result.data.events.map((event) => event.tag)).toContain(
          "DeadlineStarted"
        );
        expect(
          result.data.events.filter((event) => event.tag === "DeadlineStarted")
        ).toHaveLength(2);
        expect(result.data.events.map((event) => event.tag)).toContain("Log");
        expect(result.data.events.map((event) => event.tag)).not.toContain(
          "WaitOpened"
        );
        expect(JSON.stringify(result.data.events)).not.toContain(
          own === "first" ? "child log 99" : "child log 41"
        );
      }
      const page = yield* store.reportSearch(
        {
          scope: "invocation",
          sourceWorkflowId: "child",
          workflowId: "parent",
        },
        "owner"
      );
      expect(page.items).toHaveLength(2);
      expect(
        (yield* store.reportSearch({ sourceWorkflowId: "parent" }, "owner"))
          .items
      ).toHaveLength(0);
      yield* store.cancel(source.runId);
    })
  );
}, 20_000);

test("direct workflow matches both scopes, including an empty workflow with no task attempts", () => {
  const empty = Workflow.make(
    {
      error: Schema.Never,
      id: "empty",
      input: Schema.Number,
      success: Schema.Number,
      version: 1,
    },
    Effect.gen(function* () {
      const g = yield* Workflow.Builder;
      return yield* g.input(Schema.Number);
    })
  );
  return withHost(
    Application.make({
      reports: [
        attach(empty),
        Report.make({ id: "root-summary", target: empty, task: reporter }),
      ],
      tasks: [reporter],
      workflows: [empty],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        { input: 7, kind: "workflow", requestKey: "empty", targetId: empty.id },
        "owner"
      );
      const records = yield* awaitReports(run.runId, 2);
      expect(records.map((row) => row.source.scope).toSorted()).toEqual([
        "invocation",
        "run",
      ]);
      for (const record of records) {
        expect(record.status).toBe("Succeeded");
        if (!record.reportRunId) {
          return yield* Effect.die("No report");
        }
        const result = yield* store.getRun(record.reportRunId);
        expect(result.result).toMatchObject({
          data: { outcome: { _tag: "Succeeded", value: 7 }, tasks: [] },
        });
      }
    })
  );
}, 20_000);

test("entered cancelled child reports Cancelled; an activated dependency-blocked child is NotApplicable", () => {
  const sleeping = Workflow.make(
    {
      error: Schema.Never,
      id: "sleeping",
      input: Schema.Null,
      success: Schema.Null,
      version: 1,
    },
    Effect.gen(function* () {
      const g = yield* Workflow.Builder;
      yield* g.sleep("nap", "1 hour");
      return null;
    })
  );
  const parent = Workflow.make(
    {
      error: Schema.Never,
      id: "cancel-parent",
      input: Schema.Null,
      success: Schema.Null,
      version: 1,
    },
    Effect.gen(function* () {
      const g = yield* Workflow.Builder;
      const first = yield* g.workflow("entered", sleeping, null);
      yield* g.workflow("not-entered", sleeping, first);
      return null;
    })
  );
  return withHost(
    Application.make({
      reports: [attach(sleeping)],
      tasks: [reporter],
      workflows: [parent],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "cancel",
          targetId: parent.id,
        },
        "owner"
      );
      for (let i = 0; i < 500; i += 1) {
        if (
          (yield* store.reportIds(run.runId)).length === 2 &&
          (yield* store.getRun(run.runId)).status === "Waiting"
        ) {
          break;
        }
        yield* Effect.sleep("10 millis");
      }
      yield* store.cancel(run.runId);
      const records = yield* awaitReports(run.runId, 2);
      const entered = records.find(
        (row) => row.pathPreview?.text === '["entered"]'
      );
      const absent = records.find(
        (row) => row.pathPreview?.text === '["not-entered"]'
      );
      expect(entered?.source.status).toBe("Cancelled");
      expect(entered?.status).toBe("Succeeded");
      expect(absent?.status).toBe("NotApplicable");
      expect(absent?.notApplicableReason).toBe("NotStarted");
    })
  );
}, 20_000);

test("child domain failure remains its own typed outcome", () => {
  const failure = Schema.TaggedStruct("ChildFailure", {
    message: Schema.String,
  });
  const fail = Task.make(
    {
      error: failure,
      id: "fail",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.Null,
      version: 1,
    },
    () => Effect.fail({ _tag: "ChildFailure" as const, message: "child-local" })
  );
  const failing = Workflow.make(
    {
      error: failure,
      id: "failing-child",
      input: Schema.Null,
      success: Schema.Null,
      version: 1,
    },
    Effect.gen(function* () {
      const g = yield* Workflow.Builder;
      return yield* g.task("fail", fail, null);
    })
  );
  const parent = Workflow.make(
    {
      error: failure,
      id: "failing-parent",
      input: Schema.Null,
      success: Schema.Null,
      version: 1,
    },
    Effect.gen(function* () {
      const g = yield* Workflow.Builder;
      return yield* g.workflow("child", failing, null);
    })
  );
  const summary = Task.make(
    {
      error: Schema.Never,
      id: "failure-summary",
      input: Report.sourceOf(failing),
      replay: "idempotent",
      success: Report.result(Schema.String),
      version: 1,
    },
    () =>
      Effect.gen(function* () {
        const h = yield* Report.History;
        const outcome = yield* h.outcome(failing);
        return {
          data:
            outcome._tag === "DomainFailure"
              ? outcome.error.message
              : outcome._tag,
          markdown: "Failure",
        };
      })
  );
  return withHost(
    Application.make({
      reports: [
        Report.make({
          id: "failure-summary",
          scope: "invocation",
          target: failing,
          task: summary,
        }),
      ],
      tasks: [fail, summary],
      workflows: [parent],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "failed-child",
          targetId: parent.id,
        },
        "owner"
      );
      const [record] = yield* awaitReports(run.runId, 1);
      expect(record?.source.status).toBe("Failed");
      if (!record?.source.invocationId) {
        return yield* Effect.die("Missing child source");
      }
      const childDetails = yield* store.reportWorkflowDetails(
        run.runId,
        record.source.invocationId
      );
      const finished = yield* store.getRun(run.runId);
      const engine = yield* WorkflowEngine;
      const pending = yield* pollWorkflowInvocation(
        finished,
        childDetails.path
      ).pipe(
        Effect.provideService(WorkflowEngine, {
          ...engine,
          deferredResult: () => Effect.succeedNone,
        })
      );
      expect(pending).toEqual(Option.some({ _tag: "PendingCompletion" }));
      expect(
        normalizeWorkflowInvocation(
          pending,
          yield* store.invocationFacts(run.runId),
          true
        )
      ).toEqual({ _tag: "Pending" });
      const delivered = yield* pollWorkflowInvocation(
        finished,
        childDetails.path
      );
      expect(
        normalizeWorkflowInvocation(
          delivered,
          yield* store.invocationFacts(run.runId),
          true
        )
      ).toMatchObject({
        _tag: "Complete",
        outcome: { _tag: "DomainFailure" },
        status: "Failed",
      });

      expect(record?.status).toBe("Succeeded");
      if (!record?.reportRunId) {
        return yield* Effect.die("Missing report");
      }
      expect((yield* store.getRun(record.reportRunId)).result).toEqual({
        data: "child-local",
        markdown: "Failure",
      });
    })
  );
}, 20_000);

test("keyed fan-out activates one workflow report per child; inactive branches create none", () => {
  const empty = Workflow.make(
    {
      error: Schema.Never,
      id: "fan-child",
      input: Schema.String,
      success: Schema.String,
      version: 1,
    },
    Effect.gen(function* () {
      return yield* (yield* Workflow.Builder).input(Schema.String);
    })
  );
  const Input = Schema.Struct({
    choice: Schema.Boolean,
    items: Schema.Array(Schema.String),
  });
  const parent = Workflow.make(
    {
      error: Schema.Never,
      id: "fan-parent",
      input: Input,
      success: Schema.Null,
      version: 1,
    },
    Effect.gen(function* () {
      const g = yield* Workflow.Builder;
      yield* g.branch("inactive", Ref.field(yield* g.input(Input), "choice"), {
        onFalse: Effect.succeed("skip"),
        onTrue: Effect.gen(function* () {
          return yield* (yield* Workflow.Builder).workflow(
            "never",
            empty,
            "never"
          );
        }),
        success: Schema.String,
      });
      // oxlint-disable-next-line no-array-for-each -- Workflow graph combinator.
      yield* g.forEach(
        "items",
        Ref.field(yield* g.input(Input), "items"),
        {
          concurrency: 3,
          item: Schema.String,
          key: (value) => value,
          maxItems: 3,
          success: Schema.String,
        },
        (item) =>
          Effect.gen(function* () {
            return yield* (yield* Workflow.Builder).workflow(
              "child",
              empty,
              item
            );
          })
      );
      return null;
    })
  );
  return withHost(
    Application.make({
      reports: [attach(empty)],
      tasks: [reporter],
      workflows: [parent],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const source = yield* runner.submit(
        {
          input: { choice: false, items: ["one", "two", "three"] },
          kind: "workflow",
          reportSelection: { only: ["child-summary-attachment"] },
          requestKey: "fan",
          targetId: parent.id,
        },
        "owner"
      );
      const records = yield* awaitReports(source.runId, 3);
      expect(records.every((row) => row.status === "Succeeded")).toBe(true);
      expect(new Set(records.map((row) => row.source.invocationId)).size).toBe(
        3
      );
      expect(
        records.every((row) => !row.pathPreview?.text.includes("never"))
      ).toBe(true);
    })
  );
}, 20_000);

for (const scenario of ["deadline", "rejection", "invalid-input"] as const) {
  test(`workflow invocation reports ${scenario} at the child boundary`, () => {
    const input =
      scenario === "invalid-input"
        ? Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
        : Schema.Number;
    const target = Workflow.make(
      {
        error: Schema.Never,
        id: "controlled-child",
        input,
        success: Schema.Number,
        version: 1,
        ...(scenario === "deadline"
          ? { execution: { timeout: "30 millis" } }
          : {}),
      },
      Effect.gen(function* () {
        const g = yield* Workflow.Builder;
        const value = yield* g.input(input);
        if (scenario === "deadline") {
          yield* g.sleep("timer", "1 hour");
        }
        if (scenario === "rejection") {
          yield* g.approval("reject-me", {
            prompt: "Reject",
            timeout: "1 hour",
          });
        }
        return value;
      })
    );
    const parent = Workflow.make(
      {
        error: Schema.Never,
        id: "controlled-parent",
        input: Schema.Null,
        success: Schema.Number,
        version: 1,
      },
      Effect.gen(function* () {
        return yield* (yield* Workflow.Builder).workflow("child", target, -1);
      })
    );
    return withHost(
      Application.make({
        reports: [attach(target)],
        tasks: [reporter],
        workflows: [parent],
      }),
      Effect.gen(function* () {
        const runner = yield* Runner;
        const store = yield* HostStore;
        const source = yield* runner.submit(
          {
            input: null,
            kind: "workflow",
            requestKey: scenario,
            targetId: parent.id,
          },
          "owner"
        );
        if (scenario === "rejection") {
          for (let index = 0; index < 500; index += 1) {
            const waits = yield* store.listWaits(source.runId);
            const wait = waits.find((row) => row.status === "Open");
            if (wait) {
              yield* runner.settle(
                {
                  operation: "reject",
                  requestKey: "reject",
                  waitId: wait.waitId,
                },
                "owner"
              );
              break;
            }
            yield* Effect.sleep("10 millis");
          }
        }
        const [record] = yield* awaitReports(source.runId, 1);
        expect(record?.source.status).toBe(
          (
            {
              deadline: "TimedOut",
              "invalid-input": "Failed",
              rejection: "Cancelled",
            } as const
          )[scenario]
        );
        if (scenario === "rejection") {
          expect((yield* store.getRun(source.runId)).status).toBe("Rejected");
        }
        expect(record?.status).toBe("Succeeded");
      })
    );
  }, 20_000);
}

test("concurrent child failures preserve their own category while the root keeps its first fence", () => {
  const A = Schema.TaggedStruct("FailureA", {});
  const B = Schema.TaggedStruct("FailureB", {});
  const a = Task.make(
    {
      error: A,
      id: "fail-a",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.Null,
      version: 1,
    },
    () =>
      Effect.sleep("30 millis").pipe(
        Effect.andThen(Effect.fail({ _tag: "FailureA" as const }))
      )
  );
  const b = Task.make(
    {
      error: B,
      id: "fail-b",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.Null,
      version: 1,
    },
    () =>
      Effect.sleep("60 millis").pipe(
        Effect.andThen(Effect.fail({ _tag: "FailureB" as const })),
        Effect.uninterruptible
      )
  );
  const childA = Workflow.make(
    {
      error: A,
      id: "child-a",
      input: Schema.Null,
      success: Schema.Null,
      version: 1,
    },
    Effect.gen(function* () {
      return yield* (yield* Workflow.Builder).task("a", a, null);
    })
  );
  const childB = Workflow.make(
    {
      error: B,
      id: "child-b",
      input: Schema.Null,
      success: Schema.Null,
      version: 1,
    },
    Effect.gen(function* () {
      return yield* (yield* Workflow.Builder).task("b", b, null);
    })
  );
  const parent = Workflow.make(
    {
      error: Schema.Union([A, B]),
      id: "concurrent-parent",
      input: Schema.Null,
      success: Schema.Null,
      version: 1,
    },
    Effect.gen(function* () {
      const g = yield* Workflow.Builder;
      yield* g.workflow("a", childA, null);
      yield* g.workflow("b", childB, null);
      return null;
    })
  );
  return withHost(
    Application.make({
      reports: [attach(childA, "a-summary"), attach(childB, "b-summary")],
      tasks: [a, b, reporter],
      workflows: [parent],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "concurrent",
          targetId: parent.id,
        },
        "owner"
      );
      const records = yield* awaitReports(run.runId, 2);
      const root = yield* store.getRun(run.runId);
      const fence = Schema.decodeUnknownSync(
        Schema.Struct({ detail: Schema.Json })
      )(yield* store.fenceReason(run.runId));
      expect(root.error).toEqual(fence.detail);
      expect(["FailureA", "FailureB"]).toContain(
        Schema.decodeUnknownSync(Schema.Struct({ _tag: Schema.String }))(
          root.error
        )._tag
      );
      for (const record of records) {
        expect(record.status).toBe("Succeeded");
        if (!record.reportRunId) {
          return yield* Effect.die("No report");
        }
        const { result } = yield* store.getRun(record.reportRunId);
        const { data } = Schema.decodeUnknownSync(
          Schema.Struct({ data: Schema.Struct({ outcome: Report.Outcome }) })
        )(result);
        if (data.outcome._tag === "DomainFailure") {
          expect(data.outcome.error).toEqual({
            _tag:
              record.source.targetId === "child-a" ? "FailureA" : "FailureB",
          });
        } else {
          expect(data.outcome).toMatchObject({
            _tag: "Stopped",
            detail: { stoppedBy: "Failed" },
            status: "Cancelled",
          });
        }
      }
    })
  );
}, 20_000);

test("a workflow activated by a selected before-step patch has its own report", () => {
  const base = Task.make(
    {
      error: Schema.Never,
      id: "base",
      input: Schema.Number,
      replay: "idempotent",
      success: Schema.Number,
      version: 1,
    },
    Effect.succeed
  );
  const check = Task.make(
    { ...base.spec, id: "fixture/child/check" },
    Effect.succeed
  );
  const target = Workflow.make(
    {
      error: Schema.Never,
      id: "fixture/child/workflow",
      input: Schema.Number,
      success: Schema.Number,
      version: 1,
    },
    Effect.gen(function* () {
      const g = yield* Workflow.Builder;
      return yield* g.task("check", check, yield* g.input(Schema.Number));
    })
  );
  const parent = Workflow.make(
    {
      error: Schema.Never,
      id: "patched",
      input: Schema.Number,
      success: Schema.Number,
      version: 1,
    },
    Effect.gen(function* () {
      const g = yield* Workflow.Builder;
      return yield* g.task("base", base, yield* g.input(Schema.Number));
    })
  );
  const patch = WorkflowPatch.make(
    { id: "fixture/child/before", target: base },
    (input) =>
      Effect.gen(function* () {
        yield* (yield* Workflow.Builder).workflow("patch-child", target, input);
      })
  );
  const extension = Extension.make({
    id: "fixture/child",
    patches: [patch],
    tasks: { Check: check },
    version: "1.0.0",
    workflows: { Child: target },
  });
  const app = Application.make({
    extensions: [
      Extension.use(extension, {
        patches: [
          {
            at: ["base"],
            id: "before",
            use: patch.id,
            workflow: { id: parent.id, version: 1 },
          },
        ],
      }),
    ],
    reports: [attach(target)],
    tasks: [base, reporter],
    workflows: [parent],
  });
  return withHost(
    app,
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        {
          input: 9,
          kind: "workflow",
          requestKey: "patch",
          targetId: parent.id,
        },
        "owner"
      );
      const [record] = yield* awaitReports(run.runId, 1);
      expect(record?.status).toBe("Succeeded");
      expect(record?.pathPreview?.text).toContain("patch-child");
      if (!record?.reportRunId) {
        return yield* Effect.die("Missing report");
      }
      expect((yield* store.getRun(record.reportRunId)).result).toMatchObject({
        data: { outcome: { _tag: "Succeeded", value: 9 } },
      });
    })
  );
}, 20_000);
