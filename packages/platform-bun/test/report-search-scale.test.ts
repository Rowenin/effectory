/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Pagination and restart proofs are sequential. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Fiber, Schema } from "effect";

import { createStore } from "../src/host-store.ts";
import { createPagination } from "../src/pagination.ts";
import { reportSearch } from "../src/report-search.ts";
import { storageError } from "../src/storage-error.ts";

const lease = { assertActive() {}, token: "search-test" };
const entry = {
  attachmentId: "summary",
  execution: { attemptTimeout: "30 seconds", timeout: "5 minutes" },
  on: ["Succeeded" as const],
  reporterId: "reporter",
  reporterProviderId: null,
  reporterVersion: 1,
  scope: "run" as const,
  targetId: "source",
  targetKind: "task" as const,
  targetVersion: 1,
};
const Count = Schema.Struct({ count: Schema.Int });
const perform = <A>(body: () => A) =>
  Effect.try({
    catch: (cause) => storageError(cause, "Search failed"),
    try: body,
  });

test("250k generations: bounded seeks, old watermarks, sparse conjunctions, migration catch-up and cancellation release", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "effectory-search-scale-"));
  const db = new Database(path.join(dir, "state.sqlite"));
  const observer = new Database(path.join(dir, "state.sqlite"));
  try {
    let store = createStore(db, lease);
    const rare = Effect.runSync(
      store.submit(
        {
          input: null,
          kind: "task",
          reportPlan: [{ ...entry, reporterId: "needle" }],
          requestKey: "rare",
          tags: { "dot./key": "yes", team: "rare" },
          targetId: "source",
        },
        "pinned",
        "owner"
      )
    );
    const dense = Effect.runSync(
      store.submit(
        {
          input: null,
          kind: "task",
          reportPlan: [entry],
          requestKey: "dense",
          tags: { "dot./key": "yes", team: "common" },
          targetId: "source",
        },
        "pinned",
        "owner"
      )
    );
    const group = Effect.runSync(
      store.reportList({ runId: dense.runId }, "owner")
    ).items[0]?.groupId;
    if (!group) {
      throw new Error("Missing group");
    }
    // Model an older writer: generation records are inserted without the new indexes.
    db.query(`WITH RECURSIVE n(v) AS (SELECT 2 UNION ALL SELECT v+1 FROM n WHERE v<250000)
      INSERT INTO host_reports(reportId,groupId,generation,status,createdAt)
      SELECT 'large-'||v,?,v,'Failed','2026-11-06T00:00:00.000Z' FROM n`).run(
      group
    );
    db.query(
      "UPDATE host_report_groups SET latestGeneration=250000 WHERE groupId=?"
    ).run(group);
    const migrationStart = performance.now();
    store = createStore(db, lease);
    const migrationMs = performance.now() - migrationStart;
    const count = (table: string) =>
      Schema.decodeUnknownSync(Count)(
        db.query(`SELECT count(*) count FROM ${table}`).get()
      ).count;
    expect(count("host_report_search")).toBe(250_001);
    expect(count("host_report_search_tags")).toBe(500_002);
    createStore(db, lease);
    expect(count("host_report_search_tags")).toBe(500_002);
    const { secret } = Schema.decodeUnknownSync(
      Schema.Struct({ secret: Schema.String })
    )(db.query("SELECT secret FROM host_page_secret").get());
    const pages = createPagination(secret);
    let maxBatch = 0;
    let maxBatchMillis = 0;
    let total = 0;
    const inspect = (query: Parameters<typeof reportSearch>[2]) =>
      reportSearch(db, pages, query, "owner", perform, (metrics) => {
        expect(metrics.units).toBeLessThanOrEqual(500);
        expect(metrics.totalUnits).toBeLessThanOrEqual(10_000);
        maxBatch = Math.max(maxBatch, metrics.units);
        maxBatchMillis = Math.max(maxBatchMillis, metrics.elapsedMillis);
        total = metrics.totalUnits;
      });
    const rareStart = performance.now();
    const found = await Effect.runPromise(
      inspect({
        reporterId: "needle",
        tags: { "dot./key": "yes", team: "rare" },
      })
    );
    const rareMs = performance.now() - rareStart;
    expect(found.items[0]?.source.runId).toBe(rare.runId);
    expect(found.items).toHaveLength(1);
    expect(found.scanLimited).toBe(false);
    expect(total).toBeLessThan(20);
    expect(
      (
        await Effect.runPromise(
          inspect({ reporterId: "needle", tags: { team: "common" } })
        )
      ).items
    ).toHaveLength(0);
    const densePage = await Effect.runPromise(
      inspect({
        history: true,
        limit: 200,
        reporterId: "reporter",
        tags: { team: "common" },
      })
    );
    expect(densePage.items).toHaveLength(200);
    expect(densePage.scanLimited).toBe(false);
    const limited = await Effect.runPromise(
      inspect({ history: true, query: "no match" })
    );
    expect(limited.items).toHaveLength(0);
    expect(limited.scanLimited).toBe(true);
    expect(limited.cursor).not.toBeNull();
    expect(total).toBe(10_000);
    const next = await Effect.runPromise(
      inspect({
        cursor: limited.cursor ?? "",
        history: true,
        query: "no match",
      })
    );
    expect(next.cursor).not.toBe(limited.cursor);
    // Same indexes at a very old watermark must not walk 249,999 later retries.
    const oldScope = {
      kind: "report-search",
      principal: "owner",
      query: {
        attachmentId: null,
        createdAfter: null,
        createdBefore: null,
        history: false,
        limit: 50,
        query: "",
        reporterId: null,
        runId: null,
        scope: null,
        statuses: [
          "Cancelled",
          "Failed",
          "NeedsAttention",
          "Queued",
          "Running",
          "Succeeded",
          "WaitingSource",
        ],
        tags: {},
        taskId: null,
        workflowId: null,
      },
    };
    const old = pages.write(oldScope, 2, 3, Date.now() + 3_600_000);
    const oldPage = await Effect.runPromise(inspect({ cursor: old }));
    expect(oldPage.items).toHaveLength(2);
    expect(total).toBeLessThan(10);
    // A real Effect interruption lands between batches; the WAL snapshot is released.
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          inspect({ history: true, query: "no match" })
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
      })
    );
    db.query("UPDATE host_runs SET status=status WHERE runId=?").run(
      dense.runId
    );
    const checkpoint = Schema.decodeUnknownSync(
      Schema.Struct({ busy: Schema.Int })
    )(observer.query("PRAGMA wal_checkpoint(TRUNCATE)").get());
    expect(checkpoint.busy).toBe(0);
    const plans = [
      "SELECT MAX(sequence) FROM host_report_search INDEXED BY host_report_search_reporter WHERE principal='owner' AND reporterId='needle' AND sequence<=250001",
      "SELECT MAX(sequence) FROM host_report_search_tags WHERE principal='owner' AND key='team' AND value='rare' AND sequence<=250001",
      "SELECT 1 FROM host_reports INDEXED BY host_reports_group_sequence WHERE groupId='x' AND sequence>1 AND sequence<=2 LIMIT 1",
    ].map((sql) => JSON.stringify(db.query(`EXPLAIN QUERY PLAN ${sql}`).all()));
    for (const plan of plans) {
      expect(plan).not.toContain("TEMP B-TREE");
      expect(plan).toContain("SEARCH");
    }
    console.log(
      JSON.stringify({
        generations: 250_001,
        maxBatch,
        maxBatchMillis,
        migrationMs,
        plans,
        proof: "report-search-scale",
        rareMs,
      })
    );
  } finally {
    observer.close();
    db.close();
    rmSync(dir, { force: true, recursive: true });
  }
}, 120_000);
