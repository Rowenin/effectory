import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { RunSummary } from "@effectory/runtime/history-protocol";
import { Run } from "@effectory/runtime/protocol";
import {
  Application,
  Report,
  Task,
  Workflow,
  WorkflowSchedule,
} from "@offtree/effectory-sdk";
import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import {
  normalizeSelection,
  SelectionDecision,
} from "@offtree/effectory-sdk/internal/report-selection-schema";
import { Effect, Schema } from "effect";

import { createStore } from "../src/host-store.ts";
import { initializeReadProtection } from "../src/lake-protection.ts";
import { ReportPlan, resolveReportPlan } from "../src/report-plan.ts";

const Source = Task.make(
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
const Reporter = Task.make(
  {
    error: Schema.Never,
    id: "reporter",
    input: Report.Source,
    replay: "idempotent",
    success: Report.result(Schema.Null),
    version: 1,
  },
  () => Effect.succeed({ data: null, markdown: "ok" })
);
const Flow = Workflow.make(
  {
    error: Schema.Never,
    id: "flow",
    input: Schema.Null,
    success: Schema.Null,
    version: 1,
  },
  Effect.gen(function* () {
    const g = yield* Workflow.Builder;
    return yield* g.task("source", Source, null);
  })
);
async function registry() {
  return await Effect.runPromise(
    Application.Registry.pipe(
      Effect.provide(
        Application.make({
          reports: [
            Report.make({
              id: "cost",
              tags: { kind: "cost" },
              target: Flow,
              task: Reporter,
            }),
            Report.make({
              id: "audit",
              on: ["Failed"],
              required: true,
              target: Flow,
              task: Reporter,
            }),
          ],
          tasks: [Source, Reporter],
          workflows: [Flow],
        }).layer
      )
    )
  );
}
function fixture() {
  const database = new Database(":memory:");
  const lease = { assertActive() {}, token: "selection" };
  const store = createStore(database, lease);
  initializeReadProtection(database);
  return { database, lease, store };
}
const sync = Effect.runSync;
const request = {
  input: null,
  kind: "workflow",
  requestKey: "key",
  targetId: "flow",
} as const;

test("admission pins decisions, omits excluded obligations, and replays before changed metadata", async () => {
  const f = fixture();
  try {
    const resolved = resolveReportPlan(await registry(), "workflow", "flow", {
      skipAll: true,
    });
    const accepted = sync(
      f.store.submit(
        {
          ...request,
          reportPlan: resolved.plan,
          reportSelection: { skipAll: true },
          resolvedReportSelection: resolved.decision,
        },
        "one",
        "owner"
      )
    );
    expect(accepted.reportSelection).toEqual({
      excluded: ["cost"],
      requested: { skipAll: true },
      required: ["audit"],
      selected: ["audit"],
    });
    expect(
      sync(f.store.reportList({ runId: accepted.runId }, "owner")).items.map(
        (item) => item.attachmentId
      )
    ).toEqual(["audit"]);
    const replay = sync(
      createStore(f.database, f.lease).lookupSubmission(
        { ...request, reportSelection: { skipAll: true } },
        "owner"
      )
    );
    expect(replay).toEqual(accepted);
    expect(() =>
      sync(
        f.store.lookupSubmission(
          { ...request, reportSelection: { only: ["audit"] } },
          "owner"
        )
      )
    ).toThrow("Request key");
    sync(f.store.project(accepted.runId, "Succeeded", null));
    for (const source of sync(f.store.reportPendingSources("Ready"))) {
      sync(f.store.reportMaterialize(source.sourceId));
    }
    expect(
      sync(f.store.reportList({ runId: accepted.runId }, "owner")).items
    ).toMatchObject([
      { notApplicableReason: "OutcomeExcluded", status: "NotApplicable" },
    ]);
    expect(sync(f.store.reportPromote())).toBeNull();
    expect(sync(f.store.getRun(accepted.runId, "owner")).status).toBe(
      "Succeeded"
    );
    expect(
      f.database
        .query(
          "SELECT count(*) count FROM host_report_groups WHERE sourceRunId=?"
        )
        .get(accepted.runId)
    ).toEqual({ count: 1 });
    const empty = { ...request, requestKey: "empty" };
    const decision = {
      excluded: ["optional"],
      requested: { skipAll: true },
      required: [],
      selected: [],
    };
    const none = sync(
      f.store.submit(
        {
          ...empty,
          reportPlan: [],
          reportSelection: { skipAll: true },
          resolvedReportSelection: decision,
        },
        "one",
        "owner"
      )
    );
    expect(
      sync(f.store.reportList({ runId: none.runId }, "owner")).items
    ).toHaveLength(0);
    expect(
      f.database
        .query(
          "SELECT count(*) count FROM host_report_sources WHERE sourceRunId=?"
        )
        .get(none.runId)
    ).toEqual({ count: 0 });
    expect(
      f.database
        .query(
          "SELECT count(*) count FROM lake_report_holds WHERE sourceRunId=?"
        )
        .get(none.runId)
    ).toEqual({ count: 0 });
  } finally {
    f.database.close();
  }
});

test("selection capture rolls back with admission and empty selectors preserve old fingerprints", async () => {
  const f = fixture();
  try {
    const resolved = resolveReportPlan(await registry(), "workflow", "flow");
    f.database.exec(
      "CREATE TRIGGER reject_plan BEFORE INSERT ON host_report_plans BEGIN SELECT RAISE(ABORT,'test'); END;"
    );
    expect(() =>
      sync(
        f.store.submit(
          {
            ...request,
            reportPlan: resolved.plan,
            resolvedReportSelection: resolved.decision,
          },
          "one",
          "owner"
        )
      )
    ).toThrow();
    expect(
      f.database.query("SELECT count(*) count FROM host_runs").get()
    ).toEqual({ count: 0 });
    expect(
      f.database.query("SELECT count(*) count FROM host_outbox").get()
    ).toEqual({ count: 0 });
    f.database.exec("DROP TRIGGER reject_plan");
    const run = sync(
      f.store.submit(
        {
          ...request,
          reportPlan: resolved.plan,
          resolvedReportSelection: resolved.decision,
        },
        "one",
        "owner"
      )
    );
    expect(
      sync(
        f.store.lookupSubmission(
          {
            ...request,
            reportSelection: { only: [], onlyTags: {}, skipAll: false },
          },
          "owner"
        )
      )
    ).toEqual(run);
    expect(
      f.database
        .query("SELECT fingerprint FROM host_runs WHERE runId=?")
        .get(run.runId)
    ).toEqual({
      fingerprint: canonical({
        input: null,
        kind: "workflow",
        revision: null,
        targetId: "flow",
      }),
    });
    const historical = sync(
      f.store.submit({ ...request, requestKey: "legacy" }, "one", "owner")
    );
    expect(historical).not.toHaveProperty("reportSelection");
    expect(normalizeSelection({ only: ["cost", "audit", "cost"] })).toEqual({
      only: ["audit", "cost"],
    });
    const legacyPlan = resolved.plan.map(
      ({ required: _required, tags: _tags, ...entry }) => entry
    );
    expect(
      Schema.decodeUnknownSync(ReportPlan)(legacyPlan).map((entry) => [
        entry.required,
        entry.tags,
      ])
    ).toEqual([
      [false, {}],
      [false, {}],
    ]);
  } finally {
    f.database.close();
  }
});

test("schedule selection edits preserve pending slots and capture the observed decision", async () => {
  const f = fixture();
  try {
    const registered = await registry();
    const all = resolveReportPlan(registered, "workflow", "flow");
    const filtered = resolveReportPlan(registered, "workflow", "flow", {
      skipAll: true,
    });
    const schedule = (skipAll: boolean) =>
      WorkflowSchedule.make({
        catchUp: { latestWithin: "1 hour" },
        cron: "* * * * *",
        id: "minute",
        input: null,
        reportSelection: { skipAll },
        workflow: Flow,
      });
    const now = Date.parse("2026-11-06T00:00:00Z");
    sync(
      f.store.scheduleReconcile(
        new Map([["minute", schedule(false)]]),
        "one",
        now,
        new Map([["minute", all.plan]]),
        new Map([["minute", all.decision]])
      )
    );
    f.database
      .query(
        "UPDATE host_schedules SET pendingSlot=? WHERE scheduleId='minute'"
      )
      .run(now + 60_000);
    const before = f.database
      .query("SELECT generation,watermark,pendingSlot FROM host_schedules")
      .get();
    sync(
      f.store.scheduleReconcile(
        new Map([["minute", schedule(true)]]),
        "two",
        now + 62_000,
        new Map([["minute", filtered.plan]]),
        new Map([["minute", filtered.decision]])
      )
    );
    expect(
      f.database
        .query("SELECT generation,watermark,pendingSlot FROM host_schedules")
        .get()
    ).toEqual(before);
    sync(f.store.scheduleTick("minute", now + 62_000, false));
    const [run] = sync(f.store.listRuns());
    if (!run) {
      throw new Error("Missing scheduled run");
    }
    expect(run.revision).toBe("two");
    expect(run.reportSelection).toEqual(filtered.decision);
    expect(
      sync(f.store.scheduleGet("minute", "owner", now + 62_000)).reportSelection
    ).toEqual({ skipAll: true });
    sync(
      f.store.scheduleReconcile(
        new Map([["minute", schedule(false)]]),
        "three",
        now + 63_000,
        new Map([["minute", all.plan]]),
        new Map([["minute", all.decision]])
      )
    );
    expect(sync(f.store.getRun(run.runId, "owner")).reportSelection).toEqual(
      filtered.decision
    );
  } finally {
    f.database.close();
  }
});

test("bounded decisions are optional to old Run readers and absent from summaries", () => {
  const ids = Array.from(
    { length: 128 },
    (_, index) => `r${String(index).padStart(3, "0")}${"x".repeat(196)}`
  );
  const decision = Schema.decodeUnknownSync(SelectionDecision)({
    excluded: [],
    requested: { only: ids, skip: ids },
    required: ids,
    selected: ids,
  });
  expect(Buffer.byteLength(JSON.stringify(decision))).toBeLessThan(131_072);
  const { reportSelection: _new, ...oldFields } = Run.fields;
  const OldRun = Schema.Struct(oldFields);
  const row = {
    acceptedAt: new Date(0).toISOString(),
    engineId: null,
    error: null,
    input: null,
    kind: "workflow",
    lastSequence: 0,
    requestKey: "key",
    result: null,
    revision: "a".repeat(64),
    runId: "run",
    status: "Queued",
    tags: {},
    targetId: "flow",
  };
  expect(Schema.decodeUnknownSync(Run)(row)).not.toHaveProperty(
    "reportSelection"
  );
  const modern = Schema.decodeUnknownSync(Run)({
    ...row,
    reportSelection: decision,
  });
  expect(Schema.decodeUnknownSync(OldRun)(modern)).not.toHaveProperty(
    "reportSelection"
  );
  expect(Schema.decodeUnknownSync(RunSummary)(modern)).not.toHaveProperty(
    "reportSelection"
  );
});
