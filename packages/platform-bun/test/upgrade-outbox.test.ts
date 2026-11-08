import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { Cause, Effect, Exit, Option } from "effect";

import { inspectUpgradeOutbox } from "../src/upgrade-outbox.ts";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE host_runs(runId TEXT PRIMARY KEY); CREATE TABLE host_waits(waitId TEXT PRIMARY KEY,runId TEXT,status TEXT);
    CREATE TABLE host_outbox(id INTEGER PRIMARY KEY,kind TEXT,runId TEXT,waitId TEXT,delivered INTEGER);
    CREATE INDEX host_outbox_pending ON host_outbox(delivered,id);
    INSERT INTO host_runs VALUES('run');
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<450) INSERT INTO host_outbox SELECT x,'Dispatch','run',NULL,0 FROM n;`);
  return db;
}

test("upgrade pending-work scan covers later pages and never acknowledges intents", async () => {
  const db = fixture();
  try {
    const result = await Effect.runPromise(inspectUpgradeOutbox(db));
    expect(result.rows).toBe(450);
    expect(result.counts).toEqual({ Cancel: 0, Dispatch: 450, Settle: 0 });
    expect(
      db.query("SELECT count(*) AS n FROM host_outbox WHERE delivered=0").get()
    ).toEqual({ n: 450 });
    expect(db.inTransaction).toBe(false);
  } finally {
    db.close();
  }
});

test.each([
  "unknown",
  "orphan",
  "missing-wait",
  "foreign-wait",
  "open-wait",
  "unknown-wait-status",
] as const)(
  "upgrade refuses %s pending work beyond the runner's first page",
  async (fault) => {
    const db = fixture();
    try {
      if (fault === "unknown") {
        db.exec("UPDATE host_outbox SET kind='FutureOperation' WHERE id=450");
      }
      if (fault === "orphan") {
        db.exec("UPDATE host_outbox SET runId='absent' WHERE id=450");
      }
      if (
        fault === "missing-wait" ||
        fault === "foreign-wait" ||
        fault === "open-wait" ||
        fault === "unknown-wait-status"
      ) {
        db.exec(
          "UPDATE host_outbox SET kind='Settle',waitId='wait' WHERE id=450"
        );
        if (fault === "foreign-wait") {
          db.exec("INSERT INTO host_waits VALUES('wait','other','Answered')");
        }
        if (fault === "open-wait") {
          db.exec("INSERT INTO host_waits VALUES('wait','run','Open')");
        }
        if (fault === "unknown-wait-status") {
          db.exec("INSERT INTO host_waits VALUES('wait','run','FutureStatus')");
        }
      }
      const before = db.query("SELECT * FROM host_outbox ORDER BY id").all();
      const result = await Effect.runPromiseExit(inspectUpgradeOutbox(db));
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = Cause.findErrorOption(result.cause);
        expect(Option.isSome(error) && error.value.code).toBe(
          "RevisionUnavailable"
        );
        expect(Option.isSome(error) && error.value.message).toContain("450");
      }
      expect(db.query("SELECT * FROM host_outbox ORDER BY id").all()).toEqual(
        before
      );
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  }
);

test.each([null, -1, 0.5, 2, "future"])(
  "upgrade refuses an unsupported outbox delivery flag %s without acknowledging it",
  async (flag) => {
    const db = fixture();
    try {
      db.query("UPDATE host_outbox SET delivered=? WHERE id=450").run(flag);
      const failure = await Effect.runPromise(
        inspectUpgradeOutbox(db).pipe(Effect.flip)
      );
      expect(failure.code).toBe("RevisionUnavailable");
      expect(failure.message).toContain("delivery state");
      expect(
        db.query("SELECT delivered FROM host_outbox WHERE id=450").get()
      ).toEqual({ delivered: flag });
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  }
);

test.each([-1, 0])(
  "upgrade does not skip an invalid first pending intent %s",
  async (id) => {
    const db = fixture();
    try {
      db.query("UPDATE host_outbox SET id=? WHERE id=1").run(id);
      const failure = await Effect.runPromise(
        inspectUpgradeOutbox(db).pipe(Effect.flip)
      );
      expect(failure.code).toBe("RevisionUnavailable");
      expect(failure.message).toContain(`intent ${id}`);
      expect(
        db.query("SELECT count(*) n FROM host_outbox WHERE delivered=0").get()
      ).toEqual({ n: 450 });
    } finally {
      db.close();
    }
  }
);

test("outbox inspection skips delivered history but refuses an index that can hide invalid flags", async () => {
  const db = fixture();
  try {
    db.exec("UPDATE host_outbox SET delivered=1");
    const inspection = await Effect.runPromise(inspectUpgradeOutbox(db));
    expect(inspection.rows).toBe(0);
    db.exec(
      "DROP INDEX host_outbox_pending; CREATE INDEX host_outbox_pending ON host_outbox(delivered,id) WHERE delivered=0"
    );
    const failure = await Effect.runPromise(
      inspectUpgradeOutbox(db).pipe(Effect.flip)
    );
    expect(failure.code).toBe("RevisionUnavailable");
    expect(failure.message).toContain("pending index");
  } finally {
    db.close();
  }
});
