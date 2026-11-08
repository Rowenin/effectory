import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";

import { createStore } from "../src/host-store.ts";

const setup = () => {
  const db = new Database(":memory:");
  const store = createStore(db, { assertActive() {}, token: "history-test" });
  const run = Effect.runSync(
    store.submit(
      {
        input: null,
        kind: "workflow",
        requestKey: "history",
        targetId: "parent",
      },
      "pinned",
      "owner"
    )
  );
  const insert = db.query("INSERT INTO host_events VALUES (?,?,?,?,?,?)");

  const event = (tag: string, payload: Schema.Json) => {
    const sequence = Schema.decodeUnknownSync(Schema.Struct({ n: Schema.Int }))(
      db
        .query(
          "SELECT COALESCE(MAX(sequence),0)+1 n FROM host_events WHERE runId=?"
        )
        .get(run.runId)
    ).n;
    insert.run(
      run.runId,
      sequence,
      `test/${sequence}`,
      "2026-11-06T00:00:00.000Z",
      tag,
      JSON.stringify(payload)
    );
    db.query("UPDATE host_runs SET lastSequence=? WHERE runId=?").run(
      sequence,
      run.runId
    );
    return sequence;
  };
  return { db, event, run, store };
};

test("subtree history budgets siblings without loading their bodies, resumes empty pages and binds cursors", async () => {
  const { db, store, run, event } = setup();
  try {
    const path = JSON.stringify(['child🌿%_"/é']);
    db.transaction(() => {
      const { first } = Schema.decodeUnknownSync(
        Schema.Struct({ first: Schema.Int })
      )(
        db
          .query(
            "SELECT COALESCE(MAX(sequence),0)+1 first FROM host_events WHERE runId=?"
          )
          .get(run.runId)
      );
      // Seed the same history in one statement: per-row JS decoding and counter
      // queries are fixture overhead, not the bounded history read under test.
      db.query(`WITH RECURSIVE siblings(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM siblings WHERE n<249999)
        INSERT INTO host_events SELECT ?,?+n,'test/'||(?+n),'2026-11-06T00:00:00.000Z','Log',? FROM siblings`).run(
        run.runId,
        first,
        first,
        JSON.stringify({ message: "sibling", nodeId: '["sibling"]' })
      );
      db.query("UPDATE host_runs SET lastSequence=? WHERE runId=?").run(
        first + 249_999,
        run.runId
      );
    })();
    event("Log", { message: "x".repeat(2_097_152), nodeId: '["sibling"]' });
    const own = event("Log", {
      message: "own",
      nodeId: JSON.stringify(['child🌿%_"/é', "leaf"]),
    });
    event("Log", {
      message: "not mine",
      nodeId: JSON.stringify(['child🌿%_"/é-extra', "leaf"]),
    });
    const diagnostic = event("TelemetryTruncated", {
      message: "Telemetry limit",
    });
    const first = await Effect.runPromise(
      store.reportSubtreeEvents(run.runId, "owner", "child-id", path, {})
    );
    expect(first.items).toEqual([]);
    expect(first.cursor).not.toBeNull();
    if (first.cursor === null) {
      throw new Error("Missing continuation");
    }
    event("Log", { message: "outside snapshot", nodeId: path });
    let page = first;
    let pages = 1;
    while (page.cursor !== null) {
      // oxlint-disable-next-line no-await-in-loop -- Each page consumes the previous cursor.
      page = await Effect.runPromise(
        store.reportSubtreeEvents(run.runId, "owner", "child-id", path, {
          cursor: page.cursor,
          limit: 50,
        })
      );
      pages += 1;
      if (pages > 100) {
        throw new Error("History did not advance");
      }
    }
    expect(pages).toBeGreaterThanOrEqual(26);
    expect(page.items.map((row) => row.sequence)).toEqual([own, diagnostic]);
    expect(page.cursor).toBeNull();
    const wrong = await Effect.runPromiseExit(
      store.reportSubtreeEvents(run.runId, "owner", "another-child", path, {
        cursor: first.cursor,
      })
    );
    expect(Exit.isFailure(wrong)).toBe(true);
    if (Exit.isFailure(wrong)) {
      expect(Option.getOrNull(Cause.findErrorOption(wrong.cause))?.code).toBe(
        "Conflict"
      );
    }
    const other = await Effect.runPromiseExit(
      store.reportSubtreeEvents(run.runId, "other", "child-id", path, {})
    );
    expect(Exit.isFailure(other)).toBe(true);
    const interrupted = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* store
          .reportSubtreeEvents(run.runId, "owner", "child-id", path, {})
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      })
    );
    expect(Exit.isFailure(interrupted)).toBe(true);
    expect(db.inTransaction).toBe(false);
  } finally {
    db.close();
  }
}, 30_000);

test("subtree event byte boundaries preserve the next event and a matching oversized event fails", async () => {
  const { db, store, run, event } = setup();
  try {
    const path = '["child"]';
    const first = event("Log", { message: "a".repeat(600_000), nodeId: path });
    const second = event("Log", { message: "b".repeat(600_000), nodeId: path });
    const page = await Effect.runPromise(
      store.reportSubtreeEvents(run.runId, "owner", "child", path, {})
    );
    expect(page.items.map((row) => row.sequence)).toEqual([first]);
    if (page.cursor === null) {
      throw new Error("Missing continuation");
    }
    const next = await Effect.runPromise(
      store.reportSubtreeEvents(run.runId, "owner", "child", path, {
        cursor: page.cursor,
      })
    );
    expect(next.items.map((row) => row.sequence)).toEqual([second]);
    expect(next.cursor).toBeNull();
    event("Log", { message: "c".repeat(1_048_576), nodeId: path });
    const tooBig = await Effect.runPromiseExit(
      store.reportSubtreeEvents(run.runId, "owner", "child", path, {
        afterSequence: second,
      })
    );
    expect(Exit.isFailure(tooBig)).toBe(true);
    if (Exit.isFailure(tooBig)) {
      expect(Option.getOrNull(Cause.findErrorOption(tooBig.cause))?.code).toBe(
        "LimitExceeded"
      );
    }
  } finally {
    db.close();
  }
});

test("attribution commits atomically and settled waits retain their child path", () => {
  const { db, store, run, event } = setup();
  try {
    const wait = Effect.runSync(
      store.openWait({
        context: null,
        deadline: Date.now() + 60_000,
        kind: "approval",
        nodeId: '["child","gate"]',
        prompt: "Review",
        runId: run.runId,
        schema: null,
      })
    );
    expect(wait).toBeDefined();
    const count = () =>
      Schema.decodeUnknownSync(Schema.Struct({ n: Schema.Int }))(
        db.query("SELECT COUNT(*) n FROM host_report_paths").get()
      ).n;
    const before = count();
    expect(() =>
      db.transaction(() => {
        event("Log", { message: "rolled back", nodeId: '["child"]' });
        throw new Error("abort");
      })()
    ).toThrow("abort");
    expect(count()).toBe(before);
    Effect.runSync(store.cancel(run.runId));
    const settled = Schema.decodeUnknownSync(
      Schema.Struct({ path: Schema.String })
    )(
      db
        .query(
          "SELECT p.path FROM host_report_paths p JOIN host_events e ON e.runId=p.runId AND e.sequence=p.position WHERE p.kind='events' AND e.tag='WaitSettled'"
        )
        .get()
    );
    expect(settled.path).toBe('["child","gate"]');
  } finally {
    db.close();
  }
});
