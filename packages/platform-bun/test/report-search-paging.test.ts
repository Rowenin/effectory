/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Compare ordered cursor traversals against an independent reference. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import type {
  ReportSearchRequest,
  ReportSearchPage,
} from "@effectory/runtime/report-protocol";
import { Effect, Schema } from "effect";

import { createStore } from "../src/host-store.ts";
import { createPagination } from "../src/pagination.ts";
import { reportSearch } from "../src/report-search.ts";
import { storageError } from "../src/storage-error.ts";

const Ref = Schema.Struct({
  attachmentId: Schema.String,
  createdAt: Schema.String,
  groupId: Schema.String,
  reportId: Schema.String,
  reporterId: Schema.String,
  sequence: Schema.Int,
  status: Schema.String,
});
test("ordered index intersection traverses disjoint and residual-heavy histories without losing boundary candidates", async () => {
  const db = new Database(":memory:");
  const lease = { assertActive() {}, token: "paging" };
  try {
    let store = createStore(db, lease);
    const plan = Array.from({ length: 4 }, (_, i) => ({
      attachmentId: `a${i}`,
      execution: { attemptTimeout: "30 seconds", timeout: "5 minutes" },
      on: ["Succeeded" as const],
      reporterId: `r${i % 2}`,
      reporterProviderId: null,
      reporterVersion: 1,
      scope: "run" as const,
      targetId: "source",
      targetKind: "task" as const,
      targetVersion: 1,
    }));
    const run = Effect.runSync(
      store.submit(
        {
          input: null,
          kind: "task",
          reportPlan: plan,
          requestKey: "root",
          tags: { team: "common" },
          targetId: "source",
        },
        "revision",
        "owner"
      )
    );
    const original = Effect.runSync(
      store.reportList({ runId: run.runId }, "owner")
    ).items;
    db.transaction(() => {
      const insert = db.query(
        "INSERT INTO host_reports(reportId,groupId,generation,status,createdAt) VALUES (?,?,?,?,?)"
      );
      for (let gen = 2; gen <= 3501; gen += 1) {
        for (const item of original) {
          insert.run(
            `${item.attachmentId}-${gen}`,
            item.groupId,
            gen,
            gen % 2 === 0 ? "Failed" : "Succeeded",
            gen % 3 === 0
              ? "2026-11-02T00:00:00.000Z"
              : "2026-11-06T00:00:00.000Z"
          );
        }
      }
      db.run("UPDATE host_report_groups SET latestGeneration=3501");
    })();
    store = createStore(db, lease);
    const reference = Schema.decodeUnknownSync(Schema.Array(Ref))(
      db
        .query(`SELECT r.sequence,r.reportId,r.groupId,r.status,r.createdAt,q.reporterId,q.attachmentId
      FROM host_reports r JOIN host_report_search q ON q.sequence=r.sequence ORDER BY r.sequence DESC`)
        .all()
    );
    const latest = new Map<string, number>();
    for (const row of reference) {
      if (!latest.has(row.groupId)) {
        latest.set(row.groupId, row.sequence);
      }
    }
    const queries: (typeof ReportSearchRequest.Type)[] = [
      { attachmentId: "a1", history: true, reporterId: "r0" },
      { history: true, limit: 200, reporterId: "r0", tags: { team: "common" } },
      { statuses: ["Failed"] },
      { attachmentId: "a2", createdBefore: "2026-11-04", history: true },
      { history: true, query: "not present" },
      { limit: 1, query: "A" },
      { attachmentId: "a3", history: true, limit: 50, statuses: ["Failed"] },
    ];
    let emptyPages = 0;
    for (const query of queries) {
      const expected = reference
        .filter(
          (row) =>
            (query.history === true ||
              latest.get(row.groupId) === row.sequence) &&
            (!query.statuses ||
              query.statuses.some((status) => status === row.status)) &&
            (query.reporterId === undefined ||
              query.reporterId === row.reporterId) &&
            (query.attachmentId === undefined ||
              query.attachmentId === row.attachmentId) &&
            (query.createdBefore === undefined ||
              Date.parse(row.createdAt) <= Date.parse(query.createdBefore)) &&
            (query.query === undefined ||
              [row.attachmentId, row.reporterId, "source"].some((id) =>
                id.toLowerCase().includes(query.query?.toLowerCase() ?? "")
              ))
        )
        .map((row) => row.reportId);
      let cursor: string | null = null;
      const ids: string[] = [];
      let pageCount = 0;
      do {
        const page: typeof ReportSearchPage.Type = await Effect.runPromise(
          store.reportSearch(
            { ...query, ...(cursor === null ? {} : { cursor }) },
            "owner"
          )
        );
        ids.push(...page.items.map((item) => item.reportId));
        if (page.items.length === 0 && page.cursor !== null) {
          emptyPages += 1;
        }
        if (page.cursor !== null) {
          expect(page.cursor).not.toBe(cursor);
        }
        ({ cursor } = page);
        pageCount += 1;
        expect(pageCount).toBeLessThan(500);
      } while (cursor !== null);
      expect(ids).toEqual(expected);
    }
    expect(emptyPages).toBeGreaterThan(0);
    const { secret } = Schema.decodeUnknownSync(
      Schema.Struct({ secret: Schema.String })
    )(db.query("SELECT secret FROM host_page_secret").get());
    const pages = createPagination(secret);
    let metadata = 0;
    const sample = await Effect.runPromise(
      reportSearch(
        db,
        pages,
        { history: true, query: "not present" },
        "owner",
        (body) =>
          Effect.try({
            catch: (cause) => storageError(cause, "Search failed"),
            try: body,
          }),
        (m) => {
          metadata = m.metadataBytes;
        }
      )
    );
    expect(sample.scanLimited).toBe(true);
    expect(metadata).toBeLessThanOrEqual(16_777_216);
    const first = await Effect.runPromise(
      store.reportSearch({ limit: 1 }, "owner")
    );
    if (first.cursor === null) {
      throw new Error("Missing cursor");
    }
    const [encoded] = first.cursor.split(".");
    const raw = Schema.decodeUnknownSync(
      Schema.Struct({ position: Schema.Json, snapshot: Schema.Json })
    )(JSON.parse(Buffer.from(encoded ?? "", "base64url").toString()));
    const scope = {
      kind: "report-search",
      principal: "owner",
      query: {
        attachmentId: null,
        createdAfter: null,
        createdBefore: null,
        history: false,
        limit: 1,
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
    const expired = pages.write(
      scope,
      raw.snapshot,
      raw.position,
      Date.now() - 1
    );
    await expect(
      Effect.runPromise(
        store.reportSearch({ cursor: expired, limit: 1 }, "owner")
      )
    ).rejects.toMatchObject({ code: "CursorExpired" });
  } finally {
    db.close();
  }
}, 60_000);
