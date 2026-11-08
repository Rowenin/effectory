import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Workflow, WorkflowSchedule } from "@offtree/effectory-sdk";
import { Effect, Exit, Layer, Schema } from "effect";

import { HostStore, hostStoreLayer } from "../src/host-store.ts";
import { ownershipLayer } from "../src/ownership.ts";
import type { EncodedReportPlan } from "../src/report-plan.ts";

const rootEntry: EncodedReportPlan[number] = {
  attachmentId: "summary",
  execution: { attemptTimeout: "30 seconds", timeout: "5 minutes" },
  on: ["Succeeded", "Failed", "Rejected", "TimedOut", "Cancelled"],
  reporterId: "summary-task",
  reporterProviderId: null,
  reporterVersion: 1,
  required: false,
  scope: "run",
  tags: {},
  targetId: "flow",
  targetKind: "workflow",
  targetVersion: 1,
};
const submission = {
  input: null,
  kind: "workflow",
  requestKey: "source",
  targetId: "flow",
} as const;
async function withDatabase(body: (filename: string) => Promise<void>) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-report-sources-")
  );
  try {
    await body(path.join(directory, "state.sqlite"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
const storeLayer = (filename: string) =>
  hostStoreLayer(filename).pipe(
    Layer.provide(ownershipLayer(`${filename}.owner`))
  );

test("pinned report plans survive reopen and idempotent admission cannot change them", () =>
  withDatabase(async (filename) => {
    let runId = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const run = yield* store.submit(
          { ...submission, reportPlan: [rootEntry] },
          "revision-one",
          "owner"
        );
        ({ runId } = run);
        const retry = yield* store.submit(
          { ...submission, reportPlan: [{ ...rootEntry, reporterVersion: 2 }] },
          "revision-two",
          "owner"
        );
        expect(retry.runId).toBe(runId);
        expect(yield* store.reportPlan(runId)).toEqual([rootEntry]);
        const armed = yield* store.reportPendingSources("Armed");
        expect(armed).toHaveLength(1);
        expect(armed[0]?.source.status).toBeNull();
        yield* store.project(
          runId,
          "Failed",
          { message: "host failed" },
          "Host"
        );
      }).pipe(Effect.provide(storeLayer(filename)))
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const ready = yield* store.reportPendingSources("Ready");
        expect(ready).toHaveLength(1);
        expect(ready[0]?.failureCategory).toBe("Host");
        expect(ready[0]?.source.revision).toBe("revision-one");
        expect(ready[0]?.source.status).toBe("Failed");
        yield* store.project(runId, "Failed", { _tag: "Different" }, "Domain");
        expect(
          (yield* store.reportPendingSources("Ready"))[0]?.failureCategory
        ).toBe("Host");
      }).pipe(Effect.provide(storeLayer(filename)))
    );
  }));

test("report capture, invocation arming and root completion roll back with their source transactions", () =>
  withDatabase(async (filename) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(filename)),
          (connection) => Effect.sync(() => connection.close())
        );
        db.exec(
          "CREATE TRIGGER fail_plan BEFORE INSERT ON host_report_plans BEGIN SELECT RAISE(ABORT, 'injected plan failure'); END"
        );
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              store.submit(
                { ...submission, reportPlan: [rootEntry] },
                "revision",
                "owner"
              )
            )
          )
        ).toBe(true);
        expect(yield* store.listRuns()).toHaveLength(0);
        expect(yield* store.outbox()).toHaveLength(0);
        db.exec("DROP TRIGGER fail_plan");
        const entry = {
          ...rootEntry,
          attachmentId: "task-summary",
          scope: "invocation" as const,
          targetId: "task",
          targetKind: "task" as const,
        };
        const run = yield* store.submit(
          { ...submission, reportPlan: [rootEntry, entry] },
          "revision",
          "owner"
        );
        db.exec(
          "CREATE TRIGGER fail_source BEFORE INSERT ON host_report_sources BEGIN SELECT RAISE(ABORT, 'injected source failure'); END"
        );
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              store.registerInvocation(run.runId, "node", "engine", {
                taskId: "task",
              })
            )
          )
        ).toBe(true);
        expect(yield* store.invocations(run.runId)).toHaveLength(0);
        db.exec("DROP TRIGGER fail_source");
        yield* store.registerInvocation(run.runId, "node", "engine", {
          taskId: "task",
        });
        expect(yield* store.reportPendingSources("Armed")).toHaveLength(2);
        db.exec(
          "CREATE TRIGGER fail_projection BEFORE UPDATE ON host_report_sources BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END"
        );
        expect(
          Exit.isFailure(
            yield* Effect.exit(store.project(run.runId, "Succeeded", "done"))
          )
        ).toBe(true);
        expect((yield* store.getRun(run.runId)).status).toBe("Queued");
        expect(yield* store.reportPendingSources("Ready")).toHaveLength(0);
        db.exec("DROP TRIGGER fail_projection");
        yield* store.project(run.runId, "Succeeded", "done");
        expect(yield* store.reportPendingSources("Ready")).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(storeLayer(filename)))
    );
  }));

test("sixteen attachments share one armed invocation record and duplicate dispatch is harmless", () =>
  withDatabase(async (filename) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const plan = Array.from({ length: 16 }, (_, index) => ({
          ...rootEntry,
          attachmentId: `report-${index}`,
          scope: "invocation" as const,
          targetId: "task",
          targetKind: "task" as const,
        }));
        const run = yield* store.submit(
          { ...submission, reportPlan: plan },
          "revision",
          "owner"
        );
        yield* store.registerInvocation(run.runId, "node", "engine", {
          taskId: "task",
        });
        yield* store.registerInvocation(run.runId, "node", "engine", {
          taskId: "task",
        });
        const pending = yield* store.reportPendingSources("Armed");
        expect(pending).toHaveLength(1);
        expect(pending[0]?.source.invocationId).toBe("engine");
        expect(yield* store.reportPlan(run.runId)).toHaveLength(16);
      }).pipe(Effect.provide(storeLayer(filename)))
    );
  }));

test("schedule report-plan edits preserve generation and capture the observed revision at admission", () =>
  withDatabase(async (filename) => {
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
        return yield* graph.input(Schema.Null);
      })
    );
    const schedule = WorkflowSchedule.make({
      cron: "* * * * *",
      id: "minute",
      input: null,
      workflow: flow,
    });
    const now = Date.parse("2026-11-06T00:00:00.000Z");
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        yield* store.scheduleReconcile(
          new Map([[schedule.id, schedule]]),
          "revision-one",
          now,
          new Map([[schedule.id, [rootEntry]]])
        );
        const before = yield* store.scheduleGet(schedule.id, "owner", now);
        const changed = { ...rootEntry, reporterVersion: 2 };
        yield* store.scheduleReconcile(
          new Map([[schedule.id, schedule]]),
          "revision-two",
          now + 1000,
          new Map([[schedule.id, [changed]]])
        );
        const after = yield* store.scheduleGet(
          schedule.id,
          "owner",
          now + 1000
        );
        expect(after.generation).toBe(before.generation);
        yield* store.scheduleTick(schedule.id, now + 60_000, false);
        const runs = yield* store.listRuns();
        expect(runs).toHaveLength(1);
        const [admitted] = runs;
        if (!admitted) {
          return yield* Effect.die("Scheduled source not admitted");
        }
        expect(admitted.revision).toBe("revision-two");
        expect(yield* store.reportPlan(admitted.runId)).toEqual([changed]);
      }).pipe(Effect.provide(storeLayer(filename)))
    );
  }));

test("the bounded invocation scan rotates durably past unresolved early sources", () =>
  withDatabase(async (filename) => {
    let runId = "";
    let lastPosition = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const entry = {
          ...rootEntry,
          attachmentId: "leaf",
          scope: "invocation" as const,
          targetId: "task",
          targetKind: "task" as const,
        };
        const run = yield* store.submit(
          { ...submission, reportPlan: [rootEntry, entry] },
          "revision",
          "owner"
        );
        ({ runId } = run);
        for (let index = 0; index < 405; index += 1) {
          yield* store.registerInvocation(
            runId,
            `node-${index}`,
            `engine-${index}`,
            { taskId: "task" }
          );
        }
        const first = yield* store.reportScan();
        expect(first).toHaveLength(200);
        expect(first.every((row) => row.invocationId !== null)).toBe(true);
        lastPosition = first.at(-1)?.sourceSeq ?? 0;
        yield* store.reportAdvance(lastPosition);
      }).pipe(Effect.provide(storeLayer(filename)))
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const second = yield* store.reportScan();
        expect(second).toHaveLength(200);
        expect(second[0]?.sourceSeq).toBeGreaterThan(lastPosition);
        yield* store.reportAdvance(second.at(-1)?.sourceSeq ?? 0);
        const third = yield* store.reportScan();
        expect(third).toHaveLength(5);
        yield* store.reportAdvance(third.at(-1)?.sourceSeq ?? 0);
        const wrapped = yield* store.reportScan();
        expect(wrapped[0]?.invocationId).toBe("engine-0");
        const [first] = wrapped;
        if (!first) {
          return yield* Effect.die("Missing source");
        }
        yield* store.reportObservationError(
          first.sourceId,
          "Unavailable: retry"
        );
        yield* store.reportSettleSource(
          first.sourceId,
          "Cancelled",
          "Control",
          "NotStarted"
        );
        yield* store.reportSettleSource(
          first.sourceId,
          "Succeeded",
          null,
          null
        );
        const [settled] = yield* store.reportPendingSources("Ready");
        expect(settled?.source.status).toBe("Cancelled");
        expect(settled?.ineligibleReason).toBe("NotStarted");
        expect(settled?.observationError).toBeNull();
        expect(
          (yield* store.reportInvocationDetails(runId, "engine-0")).attemptCount
        ).toBe(0);
      }).pipe(Effect.provide(storeLayer(filename)))
    );
  }));
