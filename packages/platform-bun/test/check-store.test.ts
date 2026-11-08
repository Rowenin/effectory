import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import type { CheckPage } from "@effectory/runtime/check-protocol";
import {
  CheckRecord,
  checkReservation,
} from "@offtree/effectory-sdk/internal/check-schema";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { createStore } from "../src/host-store.ts";

function required<A>(value: A | null | undefined): A {
  if (value === null || value === undefined) {
    throw new Error("Missing fixture value");
  }
  return value;
}
function fixture() {
  const database = new Database(":memory:");
  const lease = { assertActive: () => {}, token: "lease" };
  const store = createStore(database, lease);
  const run = Effect.runSync(
    store.submit(
      { input: null, kind: "task", requestKey: "start", targetId: "verify" },
      "revision",
      "owner"
    )
  );
  const register = (nodeId: string) =>
    Effect.runSync(
      store.registerInvocation(run.runId, nodeId, `engine-${nodeId}`, {
        attemptTimeout: null,
        deadline: null,
        input: null,
        nodeId,
        permits: [],
        retry: null,
        runId: run.runId,
        taskId: "verify",
      })
    );
  const reserve = (nodeId: string, attempt = 1) => {
    const admission = Effect.runSync(
      store.reserveAttempt(run.runId, nodeId, attempt, "idempotent")
    );
    if (admission.status !== "Admitted") {
      throw new Error("Not admitted");
    }
    return {
      admission,
      identity: {
        attempt,
        entry: admission.entry,
        nodeId,
        runId: run.runId,
        taskId: "verify",
      },
    };
  };
  const list = (attempts: "latest" | "all" = "latest", cursor?: string) =>
    Effect.runSync(
      store.checkList(
        {
          attempts,
          runId: run.runId,
          ...(cursor === undefined ? {} : { cursor }),
        },
        "owner"
      )
    );
  return { database, lease, list, register, reserve, run, store };
}
function code<A, E>(effect: Effect.Effect<A, E>) {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) {
    return;
  }
  const value = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return typeof value === "object" && value !== null
    ? Reflect.get(value, "code")
    : undefined;
}
const input = (id: string) => ({
  id,
  message: "Check",
  severity: "high" as const,
});
const success = {
  durationMillis: 1,
  message: "Check",
  status: "Passed" as const,
};

test("writes require the exact live entry, preserve live records and reconcile closed entries", () => {
  const f = fixture();
  try {
    f.register("first");
    f.register("second");
    const one = f.reserve("first");
    const two = f.reserve("second");
    const later = Effect.runSync(f.store.checkStart(two.identity, input("b")));
    const earlier = Effect.runSync(
      f.store.checkStart(one.identity, input("a"))
    );
    expect(f.list().items.map((row) => row.status)).toEqual([
      "Running",
      "Running",
    ]);
    Effect.runSync(f.store.checkFinish(one.identity, earlier, success));
    expect(code(f.store.checkStart(one.identity, input("a")))).toBe(
      "InvalidInput"
    );
    f.store.releaseAttempt(f.run.runId, "second", 1, two.admission);
    expect(code(f.store.checkFinish(two.identity, later, success))).toBe(
      "Conflict"
    );
    const rows = f.list().items;
    expect(rows.map((row) => row.status)).toEqual(["Passed", "Incomplete"]);
    expect(rows.map((row) => row.nodeId)).toEqual(["first", "second"]);
    expect(required(rows[0]).sequence).toBeGreaterThan(
      required(rows[1]).sequence
    );
    expect(required(rows[1]).durationMillis).toBeNull();
    expect(rows.every((row) => !("invocationPosition" in row))).toBe(true);
    expect(code(f.store.checkList({ runId: f.run.runId }, "other"))).toBe(
      "NotFound"
    );
  } finally {
    f.database.close();
  }
});

test("latest admission excludes earlier checks even when the new entry has no observations", () => {
  const f = fixture();
  try {
    f.register("node");
    const prior = f.reserve("node");
    const sequence = Effect.runSync(
      f.store.checkStart(prior.identity, input("check"))
    );
    Effect.runSync(f.store.checkFinish(prior.identity, sequence, success));
    f.store.releaseAttempt(f.run.runId, "node", 1, prior.admission);
    const next = f.reserve("node");
    expect(next.identity.entry).toBe(2);
    expect(f.list().items).toEqual([]);
    expect(f.list("all").items).toHaveLength(1);
    expect(code(f.store.checkFinish(prior.identity, sequence, success))).toBe(
      "Conflict"
    );
    Effect.runSync(f.store.project(f.run.runId, "Succeeded", true));
    expect(code(f.store.checkStart(next.identity, input("late")))).toBe(
      "Conflict"
    );
  } finally {
    f.database.close();
  }
});

test("bounded pages advance across excluded entries and bind cursors to their query", () => {
  const f = fixture();
  try {
    f.register("node");
    const one = f.reserve("node");
    for (let index = 0; index < 600; index += 1) {
      const sequence = Effect.runSync(
        f.store.checkStart(one.identity, input(`c${index}`))
      );
      Effect.runSync(f.store.checkFinish(one.identity, sequence, success));
    }
    f.store.releaseAttempt(f.run.runId, "node", 1, one.admission);
    const two = f.reserve("node");
    const sequence = Effect.runSync(
      f.store.checkStart(two.identity, input("current"))
    );
    Effect.runSync(f.store.checkFinish(two.identity, sequence, success));
    const first = f.list();
    expect(first.items).toEqual([]);
    expect(first.cursor).toBeString();
    const second = f.list("latest", required(first.cursor));
    expect(second.items).toEqual([]);
    const third = f.list("latest", required(second.cursor));
    expect(third.items.map((row) => row.id)).toEqual(["current"]);
    expect(third.cursor).toBeNull();
    expect(
      code(
        f.store.checkList(
          {
            attempts: "all",
            cursor: required(first.cursor),
            runId: f.run.runId,
          },
          "owner"
        )
      )
    ).toBe("Conflict");
  } finally {
    f.database.close();
  }
});

test("entry limits, run budgets and oversized paths reject before any record is inserted", () => {
  const f = fixture();
  try {
    f.register("node");
    const entry = f.reserve("node");
    for (let index = 0; index < 1000; index += 1) {
      Effect.runSync(f.store.checkStart(entry.identity, input(`c${index}`)));
    }
    expect(code(f.store.checkStart(entry.identity, input("overflow")))).toBe(
      "LimitExceeded"
    );
    const budget = f.database.query("SELECT * FROM host_check_budget").get();
    expect(code(f.store.checkStart(entry.identity, input("c0")))).toBe(
      "InvalidInput"
    );
    expect(f.database.query("SELECT * FROM host_check_budget").get()).toEqual(
      budget
    );
    f.register("other");
    const other = f.reserve("other");
    f.database.query("UPDATE host_check_budget SET bytes=16777216").run();
    expect(code(f.store.checkStart(other.identity, input("bytes")))).toBe(
      "LimitExceeded"
    );
    f.database.query("UPDATE host_check_budget SET bytes=0,rows=10000").run();
    expect(code(f.store.checkStart(other.identity, input("rows")))).toBe(
      "LimitExceeded"
    );
  } finally {
    f.database.close();
  }
});

test("new owner reconciles lost observations and default thresholds preserve submission identity", () => {
  const f = fixture();
  try {
    f.register("node");
    const one = f.reserve("node");
    Effect.runSync(f.store.checkStart(one.identity, input("lost")));
    const restarted = createStore(f.database, {
      assertActive: () => {},
      token: "new-lease",
    });
    const page = Effect.runSync(
      restarted.checkList({ runId: f.run.runId }, "owner")
    );
    expect(page.items[0]?.status).toBe("Incomplete");
    const request = {
      input: null,
      kind: "task" as const,
      requestKey: "start",
      targetId: "verify",
    };
    expect(
      Effect.runSync(
        restarted.submit(
          { ...request, checks: { failOn: "low" } },
          "other-revision",
          "owner"
        )
      ).runId
    ).toBe(f.run.runId);
    expect(
      code(
        restarted.submit(
          { ...request, checks: { failOn: "high" } },
          "revision",
          "owner"
        )
      )
    ).toBe("Conflict");
    const high = Effect.runSync(
      restarted.submit(
        { ...request, checks: { failOn: "high" }, requestKey: "high" },
        "revision",
        "owner"
      )
    );
    expect(high.checks).toEqual({ failOn: "high" });
    f.database
      .query("UPDATE host_runs SET checksJson='{}' WHERE runId=?")
      .run(high.runId);
    expect(code(restarted.getRun(high.runId))).toBe("Unavailable");
  } finally {
    f.database.close();
  }
});

test("a failed completion transaction retains Running for reconciliation and emits no false success event", () => {
  const f = fixture();
  try {
    f.register("node");
    const entry = f.reserve("node");
    const sequence = Effect.runSync(
      f.store.checkStart(entry.identity, input("transaction"))
    );
    f.database.run(
      "CREATE TRIGGER fail_check_finish BEFORE UPDATE ON host_checks WHEN NEW.status='Passed' BEGIN SELECT RAISE(ABORT,'injected completion fault'); END"
    );
    expect(code(f.store.checkFinish(entry.identity, sequence, success))).toBe(
      "Unavailable"
    );
    expect(f.list().items[0]?.status).toBe("Running");
    expect(
      f.database
        .query(
          "SELECT COUNT(*) count FROM host_events WHERE tag='AssertionFinished'"
        )
        .get()
    ).toEqual({ count: 0 });
    f.store.releaseAttempt(f.run.runId, "node", 1, entry.admission);
    expect(f.list().items[0]?.status).toBe("Incomplete");
    expect(
      f.database
        .query(
          "SELECT COUNT(*) count FROM host_events WHERE tag='AssertionFinished'"
        )
        .get()
    ).toEqual({ count: 1 });
  } finally {
    f.database.close();
  }
});

test("10,000 observations remain pageable without loading native task outputs", () => {
  const f = fixture();
  try {
    const insert = f.database.query(`
      INSERT INTO host_checks(invocationPosition,runId,nodeId,taskId,attempt,entry,id,severity,message,status,startedAt,finishedAt,durationMillis,owner)
      SELECT invocationPosition,runId,nodeId,taskId,attempt,entry,?,severity,message,status,startedAt,finishedAt,durationMillis,owner
      FROM host_checks WHERE sequence=?`);
    for (let node = 0; node < 10; node += 1) {
      const nodeId = `node-${node}`;
      f.register(nodeId);
      const entry = f.reserve(nodeId);
      const first = Effect.runSync(
        f.store.checkStart(entry.identity, input("c0"))
      );
      Effect.runSync(f.store.checkFinish(entry.identity, first, success));
      const template = Schema.decodeUnknownSync(CheckRecord)(
        f.database
          .query("SELECT * FROM host_checks WHERE sequence=?")
          .get(first)
      );
      // This is a paging fixture. Seed the middle rows from a real completed
      // record; keep real start/finish calls at both ends of every entry.
      f.database.transaction(() => {
        let bytes = 0;
        for (let index = 1; index < 999; index += 1) {
          const id = `c${index}`;
          insert.run(id, first);
          bytes += checkReservation({ ...template, id });
        }
        f.database
          .query(
            "UPDATE host_check_budget SET rows=rows+998,bytes=bytes+? WHERE runId=?"
          )
          .run(bytes, f.run.runId);
      })();
      const last = Effect.runSync(
        f.store.checkStart(entry.identity, input("c999"))
      );
      Effect.runSync(f.store.checkFinish(entry.identity, last, success));
      f.store.releaseAttempt(f.run.runId, nodeId, 1, entry.admission);
    }
    let cursor: string | null = null;
    let count = 0;
    const sequences = new Set<number>();
    do {
      const page: typeof CheckPage.Type = Effect.runSync(
        f.store.checkList(
          {
            limit: 200,
            runId: f.run.runId,
            ...(cursor === null ? {} : { cursor }),
          },
          "owner"
        )
      );
      count += page.items.length;
      for (const item of page.items) {
        sequences.add(item.sequence);
      }
      expect(page.items.length).toBeLessThanOrEqual(200);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2_097_152);
      ({ cursor } = page);
    } while (cursor !== null);
    expect(count).toBe(10_000);
    expect(sequences.size).toBe(10_000);
    expect(
      f.database.query("SELECT rows FROM host_check_budget").get()
    ).toEqual({ rows: 10_000 });
    f.register("extra");
    const extra = f.reserve("extra");
    expect(code(f.store.checkStart(extra.identity, input("extra")))).toBe(
      "LimitExceeded"
    );
  } finally {
    f.database.close();
  }
});

test("private invocation ordering keeps its first-page watermark when new rows precede the next old group", () => {
  const f = fixture();
  try {
    f.register("first");
    f.register("second");
    const first = f.reserve("first");
    const second = f.reserve("second");
    const b = Effect.runSync(f.store.checkStart(second.identity, input("b")));
    Effect.runSync(f.store.checkFinish(second.identity, b, success));
    const a = Effect.runSync(f.store.checkStart(first.identity, input("a")));
    Effect.runSync(f.store.checkFinish(first.identity, a, success));
    const page = Effect.runSync(
      f.store.checkList({ limit: 1, runId: f.run.runId }, "owner")
    );
    expect(page.items.map((row) => row.id)).toEqual(["a"]);
    for (let index = 0; index < 300; index += 1) {
      const sequence = Effect.runSync(
        f.store.checkStart(first.identity, input(`new-${index}`))
      );
      Effect.runSync(f.store.checkFinish(first.identity, sequence, success));
    }
    const empty = f.list("latest", required(page.cursor));
    expect(empty.items).toEqual([]);
    expect(empty.snapshot).toBe(page.snapshot);
    const final = f.list("latest", required(empty.cursor));
    expect(final.items.map((row) => row.id)).toEqual(["b"]);
    expect(final.cursor).toBeNull();
    const query = f.database
      .query<{ detail: string }, [string, number, number]>(
        "EXPLAIN QUERY PLAN SELECT * FROM host_checks WHERE runId=? AND (invocationPosition,sequence)>(?,?) ORDER BY invocationPosition,sequence LIMIT 256"
      )
      .all(f.run.runId, 0, 0);
    expect(
      query.some((row) => row.detail.includes("host_checks_invocation_order"))
    ).toBe(true);
    expect(query.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
  } finally {
    f.database.close();
  }
});
