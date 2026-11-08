import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { Effect } from "effect";

import { inspectUpgradeWork } from "../src/upgrade-work.ts";

function fixture() {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE host_runs(runId TEXT PRIMARY KEY, revision TEXT, status TEXT);
    CREATE TABLE host_report_groups(groupId TEXT PRIMARY KEY, sourceRunId TEXT);
    CREATE TABLE host_reports(sequence INTEGER PRIMARY KEY, reportId TEXT, groupId TEXT, status TEXT);
    CREATE TABLE host_report_sources(sourceSeq INTEGER PRIMARY KEY, sourceId TEXT, sourceRunId TEXT, phase TEXT);
    CREATE TABLE host_report_cancellations(batchId TEXT PRIMARY KEY,sourceRunId TEXT,maximum INTEGER,position INTEGER);
    CREATE TABLE host_schedules(identity INTEGER PRIMARY KEY,scheduleId TEXT,revision TEXT,pendingSlot REAL);
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<450)
      INSERT INTO host_runs SELECT 'run-'||x,'older','Succeeded' FROM n;
    INSERT INTO host_runs VALUES ('queued','older','Queued'),('running','older','Running'),('waiting','older','Waiting'),
      ('retrying','older','Retrying'),('cancelling','older','Cancelling'),('held','older','NeedsAttention'),
      ('current','current','Succeeded');
    INSERT INTO host_report_groups VALUES('group','run-1');
    INSERT INTO host_reports VALUES (1,'waiting-report','group','WaitingSource'),(2,'queued-report','group','Queued'),
      (3,'running-report','group','Running'),(4,'held-report','group','NeedsAttention'),(5,'done-report','group','Succeeded'),
      (6,'failed-report','group','Failed'),(7,'cancelled-report','group','Cancelled'),(8,'excluded-report','group','NotApplicable');
    INSERT INTO host_report_sources VALUES (1,'armed','run-1','Armed'),(2,'ready','run-1','Ready'),(3,'done','run-1','Materialized');
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<450)
      INSERT INTO host_report_cancellations SELECT 'batch-'||x,'run-1',10,10 FROM n;
    INSERT INTO host_report_cancellations VALUES('pending','run-1',20,0);
    INSERT INTO host_schedules VALUES(1,'pending','older',1000),(2,'idle','current',NULL);
  `);
  return db;
}

test("breaking-work inventory includes held runs, unsettled reports/continuations and pending schedule slots, across every page", async () => {
  const db = fixture();
  try {
    const before = db.serialize();
    const result = await Effect.runPromise(inspectUpgradeWork(db));
    expect(result.counts).toEqual({
      reportCancellations: 1,
      reportSources: 2,
      reports: 4,
      runs: 6,
      scheduledAdmissions: 1,
    });
    expect(result.rows).toBe(457 + 8 + 3 + 451 + 2);
    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0]?.revision).toBe("older");
    expect(result.revisions[0]?.examples).toHaveLength(14);
    expect(result.revisions[0]?.examplesTruncated).toBe(false);
    expect(db.serialize()).toEqual(before);
    expect(db.inTransaction).toBe(false);
  } finally {
    db.close();
  }
});

test("inventory samples stay bounded while complete counts include all affected work", async () => {
  const db = fixture();
  try {
    db.run("UPDATE host_runs SET status='Running' WHERE revision='older'");
    const result = await Effect.runPromise(inspectUpgradeWork(db));
    expect(result.counts.runs).toBe(456);
    expect(result.revisions[0]?.examples).toHaveLength(20);
    expect(result.revisions[0]?.examplesTruncated).toBe(true);
  } finally {
    db.close();
  }
});

test.each([
  "UPDATE host_runs SET status='Unknown' WHERE runId='run-450'",
  "UPDATE host_reports SET groupId='absent' WHERE sequence=8",
  "UPDATE host_report_sources SET phase='Future' WHERE sourceSeq=3",
  "UPDATE host_report_cancellations SET position=21 WHERE batchId='pending'",
  "UPDATE host_schedules SET pendingSlot='invalid' WHERE identity=2",
  "DROP TABLE host_report_cancellations",
])(
  "unsupported inventory refuses without projecting or settling state: %s",
  async (mutation) => {
    const db = fixture();
    try {
      db.run(mutation);
      const before = db.serialize();
      const failure = await Effect.runPromise(
        inspectUpgradeWork(db).pipe(Effect.flip)
      );
      expect(failure.code).toBe("RevisionUnavailable");
      expect(db.serialize()).toEqual(before);
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  }
);
