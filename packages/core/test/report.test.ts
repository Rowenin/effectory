/* oxlint-disable unicorn/no-await-expression-member -- Assertions inspect awaited test results. */
import { expect, test } from "bun:test";

import { Context, Effect, Layer, Schema } from "effect";

import {
  Application,
  Report,
  Task,
  TaskRuntimeError,
  Workflow,
} from "../src/index.ts";
import { bindHistory } from "../src/report-state.ts";

const Deploy = Task.make(
  {
    error: Schema.Never,
    id: "test/deploy",
    input: Schema.Null,
    replay: "idempotent",
    success: Schema.Struct({ url: Schema.String }),
    version: 1,
  },
  () => Effect.succeed({ url: "local" })
);
const source = {
  invocationId: null,
  revision: "revision",
  runId: "source",
  scope: "run",
  status: "Succeeded",
  targetId: "test/deploy",
  targetKind: "task",
  targetVersion: 1,
} as const;
const Summary = Task.make(
  {
    error: Schema.Never,
    id: "test/summary",
    input: Report.sourceOf(Deploy),
    replay: "idempotent",
    success: Report.result(Schema.Struct({ url: Schema.String })),
    version: 1,
  },
  () =>
    Effect.gen(function* () {
      const history = yield* Report.History;
      const outcome = yield* history.outcome(Deploy);
      return {
        data: {
          url: outcome._tag === "Succeeded" ? outcome.value.url : "failed",
        },
        markdown: outcome._tag,
      };
    })
);

test("report fixtures decode target outcomes and ordinary task tests refuse history", async () => {
  const actual = await Effect.runPromise(
    Report.test(Summary, {
      outcome: { _tag: "Succeeded", value: { url: "deployed" } },
      source,
    })
  );
  expect(actual.value).toEqual({
    data: { url: "deployed" },
    markdown: "Succeeded",
  });
  const absent = await Effect.runPromise(
    Task.test(Summary, { input: source }).pipe(Effect.flip)
  );
  expect(absent.code).toBe("InvalidBoundary");
  const invalid = Report.test(Summary, {
    outcome: { _tag: "Succeeded", value: { url: 42 } },
    source,
  });
  expect(await Effect.runPromise(invalid.pipe(Effect.flip))).toBeInstanceOf(
    TaskRuntimeError
  );
});

test("report attachment captures policy and uses canonical task specs", async () => {
  const contract = Task.contract(Deploy.spec);
  expect(Report.sourceOf(contract)).toBe(Report.sourceOf(Deploy));
  const attachment = Report.make({
    id: "summary",
    scope: "invocation",
    target: contract,
    task: Summary,
  });
  expect(attachment.execution).toEqual({
    attemptTimeout: "30 seconds",
    timeout: "5 minutes",
  });
  expect(Object.isFrozen(attachment.on)).toBe(true);
  const app: Application.Application<never> = Application.make({
    reports: [attachment],
    tasks: [Deploy, Summary],
  });
  const registered = await Effect.runPromise(
    Effect.map(Application.Registry, (registry) =>
      registry.reports.get("summary")
    ).pipe(Effect.provide(app.layer))
  );
  expect(registered).toBe(attachment);
  const missing = Application.make({ reports: [attachment], tasks: [Deploy] });
  const error = await Effect.runPromise(
    Application.Registry.pipe(Effect.provide(missing.layer), Effect.flip)
  );
  expect(error.message).toContain("reporter task");
  const duplicate = Application.make({
    reports: [attachment, attachment],
    tasks: [Deploy, Summary],
  });
  expect(
    (
      await Effect.runPromise(
        Application.Registry.pipe(Effect.provide(duplicate.layer), Effect.flip)
      )
    ).message
  ).toContain("Duplicate report");
});

class Url extends Context.Service<Url, string>()("report-test/Url") {}
test("task-local Layers read report history with isolated concurrent lifetimes", async () => {
  const released: string[] = [];
  const layer = Layer.effect(
    Url,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const history = yield* Report.History;
        const value = yield* history.outcome(Deploy);
        return value._tag === "Succeeded" ? value.value.url : "failed";
      }),
      (value) =>
        Effect.sync(() => {
          released.push(value);
        })
    )
  );
  const task = Task.make(Summary.spec, () =>
    Effect.gen(function* () {
      const url = yield* Url;
      yield* Effect.yieldNow;
      return { data: { url }, markdown: url };
    })
  ).provide(layer);
  const values = await Effect.runPromise(
    Effect.forEach(
      ["one", "two"],
      (url) =>
        Report.test(task, {
          outcome: { _tag: "Succeeded", value: { url } },
          source,
        }),
      { concurrency: "unbounded" }
    )
  );
  expect(values.map((value) => value.value.data.url)).toEqual(["one", "two"]);
  expect(released.toSorted()).toEqual(["one", "two"]);
});

const fake = (url: string): Report.HistoryService => ({
  events: () => Effect.die("Unused"),
  invocations: () => Effect.die("Unused"),
  outcome: () => Effect.succeed({ _tag: "Succeeded" as const, value: { url } }),
});
test("host history wins over Application context while task-local overrides remain explicit", async () => {
  const runtime: Task.RuntimeContext = {
    attempt: 1,
    attemptId: "attempt",
    invocationPath: "task",
    key: (name) => name,
    progress: () => Effect.void,
    publish: () => Effect.die("Unused"),
    revision: "revision",
    runId: "report",
    taskId: Summary.id,
    taskVersion: 1,
  };
  bindHistory(runtime, fake("host"));
  const app = Application.make({ tasks: [Summary] }).provide(
    Layer.succeed(Report.History, fake("application"))
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* Application.Registry;
      const task = registry.tasks.get(Summary.id);
      if (!task) {
        return yield* Effect.die("Missing reporter");
      }
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- user code loaded at runtime has an unknown error type
      return yield* task.execute(source, runtime);
    }).pipe(Effect.provide(app.layer))
  );
  expect(result).toEqual({ data: { url: "host" }, markdown: "Succeeded" });
  const overridden = Summary.provide(
    Layer.succeed(Report.History, fake("local"))
  );
  expect(await Effect.runPromise(overridden.execute(source, runtime))).toEqual({
    data: { url: "local" },
    markdown: "Succeeded",
  });
});

test("history fixture cursors are bounded, cannot cross readers, and close with the attempt", async () => {
  let captured: Report.HistoryService | undefined;
  const task = Task.make(Summary.spec, () =>
    Effect.gen(function* () {
      captured = yield* Report.History;
      const first = yield* captured.events({ limit: 1 });
      expect(first.items[0]?.sequence).toBe(1);
      if (first.cursor === null) {
        return yield* Effect.die("Missing page cursor");
      }
      const second = yield* captured.events({
        cursor: first.cursor,
        limit: 1,
      });
      expect(second.items[0]?.sequence).toBe(2);
      expect(second.cursor).toBeNull();
      const wrong = yield* captured
        .invocations({ cursor: first.cursor })
        .pipe(Effect.result);
      expect(wrong._tag).toBe("Failure");
      if (wrong._tag === "Failure") {
        expect(wrong.failure.code).toBe("InvalidBoundary");
      }
      return { data: { url: "ok" }, markdown: "ok" };
    })
  );
  await Effect.runPromise(
    Report.test(task, {
      events: [1, 2].map((sequence) => ({
        at: "now",
        payload: {},
        runId: source.runId,
        sequence,
        tag: "Log",
      })),
      outcome: { _tag: "Succeeded", value: { url: "ok" } },
      source,
    })
  );
  if (!captured) {
    throw new Error("History was not captured");
  }
  const closed = await Effect.runPromise(captured.outcome().pipe(Effect.flip));
  expect(closed.message).toContain("closed");
});

test("report schemas reject oversized markdown and fixtures validate lazily", async () => {
  expect(() =>
    Schema.decodeSync(Summary.successSchema)({
      data: { url: "x" },
      markdown: "x".repeat(262_145),
    })
  ).toThrow();
  const invalid = Report.test(Summary, {
    outcome: { _tag: "Failure", category: "Host", detail: {} },
    source,
  });
  expect(
    (await Effect.runPromise(invalid.pipe(Effect.flip))).message
  ).toContain("source.status");
});

test("lookalike report schemas cannot forge SDK provenance", () => {
  const forged = Task.make(
    { ...Summary.spec, input: Schema.Struct(Report.Source.fields) },
    () => Effect.succeed({ data: { url: "fake" }, markdown: "fake" })
  );
  expect(() =>
    Report.make({ id: "forged", scope: "run", target: Deploy, task: forged })
  ).toThrow("canonical target");
  const different = Task.make({ ...Deploy.spec }, () =>
    Effect.succeed({ url: "other" })
  );
  expect(() =>
    Report.make({
      id: "wrong-object",
      scope: "run",
      target: different,
      task: Summary,
    })
  ).toThrow("canonical target");
});

test("generic reporters register across task and workflow targets without extra requirements", async () => {
  const flow = Workflow.make(
    {
      error: Schema.Never,
      id: "test/flow",
      input: Schema.Null,
      success: Deploy.successSchema,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      return yield* graph.task("deploy", Deploy, null);
    })
  );
  const generic = Task.make(
    {
      ...Summary.spec,
      id: "test/generic",
      input: Report.Source,
      success: Report.result(Schema.Null),
    },
    (input) => Effect.succeed({ data: null, markdown: input.status })
  );
  const root = Report.make({ id: "root-report", target: flow, task: generic });
  const invocation = Report.make({
    id: "task-report",
    scope: "invocation",
    target: Deploy,
    task: generic,
  });
  const app: Application.Application<never> = Application.make({
    reports: [
      root,
      invocation,
      Report.make({
        id: "workflow-invocation",
        scope: "invocation",
        target: flow,
        task: generic,
      }),
    ],
    tasks: [Deploy, generic],
    workflows: [flow],
  });
  const count = await Effect.runPromise(
    Effect.map(Application.Registry, (registry) => registry.reports.size).pipe(
      Effect.provide(app.layer)
    )
  );
  expect(count).toBe(3);
  expect(root.scope).toBe("run");
  expect(Report.sourceOf(flow)).toBe(Report.sourceOf(flow));
});

/** Compiled by the repository typecheck; deliberately never executed. */
export function reportTypeProofs() {
  // @ts-expect-error Task scope is explicit.
  Report.make({ id: "missing-scope", target: Deploy, task: Summary });
  const other = Task.make({ ...Deploy.spec, id: "test/other" }, () =>
    Effect.succeed({ url: "other" })
  );
  Report.make({
    id: "wrong-target",
    scope: "run",
    target: other,
    // @ts-expect-error A narrowed source cannot attach to another target.
    task: Summary,
  });
  Report.make({
    id: "wrong-shape",
    scope: "run",
    target: Deploy,
    // @ts-expect-error Ordinary task inputs/results are not report contracts.
    task: Deploy,
  });
  const options = {
    execution: {
      retry: { attempts: 2, delay: "1 second", when: ["NotDeclared"] },
    },
    id: "bad-retry",
    scope: "run",
    target: Deploy,
    task: Summary,
  } as const;
  // @ts-expect-error Retry tags must belong to the reporter's error schema.
  Report.make(options);
}

test("report retries use the existing idempotent-only and ten-attempt policy", () => {
  const manual = Task.make(
    {
      ...Summary.spec,
      error: Schema.TaggedStruct("RetryMe", {}),
      replay: "manual",
    },
    () => Effect.succeed({ data: { url: "ok" }, markdown: "ok" })
  );
  const retry = { attempts: 2, delay: "1 second", when: ["RetryMe"] } as const;
  expect(() =>
    Report.make({
      execution: { retry },
      id: "manual",
      scope: "run",
      target: Deploy,
      task: manual,
    })
  ).toThrow("idempotent");
  const replayable = Task.make({ ...manual.spec, replay: "idempotent" }, () =>
    Effect.succeed({ data: { url: "ok" }, markdown: "ok" })
  );
  expect(() =>
    Report.make({
      execution: { retry: { ...retry, attempts: 11 } },
      id: "too-many",
      scope: "run",
      target: Deploy,
      task: replayable,
    })
  ).toThrow("between 1 and 10");
  expect(
    Report.make({
      execution: { retry },
      id: "valid",
      scope: "run",
      target: Deploy,
      task: replayable,
    }).execution.retry?.attempts
  ).toBe(2);
});

test("workflow invocation fixtures keep the typed workflow outcome without adding service requirements", async () => {
  const child = Workflow.make(
    {
      error: Schema.Never,
      id: "fixture/child",
      input: Schema.Finite,
      success: Schema.Finite,
      version: 1,
    },
    Effect.gen(function* () {
      return yield* (yield* Workflow.Builder).input(Schema.Finite);
    })
  );
  const summary = Task.make(
    {
      error: Schema.Never,
      id: "fixture/summary",
      input: Report.sourceOf(child),
      replay: "idempotent",
      success: Report.result(Schema.Finite),
      version: 1,
    },
    () =>
      Effect.gen(function* () {
        const history = yield* Report.History;
        const outcome = yield* history.outcome(child);
        return {
          data: outcome._tag === "Succeeded" ? outcome.value : 0,
          markdown: outcome._tag,
        };
      })
  );
  const attachment = Report.make({
    id: "fixture/attachment",
    scope: "invocation",
    target: child,
    task: summary,
  });
  const app: Application.Application<never> = Application.make({
    reports: [attachment],
    tasks: [summary],
    workflows: [child],
  });
  expect(app).toBeDefined();
  const result = await Effect.runPromise(
    Report.test(summary, {
      outcome: { _tag: "Succeeded", value: 42 },
      source: {
        ...source,
        invocationId: "child-id",
        scope: "invocation",
        targetId: child.id,
        targetKind: "workflow",
      },
    })
  );
  expect(result.value).toEqual({ data: 42, markdown: "Succeeded" });
});
