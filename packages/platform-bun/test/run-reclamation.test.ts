/* oxlint-disable unicorn/no-await-expression-member, no-await-in-loop -- Assertions inspect awaited results; process readiness is polled sequentially. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Workflow, WorkflowSchedule, Artifact } from "@offtree/effectory-sdk";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { createStore } from "../src/host-store.ts";
import {
  versionIsProtected,
  versionProtection,
} from "../src/lake-protection.ts";
import { createLake } from "../src/lake.ts";
import { RepositoryLease, ownershipLayer } from "../src/ownership.ts";
import type { EncodedReportPlan } from "../src/report-plan.ts";
import {
  reclaimRuns,
  recoverRunReclamation,
  retirementMarker,
} from "../src/run-reclamation.ts";
import { createRetirementStore } from "../src/run-retirement-store.ts";

const attachment: EncodedReportPlan[number] = {
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
function required<A>(value: A | null | undefined): A {
  if (value === null || value === undefined) {
    throw new Error("Missing fixture value");
  }
  return value;
}
const idOf = Schema.decodeUnknownSync(Schema.Struct({ planId: Schema.String }));
const errorCode = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? Reflect.get(
        Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as object,
        "code"
      )
    : undefined;
function fixture() {
  const repository = mkdtempSync(path.join(tmpdir(), "effectory-run-reclaim-"));
  const directory = path.join(repository, ".effectory");
  mkdirSync(directory);
  writeFileSync(
    path.join(directory, "credentials.json"),
    JSON.stringify({ repositoryId: "repo", token: "synthetic" })
  );
  const filename = path.join(directory, "state.sqlite");
  const db = new Database(filename);
  const lease = { assertActive: () => {}, token: "test-owner" };
  const host = createStore(db, lease);
  const lake = createLake(db, path.join(directory, "blobs"), lease);
  const submit = (key: string, reportPlan: EncodedReportPlan = []) =>
    Effect.runSync(
      host.submit(
        {
          input: { key },
          kind: "task",
          reportPlan,
          requestKey: key,
          targetId: "source",
        },
        "revision",
        "owner"
      )
    );
  const finish = (id: string) => {
    Effect.runSync(host.project(id, "Succeeded", { ok: true }));
    db.query("UPDATE host_outbox SET delivered=1 WHERE runId=?").run(id);
  };
  return {
    close: () => {
      db.close();
      rmSync(repository, { force: true, recursive: true });
    },
    db,
    directory,
    filename,
    finish,
    host,
    lake,
    lease,
    repository,
    submit,
  };
}
test("offline whole-family retirement preserves artifacts and permanent submission identity", async () => {
  const f = fixture();
  try {
    const root = f.submit("source", [attachment]);
    const wait = Effect.runSync(
      f.host.openWait({
        context: null,
        deadline: Date.now() + 60_000,
        kind: "approval",
        nodeId: "wait",
        runId: root.runId,
      })
    );
    Effect.runSync(f.host.admitAttempt(root.runId, "publish", 1, "idempotent"));
    const artifact = Artifact.make({
      id: "result",
      schema: Schema.Int,
      version: 1,
    });
    const ref = await Effect.runPromise(
      f.lake.publish(
        {
          attempt: 1,
          attemptId: "attempt",
          invocationPath: "publish",
          revision: "revision",
          runId: root.runId,
          taskId: "source",
          taskVersion: 1,
        },
        "result",
        artifact,
        42,
        { key: "result" }
      )
    );
    f.finish(root.runId);
    for (const source of Effect.runSync(f.host.reportPendingSources("Ready"))) {
      Effect.runSync(f.host.reportMaterialize(source.sourceId));
    }
    const report = Effect.runSync(f.host.reportPromote());
    expect(report).not.toBeNull();
    if (!report) {
      throw new Error("Missing report");
    }
    f.finish(report.runId);
    const { reportId } = required(report.report);
    const before = versionProtection(f.db, 1);
    expect(before.producerRunId).toBeNull();
    const planned = await Effect.runPromise(
      reclaimRuns(f.repository, {
        kind: "plan",
        selector: { runId: root.runId },
      })
    );
    const { planId } = idOf(planned);
    expect(planned).toMatchObject({
      families: [{ reports: 1, runs: 2, sourceRunId: root.runId }],
      hasMore: false,
    });
    const receipt = await Effect.runPromise(
      reclaimRuns(f.repository, { kind: "apply", planId })
    );
    expect(receipt).toMatchObject({ retiredFamilies: 1, retiredRuns: 2 });
    expect(f.db.query("SELECT COUNT(*) count FROM host_runs").get()).toEqual({
      count: 0,
    });
    for (const table of [
      "host_reports",
      "host_report_sources",
      "host_report_paths",
      "host_report_search",
      "host_report_search_tags",
      "host_events",
      "host_report_plans",
    ]) {
      expect(f.db.query(`SELECT COUNT(*) count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    }
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.db.query("SELECT COUNT(*) count FROM lake_records").get()).toEqual(
      { count: 1 }
    );
    expect(
      errorCode(Effect.runSyncExit(f.host.getWait(wait.waitId, "owner", true)))
    ).toBe("Conflict");
    expect(
      errorCode(Effect.runSyncExit(f.host.getWait(wait.waitId, "owner")))
    ).toBe("NotFound");
    expect(
      errorCode(Effect.runSyncExit(f.host.getWait(wait.waitId, "other", true)))
    ).toBe("NotFound");
    expect(versionIsProtected(f.db, 1)).toBe(false);
    expect(versionProtection(f.db, 1).producerRunId).toBeNull();
    expect(
      (
        await Effect.runPromise(
          f.lake.get(ref.artifactId, ref.version, "owner")
        )
      ).value
    ).toBe(42);
    expect(
      errorCode(
        Effect.runSyncExit(
          f.host.lookupSubmission(
            {
              input: { key: "source" },
              kind: "task",
              requestKey: "source",
              targetId: "source",
            },
            "owner"
          )
        )
      )
    ).toBe("Conflict");
    expect(
      errorCode(
        Effect.runSyncExit(
          f.host.submit(
            {
              input: { key: "source" },
              kind: "task",
              requestKey: "source",
              targetId: "source",
            },
            "revision",
            "owner"
          )
        )
      )
    ).toBe("Conflict");
    expect(
      errorCode(
        Effect.runSyncExit(
          f.host.reportRetry(
            { reportId, requestKey: "retry" },
            "owner",
            () => {}
          )
        )
      )
    ).toBe("Conflict");
    expect(
      errorCode(
        Effect.runSyncExit(
          f.host.cancelRequest(
            { requestKey: "cancel", runId: root.runId },
            "owner"
          )
        )
      )
    ).toBe("Conflict");
    expect(
      errorCode(Effect.runSyncExit(f.host.getRun(root.runId, "other")))
    ).toBe("NotFound");
    expect(
      await Effect.runPromise(
        reclaimRuns(f.repository, { kind: "inspect", runId: root.runId })
      )
    ).toMatchObject({
      runId: root.runId,
      sourceRunId: root.runId,
      status: "Succeeded",
    });
    f.db
      .query("UPDATE host_retirement_plans SET expiresAt=0 WHERE planId=?")
      .run(planId);
    expect(
      await Effect.runPromise(
        reclaimRuns(f.repository, { kind: "apply", planId })
      )
    ).toEqual(receipt);
    expect(existsSync(path.join(f.directory, retirementMarker))).toBe(false);
  } finally {
    f.close();
  }
});
test("unfinished work is protected, new report generations invalidate a plan, and epochs expire old cursors", async () => {
  const f = fixture();
  try {
    const live = f.submit("live");
    const done = f.submit("done");
    f.finish(done.runId);
    const old = Effect.runSync(f.host.history({ limit: 1 }, "owner"));
    expect(old.cursor).not.toBeNull();
    const plan = await Effect.runPromise(
      reclaimRuns(f.repository, {
        kind: "plan",
        selector: { completedBefore: "2100-01-01T00:00:00.000Z" },
      })
    );
    expect(plan).toMatchObject({
      families: [{ sourceRunId: done.runId }],
      protected: { UnfinishedRun: 1 },
    });
    await Effect.runPromise(
      reclaimRuns(f.repository, { kind: "apply", planId: idOf(plan).planId })
    );
    expect(
      errorCode(
        Effect.runSyncExit(
          f.host.history({ cursor: required(old.cursor), limit: 1 }, "owner")
        )
      )
    ).toBe("CursorExpired");
    expect(Effect.runSync(f.host.getRun(live.runId)).status).toBe("Queued");
    const source = f.submit("reports", [attachment]);
    f.finish(source.runId);
    const pending = await Effect.runPromise(
      reclaimRuns(f.repository, {
        kind: "plan",
        selector: { runId: source.runId },
      })
    );
    expect(pending).toMatchObject({
      families: [],
      protected: { PendingReports: 1 },
    });
    for (const ready of Effect.runSync(f.host.reportPendingSources("Ready"))) {
      Effect.runSync(f.host.reportMaterialize(ready.sourceId));
    }
    const run = Effect.runSync(f.host.reportPromote());
    if (!run) {
      throw new Error("No report");
    }
    f.finish(run.runId);
    const planned = idOf(
      await Effect.runPromise(
        reclaimRuns(f.repository, {
          kind: "plan",
          selector: { runId: source.runId },
        })
      )
    );
    Effect.runSync(
      f.host.reportRetry(
        {
          reportId: required(run.report).reportId,
          requestKey: "new-generation",
        },
        "owner",
        () => {}
      )
    );
    expect(
      errorCode(
        await Effect.runPromiseExit(
          reclaimRuns(f.repository, { kind: "apply", planId: planned.planId })
        )
      )
    ).toBe("Conflict");
    expect(
      f.db
        .query(
          "SELECT COUNT(*) count FROM host_retired_runs WHERE sourceRunId=?"
        )
        .get(source.runId)
    ).toEqual({ count: 0 });
  } finally {
    f.close();
  }
});
test("durable intent recovers before host startup without rebuilding a user Layer", async () => {
  const f = fixture();
  try {
    const run = f.submit("crash");
    f.finish(run.runId);
    const { planId } = idOf(
      await Effect.runPromise(
        reclaimRuns(f.repository, {
          kind: "plan",
          selector: { runId: run.runId },
        })
      )
    );
    const failed = await Effect.runPromiseExit(
      reclaimRuns(f.repository, { kind: "apply", planId }, (stage) =>
        stage === "intent" ? Effect.die("injected crash") : Effect.void
      )
    );
    expect(Exit.isFailure(failed)).toBe(true);
    expect(
      readFileSync(path.join(f.directory, retirementMarker), "utf-8")
    ).toBe("1\n");
    expect(
      f.db
        .query("SELECT state FROM host_retirement_plans WHERE planId=?")
        .get(planId)
    ).toEqual({ state: "Applying" });
    await Effect.runPromise(
      recoverRunReclamation(f.filename).pipe(
        Effect.provide(ownershipLayer(`${f.filename}.owner`))
      )
    );
    expect(f.db.query("SELECT COUNT(*) count FROM host_runs").get()).toEqual({
      count: 0,
    });
    expect(existsSync(path.join(f.directory, retirementMarker))).toBe(false);
    expect(
      await Effect.runPromise(
        reclaimRuns(f.repository, { kind: "apply", planId })
      )
    ).toMatchObject({ retiredRuns: 1 });
    const compact = await Effect.runPromise(
      reclaimRuns(f.repository, { kind: "compact" })
    );
    expect(compact).toHaveProperty("afterBytes");
  } finally {
    f.close();
  }
});
test("preview is owner-scoped and strict, and unknown completion evidence remains protected", async () => {
  const f = fixture();
  try {
    const run = f.submit("legacy");
    f.finish(run.runId);
    f.db.query("DELETE FROM host_run_completions WHERE runId=?").run(run.runId);
    f.db.query("DELETE FROM host_events WHERE runId=?").run(run.runId);
    expect(
      await Effect.runPromise(
        reclaimRuns(f.repository, {
          kind: "plan",
          selector: { runId: run.runId },
        })
      )
    ).toMatchObject({ families: [], protected: { UnknownCompletion: 1 } });
    const other = createRetirementStore(f.db, "repo", "other");
    expect(
      errorCode(await Effect.runPromiseExit(other.plan({ runId: run.runId })))
    ).toBe("NotFound");
    expect(
      errorCode(
        await Effect.runPromiseExit(
          reclaimRuns(f.repository, { kind: "plan", selector: {} })
        )
      )
    ).toBe("InvalidInput");
    expect(
      errorCode(
        await Effect.runPromiseExit(
          reclaimRuns(f.repository, {
            kind: "plan",
            selector: { completedBefore: "nonsense" },
          })
        )
      )
    ).toBe("InvalidInput");
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* RepositoryLease;
        const busy = yield* Effect.promise(() =>
          Effect.runPromiseExit(reclaimRuns(f.repository, { kind: "compact" }))
        );
        expect(Exit.isFailure(busy)).toBe(true);
      }).pipe(Effect.provide(ownershipLayer(`${f.filename}.owner`)))
    );
  } finally {
    f.close();
  }
});

test("scheduled summaries survive retirement, foreign consumer pins remain, and unknown producers stay protected", async () => {
  const f = fixture();
  try {
    const Flow = Workflow.make(
      {
        error: Schema.Never,
        id: "scheduled",
        input: Schema.Null,
        success: Schema.Null,
        version: 1,
      },
      Effect.succeed(null)
    );
    const schedule = WorkflowSchedule.make({
      cron: "* * * * *",
      id: "minute",
      input: null,
      workflow: Flow,
    });
    const at = Math.floor(Date.now() / 60_000) * 60_000;
    Effect.runSync(
      f.host.scheduleReconcile(
        new Map([[schedule.id, schedule]]),
        "revision",
        at
      )
    );
    Effect.runSync(f.host.scheduleTick(schedule.id, at + 60_000, false));
    const run = required(Effect.runSync(f.host.listRuns())[0]);
    f.finish(run.runId);
    const before = Effect.runSync(
      f.host.scheduleGet(schedule.id, "owner", at + 60_000)
    );
    const { planId } = idOf(
      await Effect.runPromise(
        reclaimRuns(f.repository, {
          kind: "plan",
          selector: { runId: run.runId },
        })
      )
    );
    await Effect.runPromise(
      reclaimRuns(f.repository, { kind: "apply", planId })
    );
    expect(
      Effect.runSync(f.host.scheduleGet(schedule.id, "owner", at + 60_000))
        .lastRun
    ).toEqual(before.lastRun);
    const history = Effect.runSync(
      f.host.scheduleHistory({ scheduleId: schedule.id }, "owner", at + 60_000)
    );
    expect(
      history.items.some(
        (item) => item._tag === "Admitted" && item.status === "Succeeded"
      )
    ).toBe(true);
    const producer = f.submit("producer");
    Effect.runSync(
      f.host.admitAttempt(producer.runId, "publish", 1, "idempotent")
    );
    const art = Artifact.make({ id: "held", schema: Schema.Int, version: 1 });
    await Effect.runPromise(
      f.lake.publish(
        {
          attempt: 1,
          attemptId: "pin-attempt",
          invocationPath: "publish",
          revision: "revision",
          runId: producer.runId,
          taskId: "source",
          taskVersion: 1,
        },
        "value",
        art,
        7,
        { key: "value" }
      )
    );
    f.finish(producer.runId);
    const consumer = f.submit("consumer");
    f.db
      .query("INSERT INTO lake_consumer_pins VALUES(?,1)")
      .run(consumer.runId);
    const selected = idOf(
      await Effect.runPromise(
        reclaimRuns(f.repository, {
          kind: "plan",
          selector: { runId: producer.runId },
        })
      )
    );
    await Effect.runPromise(
      reclaimRuns(f.repository, { kind: "apply", planId: selected.planId })
    );
    expect(versionProtection(f.db, 1).consumerRunIds).toEqual([consumer.runId]);
    expect(versionIsProtected(f.db, 1)).toBe(true);
    f.finish(consumer.runId);
    const final = idOf(
      await Effect.runPromise(
        reclaimRuns(f.repository, {
          kind: "plan",
          selector: { runId: consumer.runId },
        })
      )
    );
    await Effect.runPromise(
      reclaimRuns(f.repository, { kind: "apply", planId: final.planId })
    );
    expect(
      f.db.query("SELECT COUNT(*) count FROM lake_consumer_pins").get()
    ).toEqual({ count: 0 });
    expect(versionIsProtected(f.db, 1)).toBe(false);
    f.db
      .query(
        "UPDATE lake_records SET metadataJson=json_set(metadataJson,'$.runId','unexplained-missing') WHERE sequence=1"
      )
      .run();
    expect(versionIsProtected(f.db, 1)).toBe(true);
  } finally {
    f.close();
  }
});

test("plan selection is bounded and ordered by latest completion, and legacy admission format upgrades fail closed", async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 105; n += 1) {
      const run = f.submit(`many-${n}`);
      f.finish(run.runId);
      f.db
        .query("UPDATE host_run_completions SET completedAt=? WHERE runId=?")
        .run(new Date(100_000 + n * 1000).toISOString(), run.runId);
    }
    const plan = await Effect.runPromise(
      reclaimRuns(f.repository, {
        kind: "plan",
        selector: { completedBefore: "2020-01-01T00:00:00.000Z" },
      })
    );
    const decoded = Schema.decodeUnknownSync(
      Schema.Struct({
        families: Schema.Array(Schema.Struct({ completedAt: Schema.String })),
        hasMore: Schema.Boolean,
      })
    )(plan);
    expect(decoded.families).toHaveLength(100);
    expect(decoded.hasMore).toBe(true);
    expect(decoded.families[0]?.completedAt).toBe(
      new Date(100_000).toISOString()
    );
    await Effect.runPromise(
      reclaimRuns(f.repository, { kind: "apply", planId: idOf(plan).planId })
    );
    const remaining = await Effect.runPromise(
      reclaimRuns(f.repository, {
        kind: "plan",
        selector: { completedBefore: "2020-01-01T00:00:00.000Z" },
      })
    );
    expect(
      Schema.decodeUnknownSync(
        Schema.Struct({ families: Schema.Array(Schema.Unknown) })
      )(remaining).families
    ).toHaveLength(5);
    f.db.exec(
      "ALTER TABLE host_runs RENAME COLUMN admissionLane TO admissionNamespace"
    );
    createStore(f.db, f.lease);
    const columns = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ name: Schema.String }))
    )(f.db.query("PRAGMA table_info(host_runs)").all());
    expect(columns.some((c) => c.name === "admissionNamespace")).toBe(false);
    expect(columns.some((c) => c.name === "admissionLane")).toBe(true);
  } finally {
    f.close();
  }
});

test("full SQLite intent rolls back before any history is removed and can be retried", async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 100; n += 1) {
      f.finish(f.submit(`full-${n}`).runId);
    }
    const store = createRetirementStore(f.db, "repo", "owner");
    const plan = await Effect.runPromise(
      store.plan({ completedBefore: "2099-01-01T00:00:00Z" })
    );
    f.db.exec("CREATE TABLE retirement_space_pressure (value BLOB)");
    const pageCount = required(
      f.db.query<{ page_count: number }, []>("PRAGMA page_count").get()
    ).page_count;
    f.db.exec(`PRAGMA max_page_count=${pageCount + 8}`);
    let full = false;
    try {
      for (let n = 0; n < 1000; n += 1) {
        f.db
          .query("INSERT INTO retirement_space_pressure VALUES(zeroblob(4096))")
          .run();
      }
    } catch (error) {
      full =
        typeof error === "object" &&
        error !== null &&
        Reflect.get(error, "code") === "SQLITE_FULL";
    }
    expect(full).toBe(true);
    expect(() => store.begin(plan.planId)).toThrow();
    expect(
      f.db.query("SELECT COUNT(*) count FROM host_retired_runs").get()
    ).toEqual({ count: 0 });
    expect(f.db.query("SELECT COUNT(*) count FROM host_runs").get()).toEqual({
      count: 100,
    });
    expect(store.load(plan.planId).state).toBe("Planned");
    f.db.exec(
      "DROP TABLE retirement_space_pressure; PRAGMA max_page_count=1073741823"
    );
    expect(
      await Effect.runPromise(
        reclaimRuns(f.repository, { kind: "apply", planId: plan.planId })
      )
    ).toMatchObject({ retiredRuns: 100 });
  } finally {
    f.close();
  }
});

test("expired plans and malformed durable records fail closed", async () => {
  const f = fixture();
  try {
    const run = f.submit("strict");
    f.finish(run.runId);
    const store = createRetirementStore(f.db, "repo", "owner");
    const plan = await Effect.runPromise(store.plan({ runId: run.runId }));
    f.db
      .query("UPDATE host_retirement_plans SET expiresAt=0 WHERE planId=?")
      .run(plan.planId);
    expect(
      errorCode(
        await Effect.runPromiseExit(
          reclaimRuns(f.repository, { kind: "apply", planId: plan.planId })
        )
      )
    ).toBe("Conflict");
    expect(existsSync(path.join(f.directory, retirementMarker))).toBe(false);
    expect(Effect.runSync(f.host.getRun(run.runId)).status).toBe("Succeeded");
    expect(
      errorCode(
        await Effect.runPromiseExit(
          createRetirementStore(f.db, "wrong-repository", "owner").validate(
            plan.planId
          )
        )
      )
    ).toBe("Conflict");
    const next = await Effect.runPromise(store.plan({ runId: run.runId }));
    f.db
      .query("UPDATE host_retirement_plans SET summaryJson='{}' WHERE planId=?")
      .run(next.planId);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          reclaimRuns(f.repository, { kind: "apply", planId: next.planId })
        )
      )
    ).toBe(true);
    expect(existsSync(path.join(f.directory, retirementMarker))).toBe(false);
    f.db
      .query(
        "UPDATE host_run_completions SET completedAt='2026-02-30T00:00:00.000Z' WHERE runId=?"
      )
      .run(run.runId);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(store.plan({ runId: run.runId }))
      )
    ).toBe(true);
    writeFileSync(path.join(f.directory, retirementMarker), "invalid");
    expect(
      errorCode(
        await Effect.runPromiseExit(
          reclaimRuns(f.repository, { kind: "compact" })
        )
      )
    ).toBe("Unavailable");
    expect(
      readFileSync(path.join(f.directory, retirementMarker), "utf-8")
    ).toBe("invalid");
    expect(
      f.db.query("SELECT COUNT(*) count FROM host_retired_runs").get()
    ).toEqual({ count: 0 });
  } finally {
    f.close();
  }
});

test("a large settled report family is drained in bounded batches without leaving search projections", async () => {
  const f = fixture();
  try {
    const run = f.submit("large-family", [attachment]);
    const group = required(
      Effect.runSync(f.host.reportList({ runId: run.runId }, "owner")).items[0]
    ).groupId;
    f.finish(run.runId);
    f.db
      .query(`WITH RECURSIVE n(v) AS (SELECT 2 UNION ALL SELECT v+1 FROM n WHERE v<10000)
      INSERT INTO host_reports(reportId,groupId,generation,status,createdAt,settledAt)
      SELECT 'retirement-large-'||v,?,v,'Failed','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.001Z' FROM n`)
      .run(group);
    f.db
      .query(
        "UPDATE host_reports SET status='Failed',settledAt='2026-01-01T00:00:00.001Z' WHERE groupId=?"
      )
      .run(group);
    f.db
      .query(
        "UPDATE host_report_groups SET latestGeneration=10000 WHERE groupId=?"
      )
      .run(group);
    const plan = await Effect.runPromise(
      reclaimRuns(f.repository, {
        kind: "plan",
        selector: { runId: run.runId },
      })
    );
    expect(plan).toMatchObject({ families: [{ reports: 10_000, runs: 1 }] });
    let batches = 0;
    const receipt = await Effect.runPromise(
      reclaimRuns(
        f.repository,
        { kind: "apply", planId: idOf(plan).planId },
        (stage) =>
          Effect.sync(() => {
            if (stage === "delete/host_reports") {
              batches += 1;
            }
          })
      )
    );
    expect(batches).toBe(40);
    expect(receipt).toMatchObject({
      deletedRows: { host_report_search: 10_000, host_reports: 10_000 },
    });
    expect(
      f.db.query("SELECT COUNT(*) count FROM host_report_search").get()
    ).toEqual({ count: 0 });
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.close();
  }
}, 30_000);

test("SIGKILL during compaction leaves committed history intact and compaction retryable", async () => {
  const f = fixture();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const run = f.submit("vacuum");
    f.finish(run.runId);
    f.db.exec("CREATE TABLE retirement_compaction_fixture (payload BLOB)");
    const insert = f.db.query(
      "INSERT INTO retirement_compaction_fixture VALUES(zeroblob(16777216))"
    );
    for (let n = 0; n < 16; n += 1) {
      insert.run();
    }
    f.db.exec(
      "DELETE FROM retirement_compaction_fixture WHERE rowid%2=0; PRAGMA wal_checkpoint(TRUNCATE)"
    );
    const ready = path.join(f.directory, "vacuum-ready");
    const completed = path.join(f.directory, "vacuum-complete");
    child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "fixtures/run-reclamation-compact.ts"),
        f.repository,
        ready,
        completed,
      ],
      { stderr: "pipe", stdout: "ignore" }
    );
    for (let n = 0; n < 1000 && !existsSync(ready); n += 1) {
      await Bun.sleep(2);
    }
    expect(existsSync(ready)).toBe(true);
    await Bun.sleep(10);
    expect(existsSync(completed)).toBe(false);
    child.kill("SIGKILL");
    await child.exited;
    expect(f.db.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(Effect.runSync(f.host.getRun(run.runId)).status).toBe("Succeeded");
    const result = Schema.decodeUnknownSync(
      Schema.Struct({ afterBytes: Schema.Int, beforeBytes: Schema.Int })
    )(await Effect.runPromise(reclaimRuns(f.repository, { kind: "compact" })));
    expect(result.afterBytes).toBeLessThan(result.beforeBytes);
    expect(
      f.db
        .query("SELECT COUNT(*) count FROM retirement_compaction_fixture")
        .get()
    ).toEqual({ count: 8 });
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    f.close();
  }
}, 30_000);
