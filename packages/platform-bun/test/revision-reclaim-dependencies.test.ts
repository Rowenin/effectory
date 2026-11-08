import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { RunStatus } from "@effectory/runtime/protocol";
import { Workflow, WorkflowSchedule } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

import { emptyLock, lockRevision } from "../src/extension-cache.ts";
import { createExtensionJournal } from "../src/extension-journal.ts";
import { createStore } from "../src/host-store.ts";
import { inspectionBudget } from "../src/inspection-budget.ts";
import type { EncodedReportPlan } from "../src/report-plan.ts";
import { inspectReclaimDependencies } from "../src/revision-reclaim-dependencies.ts";
import { createRetirementStore } from "../src/run-retirement-store.ts";
import { inspectUpgradeOutbox } from "../src/upgrade-outbox.ts";
import { upgradeScanner } from "../src/upgrade-scan.ts";

const revisions = ["a", "b", "c", "d", "e", "f"].map((c) => c.repeat(64));
const [
  active,
  runRevision,
  scheduleRevision,
  pendingRevision,
  candidateRevision,
  unusedRevision,
] = revisions as [string, string, string, string, string, string];
const lease = { assertActive: () => {}, token: "owner" };
const entry: EncodedReportPlan[number] = {
  attachmentId: "summary",
  execution: { attemptTimeout: "30 seconds", timeout: "5 minutes" },
  on: ["Succeeded", "Failed", "Rejected", "TimedOut", "Cancelled"],
  reporterId: "reporter",
  reporterProviderId: null,
  reporterVersion: 1,
  scope: "run",
  targetId: "source",
  targetKind: "task",
  targetVersion: 1,
};

function fixture() {
  const db = new Database(":memory:");
  const store = createStore(db, lease);
  const run = Effect.runSync(
    store.submit(
      {
        input: null,
        kind: "task",
        reportPlan: [entry],
        requestKey: "source",
        targetId: "source",
      },
      runRevision,
      "other-principal"
    )
  );
  Effect.runSync(
    store.registerInvocation(run.runId, "node", "engine", {
      attemptTimeout: null,
      deadline: null,
      input: null,
      nodeId: "node",
      permits: [],
      retry: null,
      runId: run.runId,
      taskId: "source",
    })
  );
  Effect.runSync(
    store.admitAttempt(run.runId, "node", 1, "manual", { taskVersion: 1 })
  );
  Effect.runSync(store.project(run.runId, "Succeeded", null));
  for (const source of Effect.runSync(store.reportPendingSources("Ready"))) {
    Effect.runSync(store.reportMaterialize(source.sourceId));
  }
  const reporter = Effect.runSync(store.reportPromote());
  if (!reporter?.report) {
    throw new Error("Expected reporter");
  }
  Effect.runSync(
    store.project(reporter.runId, "Succeeded", { data: null, markdown: "done" })
  );
  const report = Effect.runSync(store.reportGet(reporter.report.reportId));
  Effect.runSync(
    store.reportRetry(
      { reportId: report.reportId, requestKey: "again" },
      "other-principal",
      () => {}
    )
  );
  Effect.runSync(
    store.reportCancelSource(
      { requestKey: "cancel-all", sourceRunId: run.runId },
      "other-principal"
    )
  );
  return {
    db,
    inspect: () => inspectReclaimDependencies(db, revisions, active),
    reporter,
    run,
    store,
  };
}

test("reclamation protects completed source and report runs, every generation and other principals without writing", async () => {
  const f = fixture();
  try {
    const before = f.db.serialize();
    const result = await Effect.runPromise(f.inspect());
    expect(result.protected.map((p) => p.revision)).toEqual([
      active,
      runRevision,
    ]);
    expect(result.protected[1]?.reasons).toEqual([
      { count: 2, examples: [f.run.runId, f.reporter.runId], kind: "Run" },
    ]);
    expect(result.rows).toBeGreaterThan(10);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.db.serialize()).toEqual(before);
    expect(f.db.inTransaction).toBe(false);
    const repeated = await Effect.runPromise(f.inspect());
    expect(repeated.digest).toBe(result.digest);
    f.db
      .query("UPDATE host_runs SET status='Failed' WHERE runId=?")
      .run(f.run.runId);
    const changed = await Effect.runPromise(f.inspect());
    expect(changed.digest).not.toBe(result.digest);
  } finally {
    f.db.close();
  }
});

test("all run statuses protect code and examples stay bounded across pages", async () => {
  const db = new Database(":memory:");
  const store = createStore(db, lease);
  try {
    for (let i = 0; i < 450; i += 1) {
      const run = Effect.runSync(
        store.submit(
          {
            input: null,
            kind: "task",
            requestKey: `run-${i}`,
            targetId: "source",
          },
          runRevision,
          `principal-${i}`
        )
      );
      db.query("UPDATE host_runs SET status=? WHERE runId=?").run(
        RunStatus.literals[i % RunStatus.literals.length] ?? "Queued",
        run.runId
      );
    }
    const result = await Effect.runPromise(
      inspectReclaimDependencies(db, revisions, runRevision)
    );
    expect(result.protected).toHaveLength(1);
    expect(result.protected[0]?.examplesTruncated).toBe(true);
    expect(result.protected[0]?.reasons.map((r) => r.count)).toEqual([1, 450]);
    expect(
      result.protected[0]?.reasons.flatMap((r) => r.examples)
    ).toHaveLength(20);
    expect(result.rows).toBeGreaterThanOrEqual(900);
    expect(db.inTransaction).toBe(false);
  } finally {
    db.close();
  }
});

test("task and child-workflow report obligations validate through their actual invocation owners", async () => {
  const db = new Database(":memory:");
  const store = createStore(db, lease);
  try {
    const run = Effect.runSync(
      store.submit(
        {
          input: null,
          kind: "workflow",
          reportPlan: [
            { ...entry, attachmentId: "task-summary", scope: "invocation" },
            {
              ...entry,
              attachmentId: "child-summary",
              scope: "invocation",
              targetId: "child",
              targetKind: "workflow",
            },
          ],
          requestKey: "source",
          targetId: "parent",
        },
        runRevision,
        "owner"
      )
    );
    Effect.runSync(
      store.registerInvocation(run.runId, "leaf", "leaf-engine", {
        taskId: "source",
      })
    );
    Effect.runSync(
      store.registerWorkflowInvocation(run.runId, "child-path", "child")
    );
    const sources = Effect.runSync(store.reportPendingSources("Armed"));
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      Effect.runSync(
        store.reportSettleSource(source.sourceId, "Succeeded", null, null)
      );
      Effect.runSync(store.reportMaterialize(source.sourceId));
    }
    const result = await Effect.runPromise(
      inspectReclaimDependencies(db, revisions, active)
    );
    expect(
      result.protected.find((p) => p.revision === runRevision)?.reasons[0]
        ?.count
    ).toBe(1);
    db.exec("PRAGMA foreign_keys=OFF; DELETE FROM host_workflow_invocations");
    const failure = await Effect.runPromise(
      inspectReclaimDependencies(db, revisions, active).pipe(Effect.flip)
    );
    expect(failure.code).toBe("RevisionUnavailable");
  } finally {
    db.close();
  }
});

test("held and authorized manual entries remain dependencies without consuming authorizations", async () => {
  const db = new Database(":memory:");
  const store = createStore(db, lease);
  try {
    const run = Effect.runSync(
      store.submit(
        { input: null, kind: "task", requestKey: "run", targetId: "source" },
        runRevision,
        "owner"
      )
    );
    Effect.runSync(
      store.registerInvocation(run.runId, "node", "engine", {
        taskId: "source",
      })
    );
    Effect.runSync(
      store.admitAttempt(run.runId, "node", 1, "manual", { taskVersion: 1 })
    );
    expect(
      Effect.runSync(
        store.admitAttempt(run.runId, "node", 1, "manual", { taskVersion: 1 })
      )
    ).toBe("NeedsAttention");
    const held = await Effect.runPromise(
      inspectReclaimDependencies(db, revisions, active)
    );
    const assessment = Effect.runSync(
      store.recoveryGet({ runId: run.runId }, "owner")
    );
    if (!assessment.token) {
      throw new Error("Expected recoverable hold");
    }
    Effect.runSync(
      store.recover(
        {
          acknowledgeReexecution: true,
          requestKey: "recover",
          runId: run.runId,
          token: assessment.token,
        },
        "owner"
      )
    );
    const before = db.serialize();
    const authorized = await Effect.runPromise(
      inspectReclaimDependencies(db, revisions, active)
    );
    expect(authorized.protected).toEqual(held.protected);
    expect(authorized.digest).not.toBe(held.digest);
    expect(db.serialize()).toEqual(before);
  } finally {
    db.close();
  }
});

const flow = Workflow.make(
  {
    error: Schema.Never,
    id: "scheduled",
    input: Schema.Null,
    success: Schema.Null,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    return yield* graph.input(Schema.Null);
  })
);
const schedules = (...ids: string[]) =>
  new Map(
    ids.map((id) => [
      id,
      WorkflowSchedule.make({
        cron: "* * * * *",
        id,
        input: null,
        workflow: flow,
      }),
    ])
  );

test("paused and idle schedules protect code; removed definitions protect only pending slots, and scheduler remains protected", async () => {
  const db = new Database(":memory:");
  const store = createStore(db, lease);
  try {
    Effect.runSync(
      store.scheduleReconcile(
        schedules("paused", "idle", "removed", "pending"),
        scheduleRevision,
        Date.now()
      )
    );
    db.exec(
      "UPDATE host_schedules SET pauseJson='{}' WHERE scheduleId='paused'; UPDATE host_schedules SET removed=1 WHERE scheduleId IN ('removed','pending'); UPDATE host_schedules SET pendingSlot=1000 WHERE scheduleId='pending'"
    );
    db.query(
      "UPDATE host_schedules SET revision=? WHERE scheduleId='pending'"
    ).run(pendingRevision);
    db.query(
      "UPDATE host_schedules SET revision=? WHERE scheduleId='removed'"
    ).run(unusedRevision);
    db.query("UPDATE host_scheduler SET revision=?").run(candidateRevision);
    const before = db.serialize();
    const result = await Effect.runPromise(
      inspectReclaimDependencies(db, revisions, active)
    );
    expect(result.protected.map((p) => p.revision)).toEqual([
      active,
      scheduleRevision,
      pendingRevision,
      candidateRevision,
    ]);
    expect(
      result.protected.find((p) => p.revision === scheduleRevision)?.reasons[0]
        ?.count
    ).toBe(2);
    expect(db.serialize()).toEqual(before);
    db.exec(
      "UPDATE host_schedules SET activeRunId='absent' WHERE scheduleId='removed'"
    );
    const refused = await Effect.runPromise(
      inspectReclaimDependencies(db, revisions, active).pipe(Effect.flip)
    );
    expect(refused.code).toBe("RevisionUnavailable");
  } finally {
    db.close();
  }
});

test.each([
  "UPDATE host_runs SET revision='invalid'",
  "UPDATE host_runs SET status='FutureStatus'",
  "UPDATE host_invocations SET runId='absent'",
  "UPDATE host_attempts SET nodeId='absent'",
  "UPDATE host_attempt_windows SET attempt=999",
  "UPDATE host_report_sources SET sourceRunId='absent'",
  "UPDATE host_report_sources SET phase='FuturePhase'",
  "UPDATE host_report_sources SET sourceJson=json_set(sourceJson,'$.revision','wrong')",
  "UPDATE host_report_groups SET sourceRunId='absent'",
  "UPDATE host_report_groups SET latestGeneration=999",
  "UPDATE host_report_groups SET attachmentIndex=99",
  "UPDATE host_reports SET reportRunId='absent' WHERE reportRunId IS NOT NULL",
  "UPDATE host_reports SET generation=999 WHERE generation=1",
  "UPDATE host_runs SET reportJson='{}' WHERE reportJson IS NOT NULL",
  "UPDATE host_runs SET reportJson=NULL WHERE reportJson IS NOT NULL",
  "UPDATE host_runs SET admissionLane='manual' WHERE reportJson IS NOT NULL",
  "UPDATE host_reports SET reportRunId=NULL WHERE reportRunId IS NOT NULL",
  "UPDATE host_report_cancellations SET position=maximum+1",
  "UPDATE host_report_cancellations SET receiptJson='{}'",
  "UPDATE host_outbox SET kind='FutureIntent'",
  "DROP TABLE host_report_plans",
  "DROP TABLE host_fences",
])("inconsistent dependency refuses without mutation: %s", async (fault) => {
  const f = fixture();
  try {
    f.db.exec("PRAGMA foreign_keys=OFF");
    f.db.exec(fault);
    const before = f.db.serialize();
    const failure = await Effect.runPromise(f.inspect().pipe(Effect.flip));
    expect(failure.code).toBe("RevisionUnavailable");
    expect(f.db.serialize()).toEqual(before);
    expect(f.db.inTransaction).toBe(false);
  } finally {
    f.db.close();
  }
});

test("pending extensions protect both base and activation candidate; completed receipts do not", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "effectory-reclaim-extensions-")
  );
  mkdirSync(path.join(directory, ".effectory"));
  const db = new Database(":memory:");
  createStore(db, lease);
  try {
    const journal = createExtensionJournal(db, directory, lease);
    journal.recover();
    const operation = journal.accept(
      {
        expectedRevision: lockRevision(emptyLock),
        kind: "Add",
        requestKey: "add",
        source: {
          assetName: "effectory.tgz",
          ref: "v1",
          repository: "example/example",
        },
        trust: true,
      },
      "owner",
      active
    );
    journal.start(operation.operationId, "owner");
    journal.candidate(operation.operationId, "owner", emptyLock);
    journal.begin(operation.operationId, "owner", candidateRevision);
    const inspect = (pointer = active) =>
      inspectReclaimDependencies(db, revisions, pointer);
    const before = db.serialize();
    const result = await Effect.runPromise(inspect());
    expect(result.protected.map((p) => p.revision)).toEqual([
      active,
      candidateRevision,
    ]);
    expect(result.protected[0]?.reasons.map((r) => r.kind)).toEqual([
      "Active",
      "ExtensionOperation",
    ]);
    const published = await Effect.runPromise(inspect(candidateRevision));
    expect(published.protected.map((p) => p.revision)).toEqual([
      active,
      candidateRevision,
    ]);
    const refused = await Effect.runPromise(
      inspect(unusedRevision).pipe(Effect.flip)
    );
    expect(refused.code).toBe("RevisionUnavailable");
    expect(db.serialize()).toEqual(before);
    journal.recover();
    const completed = await Effect.runPromise(inspect(candidateRevision));
    expect(completed.protected.map((p) => p.revision)).toEqual([
      candidateRevision,
    ]);
  } finally {
    db.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an accepted run-family deletion blocks reclamation while a completed run protects its code", async () => {
  const db = new Database(":memory:");
  const store = createStore(db, lease);
  try {
    const run = Effect.runSync(
      store.submit(
        { input: null, kind: "task", requestKey: "run", targetId: "source" },
        runRevision,
        "owner"
      )
    );
    Effect.runSync(store.project(run.runId, "Succeeded", null));
    db.exec("UPDATE host_outbox SET delivered=1");
    const retirement = createRetirementStore(db, "repository", "owner");
    await Effect.runPromise(retirement.plan({ runId: run.runId }));
    db.query(
      "UPDATE host_retirement_plans SET state='Applying',startedAt=?"
    ).run(new Date().toISOString());
    const before = db.serialize();
    const failure = await Effect.runPromise(
      inspectReclaimDependencies(db, revisions, active).pipe(Effect.flip)
    );
    expect(failure.code).toBe("Conflict");
    expect(db.serialize()).toEqual(before);
  } finally {
    db.close();
  }
});

test("pending outbox and ordinary pages spend the same million-header budget", async () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE headers(id INTEGER PRIMARY KEY); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500001) INSERT INTO headers SELECT x FROM n;
    CREATE TABLE host_runs(runId TEXT PRIMARY KEY); INSERT INTO host_runs VALUES('run');
    CREATE TABLE host_waits(waitId TEXT PRIMARY KEY,runId TEXT,status TEXT);
    CREATE TABLE host_outbox(id INTEGER PRIMARY KEY,kind TEXT,runId TEXT,waitId TEXT,delivered INTEGER);
    CREATE INDEX host_outbox_pending ON host_outbox(delivered,id);
    INSERT INTO host_outbox SELECT id,'Dispatch','run',NULL,0 FROM headers;`);
  const budget = inspectionBudget("Test inspection");
  try {
    await Effect.runPromise(
      upgradeScanner(db, budget).scan(
        "headers",
        "SELECT id position FROM headers WHERE /* after */ ORDER BY id LIMIT ?",
        () => {}
      )
    );
    const failure = await Effect.runPromise(
      inspectUpgradeOutbox(db, budget).pipe(Effect.flip)
    );
    expect(failure.code).toBe("LimitExceeded");
    expect(budget.snapshot.rows).toBe(1_000_001);
    expect(db.inTransaction).toBe(false);
    expect(
      db.query("SELECT count(*) n FROM host_outbox WHERE delivered=0").get()
    ).toEqual({ n: 500_001 });
  } finally {
    db.close();
  }
}, 30_000);
