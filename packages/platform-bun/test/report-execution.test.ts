import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Application,
  Report,
  Task,
  Vault,
  Workflow,
} from "@offtree/effectory-sdk";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
  SchemaGetter,
} from "effect";
import type { WorkflowEngine } from "effect/workflow/WorkflowEngine";

import { Catalog, catalogLayer } from "../src/catalog.ts";
import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { Runner } from "../src/runner.ts";

async function withHost<A, E>(
  app: Application.Application<never>,
  body: Effect.Effect<
    A,
    E,
    typeof Runner.Service | typeof HostStore.Service | WorkflowEngine | Catalog
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

test("automatic reports read typed outcomes through task-local Layers, page history, and close escaped readers", async () => {
  const source = Task.make(
    {
      error: Schema.Never,
      id: "source",
      input: Schema.Finite,
      replay: "idempotent",
      success: Schema.Finite,
      version: 1,
    },
    (value) => Effect.succeed(value + 1)
  );
  const other = Task.make(
    {
      error: Schema.Never,
      id: "other",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.Null,
      version: 1,
    },
    () => Effect.succeed(null)
  );
  const SourceValue = Context.Service<number>("test/report-source-value");
  let escaped: Report.HistoryService | undefined;
  let released = false;
  const layer = Layer.effect(
    SourceValue,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const history = yield* Report.History;
        escaped = history;
        const outcome = yield* history.outcome(source);
        return outcome._tag === "Succeeded" ? outcome.value : -1;
      }),
      () =>
        Effect.gen(function* () {
          const history = yield* Report.History;
          const outcome = yield* history.outcome(source);
          released = outcome._tag === "Succeeded";
        }).pipe(Effect.orDie)
    )
  );
  const reporter = Task.make(
    {
      error: Schema.Never,
      id: "reporter",
      input: Report.sourceOf(source),
      replay: "idempotent",
      success: Report.result(Schema.Finite),
      version: 1,
    },
    (identity) =>
      Effect.gen(function* () {
        const history = yield* Report.History;
        const value = yield* SourceValue;
        const mismatch = yield* Effect.exit(history.outcome(other));
        expect(Exit.isFailure(mismatch)).toBe(true);
        if (Exit.isFailure(mismatch)) {
          expect(
            Option.getOrNull(Cause.findErrorOption(mismatch.cause))?.code
          ).toBe("InvalidBoundary");
        }
        const page = yield* history.invocations({ limit: 1 });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({
          attemptCount: 1,
          status: "Succeeded",
          taskId: "source",
          taskVersion: 1,
        });
        const events = yield* history.events({ limit: 1 });
        expect(events.items[0]?.runId).toBe(identity.runId);
        if (events.cursor !== null) {
          expect(
            (yield* history.events({ cursor: events.cursor, limit: 1 }))
              .items[0]?.sequence
          ).toBeGreaterThan(events.items[0]?.sequence ?? 0);
        }
        return { data: value, markdown: `# Result ${value}` };
      })
  ).provide(layer);
  return await withHost(
    Application.make({
      reports: [
        Report.make({
          id: "summary",
          scope: "run",
          target: source,
          task: reporter,
        }),
      ],
      tasks: [source, other, reporter],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        {
          input: 41,
          kind: "task",
          requestKey: "typed",
          tags: { team: "platform" },
          targetId: source.id,
        },
        "owner"
      );
      const [record] = yield* awaitReports(run.runId, 1);
      expect(record?.status).toBe("Succeeded");
      if (record === undefined || record.reportRunId === null || !escaped) {
        return yield* Effect.die("Missing report result");
      }
      const reportRun = yield* store.getRun(record.reportRunId);
      expect(reportRun.result).toEqual({ data: 42, markdown: "# Result 42" });
      expect(reportRun.tags).toEqual({ team: "platform" });
      expect(released).toBe(true);
      const closed = yield* Effect.exit(escaped.outcome());
      expect(Exit.isFailure(closed)).toBe(true);
      if (Exit.isFailure(closed)) {
        expect(
          Option.getOrNull(Cause.findErrorOption(closed.cause))?.code
        ).toBe("InvalidBoundary");
      }
    })
  );
}, 15_000);

test("an invocation reporter finishes while its parent waits and never creates recursive reports", async () => {
  const source = Task.make(
    {
      error: Schema.Never,
      id: "source",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.String,
      version: 1,
    },
    () => Effect.succeed("done")
  );
  const reporter = Task.make(
    {
      error: Schema.Never,
      id: "reporter",
      input: Report.Source,
      replay: "idempotent",
      success: Report.result(Schema.String),
      version: 1,
    },
    () =>
      Effect.gen(function* () {
        const history = yield* Report.History;
        const outcome = yield* history.outcome();
        return { data: outcome._tag, markdown: "# Invocation" };
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
      const result = yield* graph.task("work", source, null);
      yield* graph.approval("review", {
        after: [result],
        prompt: "Review",
        timeout: "1 minute",
      });
      return result;
    })
  );
  return await withHost(
    Application.make({
      reports: [
        Report.make({
          id: "summary",
          scope: "invocation",
          target: source,
          task: reporter,
        }),
        Report.make({
          id: "report-on-report",
          scope: "run",
          target: reporter,
          task: reporter,
        }),
      ],
      tasks: [source, reporter],
      workflows: [flow],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "workflow",
          requestKey: "waiting",
          targetId: flow.id,
        },
        "owner"
      );
      const [record] = yield* awaitReports(run.runId, 1);
      expect(record?.status).toBe("Succeeded");
      expect((yield* store.getRun(run.runId)).status).toBe("Waiting");
      if (record === undefined || record.reportRunId === null) {
        return yield* Effect.die("Missing report run");
      }
      expect(yield* store.reportIds(record.reportRunId)).toEqual([]);
      yield* store.cancel(run.runId);
    })
  );
}, 15_000);

test("report retries use their stored execution policy without changing the source outcome", async () => {
  let attempts = 0;
  const Transient = Schema.TaggedStruct("Transient", {});
  const source = Task.make(
    {
      error: Schema.Never,
      id: "source",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.String,
      version: 1,
    },
    () => Effect.succeed("source succeeded")
  );
  const reporter = Task.make(
    {
      error: Transient,
      id: "reporter",
      input: Report.Source,
      replay: "idempotent",
      success: Report.result(Schema.Finite),
      version: 1,
    },
    () =>
      Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail({ _tag: "Transient" as const })
          : Effect.succeed({ data: attempts, markdown: "retry succeeded" });
      })
  );
  return await withHost(
    Application.make({
      reports: [
        Report.make({
          execution: {
            retry: { attempts: 2, delay: "10 millis", when: ["Transient"] },
          },
          id: "retry",
          scope: "run",
          target: source,
          task: reporter,
        }),
      ],
      tasks: [source, reporter],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        { input: null, kind: "task", requestKey: "retry", targetId: source.id },
        "owner"
      );
      const [record] = yield* awaitReports(run.runId, 1);
      expect(record?.status).toBe("Succeeded");
      expect(attempts).toBe(2);
      expect((yield* store.getRun(run.runId)).result).toBe("source succeeded");
      if (!record) {
        return yield* Effect.die("Missing report");
      }
      const retry = yield* store.reportRetry(
        { reportId: record.reportId, requestKey: "generation-two" },
        "owner",
        (yield* Catalog).assertExecutable
      );
      expect(retry.record.generation).toBe(2);
      const records = yield* awaitReports(run.runId, 2);
      expect(records.every((item) => item.status === "Succeeded")).toBe(true);
      expect(attempts).toBe(3);
      const replay = yield* store.reportRetry(
        { reportId: record.reportId, requestKey: "generation-two" },
        "owner",
        (yield* Catalog).assertExecutable
      );
      expect(replay.replayed).toBe(true);
      expect(replay.record.reportId).toBe(retry.record.reportId);
    })
  );
}, 15_000);

test("a timed-out reporter releases its resources while another report succeeds", async () => {
  let released = false;
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
  const stuck = Task.make(
    {
      error: Schema.Never,
      id: "stuck",
      input: Report.Source,
      replay: "idempotent",
      success: Report.result(Schema.Null),
      version: 1,
    },
    () =>
      Effect.acquireUseRelease(
        Effect.void,
        () => Effect.never,
        () =>
          Effect.sync(() => {
            released = true;
          })
      )
  );
  const healthy = Task.make(
    {
      error: Schema.Never,
      id: "healthy",
      input: Report.Source,
      replay: "idempotent",
      success: Report.result(Schema.Null),
      version: 1,
    },
    () => Effect.succeed({ data: null, markdown: "done" })
  );
  return await withHost(
    Application.make({
      reports: [
        Report.make({
          execution: { attemptTimeout: "50 millis", timeout: "10 seconds" },
          id: "stuck-report",
          scope: "run",
          target: source,
          task: stuck,
        }),
        Report.make({
          id: "healthy-report",
          scope: "run",
          target: source,
          task: healthy,
        }),
      ],
      tasks: [source, stuck, healthy],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const run = yield* runner.submit(
        {
          input: null,
          kind: "task",
          requestKey: "timeout",
          targetId: source.id,
        },
        "owner"
      );
      const records = yield* awaitReports(run.runId, 2);
      expect(
        records.find((record) => record.attachmentId === "stuck-report")
      ).toMatchObject({ reportRunStatus: "TimedOut", status: "Failed" });
      expect(
        records.find((record) => record.attachmentId === "healthy-report")
          ?.status
      ).toBe("Succeeded");
      expect(released).toBe(true);
      expect((yield* store.getRun(run.runId)).status).toBe("Succeeded");
    })
  );
}, 15_000);

test("report results retain their guarded wire value through deadlines and root projection", async () => {
  const token = "CANARY-report-final-encoding-123456789";
  const credentials = Vault.make({
    id: "credentials",
    secrets: { token: Schema.String },
  });
  let secret = "";
  let encodes = 0;
  const data = Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((value: string) => value),
      encode: SchemaGetter.transform(() => {
        encodes += 1;
        return encodes <= 2 ? "safe" : secret;
      }),
    })
  );
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
      error: Vault.Errors,
      id: "reporter",
      input: Report.Source,
      replay: "idempotent",
      success: Report.result(data),
      version: 1,
    },
    () =>
      Effect.gen(function* () {
        secret = Redacted.value(yield* credentials.get("token"));
        return { data: "safe", markdown: "safe" };
      })
  ).provide(Vault.layer(credentials, Vault.memory({ token })));
  return await withHost(
    Application.make({
      reports: [
        Report.make({
          id: "guarded",
          scope: "run",
          target: source,
          task: reporter,
        }),
      ],
      tasks: [source, reporter],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const sourceRun = yield* runner.submit(
        {
          input: null,
          kind: "task",
          requestKey: "guarded",
          targetId: source.id,
        },
        "owner"
      );
      const [record] = yield* awaitReports(sourceRun.runId, 1);
      if (record === undefined || record.reportRunId === null) {
        return yield* Effect.die("Missing report");
      }
      const run = yield* store.getRun(record.reportRunId);
      expect(run.status).toBe("Succeeded");
      expect(run.result).toEqual({ data: "safe", markdown: "safe" });
      expect(encodes).toBe(2);
    })
  );
}, 15_000);

test("four report handlers leave normal tasks runnable and release their permits", async () => {
  const gate = Deferred.makeUnsafe<boolean>();
  let active = 0;
  let peak = 0;
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
  const normal = Task.make(
    {
      error: Schema.Never,
      id: "normal",
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
      input: Report.Source,
      replay: "idempotent",
      success: Report.result(Schema.Null),
      version: 1,
    },
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          active += 1;
          peak = Math.max(peak, active);
        }),
        () =>
          Deferred.await(gate).pipe(
            Effect.as({ data: null, markdown: "done" })
          ),
        () =>
          Effect.sync(() => {
            active -= 1;
          })
      )
  );
  return await withHost(
    Application.make({
      reports: Array.from({ length: 16 }, (_, index) =>
        Report.make({
          id: `summary-${index}`,
          scope: "run",
          target: source,
          task: reporter,
        })
      ),
      tasks: [source, normal, reporter],
    }),
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const root = yield* runner.submit(
        {
          input: null,
          kind: "task",
          requestKey: "report-capacity",
          targetId: source.id,
        },
        "owner"
      );
      for (let poll = 0; poll < 400; poll += 1) {
        if (active >= 4) {
          break;
        }
        yield* Effect.sleep("10 millis");
      }
      expect(active).toBe(4);
      const submitted = yield* runner.submit(
        {
          input: null,
          kind: "task",
          requestKey: "normal-progress",
          targetId: normal.id,
        },
        "owner"
      );
      for (let poll = 0; poll < 400; poll += 1) {
        if ((yield* store.getRun(submitted.runId)).status === "Succeeded") {
          break;
        }
        yield* Effect.sleep("10 millis");
      }
      expect((yield* store.getRun(submitted.runId)).status).toBe("Succeeded");
      expect(active).toBe(4);
      yield* Deferred.succeed(gate, true);
      expect(
        (yield* awaitReports(root.runId, 16)).every(
          (record) => record.status === "Succeeded"
        )
      ).toBe(true);
      expect(active).toBe(0);
      expect(peak).toBe(4);
    })
  );
}, 15_000);
