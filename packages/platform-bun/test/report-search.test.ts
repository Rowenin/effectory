/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Sequential cursor and state-transition assertions. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import type { ReportSearchRequest } from "@effectory/runtime/report-protocol";
import { Effect, Exit, Cause, Option, Schema } from "effect";

import { createStore } from "../src/host-store.ts";
import { initializeReadProtection } from "../src/lake-protection.ts";
import { createPagination } from "../src/pagination.ts";
import type { EncodedReportPlan } from "../src/report-plan.ts";
import { reportSearch } from "../src/report-search.ts";
import { storageError } from "../src/storage-error.ts";

const entry: EncodedReportPlan[number] = {
  attachmentId: "summary",
  execution: { attemptTimeout: "30 seconds", timeout: "5 minutes" },
  on: ["Succeeded", "Failed", "Cancelled", "TimedOut", "Rejected"],
  reporterId: "reporter",
  reporterProviderId: null,
  reporterVersion: 1,
  scope: "run",
  targetId: "source",
  targetKind: "task",
  targetVersion: 1,
};
function fixture() {
  const database = new Database(":memory:");
  const store = createStore(database, { assertActive() {}, token: "test" });
  initializeReadProtection(database);
  const submit = (
    key: string,
    entries: EncodedReportPlan = [entry],
    principal = "owner"
  ) =>
    Effect.runSync(
      store.submit(
        {
          input: null,
          kind: "task",
          reportPlan: entries,
          requestKey: key,
          tags: { env: "prod", "team.name/role": "platform" },
          targetId: "source",
        },
        "pinned",
        principal
      )
    );
  const search = (
    request: typeof ReportSearchRequest.Type = {},
    principal = "owner"
  ) => Effect.runPromise(store.reportSearch(request, principal));
  const materialize = (id: string) => {
    Effect.runSync(store.project(id, "Succeeded", null));
    for (const source of Effect.runSync(store.reportPendingSources("Ready"))) {
      Effect.runSync(store.reportMaterialize(source.sourceId));
    }
  };
  return { database, materialize, search, store, submit };
}

test("search finds unadmitted records, exact conjunctive tags, Unicode text and only owned sources", async () => {
  const f = fixture();
  try {
    const root = f.submit("one", [
      { ...entry, attachmentId: "ÄBÇ_İ%\\'summary" },
    ]);
    f.submit("another-owner", [entry], "other");
    const page = await f.search({
      query: "äbç_i\u0307%\\'",
      reporterId: "reporter",
      scope: "run",
      tags: { env: "prod", "team.name/role": "platform" },
      taskId: "source",
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      reportRunId: null,
      root: { acceptedAt: root.acceptedAt, kind: "task", tags: root.tags },
      source: { revision: "pinned", runId: root.runId },
      status: "WaitingSource",
    });
    expect(page.items[0]).not.toHaveProperty("error");
    expect(page.items[0]).not.toHaveProperty("execution");
    expect((await f.search({ tags: { env: "dev" } })).items).toHaveLength(0);
    expect((await f.search({ runId: root.runId }, "other")).items).toHaveLength(
      0
    );
    expect((await f.search({ workflowId: "source" })).items).toHaveLength(0);
    expect((await f.search({ query: "no match" })).cursor).toBeNull();
  } finally {
    f.database.close();
  }
});

test("default excludes NotApplicable; multiple statuses, duplicate normalization and byte-free failures are preserved", async () => {
  const f = fixture();
  try {
    const root = f.submit("one", [
      { ...entry, attachmentId: "kept" },
      { ...entry, attachmentId: "excluded", on: ["Failed"] },
    ]);
    f.materialize(root.runId);
    const run = Effect.runSync(f.store.reportPromote());
    if (!run) {
      throw new Error("Missing reporter");
    }
    Effect.runSync(
      f.store.project(
        run.runId,
        "Failed",
        { message: "private failure" },
        "Domain"
      )
    );
    f.database
      .query("UPDATE host_runs SET errorJson=? WHERE runId=?")
      .run("{broken", run.runId);
    const found = await f.search();
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({
      reportRunStatus: "Failed",
      status: "Failed",
    });
    expect(JSON.stringify(found)).not.toContain("private failure");
    const first = await f.search({
      limit: 1,
      statuses: ["Failed", "NotApplicable"],
    });
    expect(first.cursor).not.toBeNull();
    const second = await f.search({
      cursor: first.cursor ?? "",
      limit: 1,
      statuses: ["NotApplicable", "Failed", "Failed"],
    });
    expect(second.items).toHaveLength(1);
    expect(
      new Set([...first.items, ...second.items].map((item) => item.status))
    ).toEqual(new Set(["Failed", "NotApplicable"]));
  } finally {
    f.database.close();
  }
});

test("latest selection precedes creation/status filters and stays fixed across page retries", async () => {
  const f = fixture();
  try {
    const root = f.submit(
      "one",
      ["a", "b", "c"].map((attachmentId) => ({ ...entry, attachmentId }))
    );
    f.materialize(root.runId);
    for (let i = 0; i < 3; i += 1) {
      const run = Effect.runSync(f.store.reportPromote());
      if (!run) {
        throw new Error("Missing reporter");
      }
      Effect.runSync(
        f.store.project(run.runId, "Succeeded", {
          data: null,
          markdown: "done",
        })
      );
    }
    const first = await f.search({ limit: 1 });
    const oldest = (await f.search()).items.at(-1);
    if (!oldest) {
      throw new Error("Missing report");
    }
    const retried = Effect.runSync(
      f.store.reportRetry(
        { reportId: oldest.reportId, requestKey: "retry" },
        "owner",
        () => {}
      )
    );
    const seen = [...first.items];
    let { cursor } = first;
    while (cursor !== null) {
      const next = await f.search({ cursor, limit: 1 });
      expect(next.snapshot).toBe(first.snapshot);
      seen.push(...next.items);
      ({ cursor } = next);
    }
    expect(seen).toHaveLength(3);
    expect(seen.map((item) => item.reportId)).toContain(oldest.reportId);
    expect(seen.map((item) => item.reportId)).not.toContain(
      retried.record.reportId
    );
    expect((await f.search()).items[0]?.reportId).toBe(retried.record.reportId);
    expect(
      (await f.search({ statuses: ["Succeeded"] })).items.map(
        (item) => item.reportId
      )
    ).not.toContain(oldest.reportId);
    expect((await f.search({ history: true })).items).toHaveLength(4);
    f.database
      .query("UPDATE host_reports SET createdAt=? WHERE reportId=?")
      .run("2026-11-02T00:00:00.000Z", oldest.reportId);
    f.database
      .query("UPDATE host_reports SET createdAt=? WHERE reportId=?")
      .run("2026-11-06T00:00:00.000Z", retried.record.reportId);
    expect(
      (
        await f.search({
          attachmentId: oldest.attachmentId,
          createdBefore: "2026-11-04",
        })
      ).items
    ).toHaveLength(0);
    expect(
      (
        await f.search({
          attachmentId: oldest.attachmentId,
          createdBefore: "2026-11-04",
          history: true,
        })
      ).items[0]?.reportId
    ).toBe(oldest.reportId);
  } finally {
    f.database.close();
  }
});

test("search uses the same current status snapshot as cancellation and rejects invalid cursor scopes", async () => {
  const f = fixture();
  try {
    const root = f.submit("one", [entry, { ...entry, attachmentId: "second" }]);
    f.materialize(root.runId);
    const run = Effect.runSync(f.store.reportPromote());
    if (!run?.report) {
      throw new Error("Missing report run");
    }
    Effect.runSync(
      f.store.reportCancel(
        { reportId: run.report.reportId, requestKey: "cancel" },
        "owner"
      )
    );
    const running = await f.search({ statuses: ["Running"] });
    expect(running.items[0]).toMatchObject({
      reportRunStatus: "Cancelling",
      status: "Running",
    });
    Effect.runSync(f.store.project(run.runId, "Cancelled", null, "Control"));
    expect((await f.search({ statuses: ["Running"] })).items).toHaveLength(0);
    expect((await f.search({ statuses: ["Cancelled"] })).items).toHaveLength(1);
    const first = await f.search({ limit: 1 });
    for (const request of [
      { cursor: first.cursor ?? "", limit: 2 },
      { cursor: first.cursor ?? "", history: true, limit: 1 },
    ]) {
      const exit = await Effect.runPromiseExit(
        f.store.reportSearch(request, "owner")
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(
          Option.getOrNull(Cause.findErrorOption(exit.cause))
        ).toMatchObject({ code: "Conflict" });
      }
    }
    for (const request of [
      { query: "x".repeat(201) },
      { limit: 0 },
      { createdAfter: "bad" },
      { createdAfter: "2027", createdBefore: "2026" },
      { cursor: "tampered" },
    ]) {
      const exit = await Effect.runPromiseExit(
        f.store.reportSearch(request, "owner")
      );
      if (!Exit.isFailure(exit)) {
        throw new Error("Expected validation failure");
      }
      expect(Option.getOrNull(Cause.findErrorOption(exit.cause))).toMatchObject(
        { code: "InvalidInput" }
      );
    }
  } finally {
    f.database.close();
  }
});

test("byte-limited pages preserve the unreturned invocation, with root and source identities distinct", async () => {
  const f = fixture();
  try {
    const tags = Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`label-${i}`, "x".repeat(240)])
    );
    const root = Effect.runSync(
      f.store.submit(
        {
          input: null,
          kind: "workflow",
          reportPlan: [{ ...entry, scope: "invocation" }],
          requestKey: "wide",
          tags,
          targetId: "deploy",
        },
        "pinned",
        "owner"
      )
    );
    for (let i = 0; i < 220; i += 1) {
      Effect.runSync(
        f.store.registerInvocation(
          root.runId,
          "\u0001".repeat(2040) + i,
          `invocation-${i}`,
          { taskId: "source" }
        )
      );
    }
    const query = {
      limit: 200,
      scope: "invocation" as const,
      taskId: "source",
      workflowId: "deploy",
    };
    const first = await f.search(query);
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(200);
    expect(first.scanLimited).toBe(false);
    expect(first.cursor).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
      2_097_152
    );
    expect(first.items[0]).toMatchObject({
      root: { kind: "workflow", tags, targetId: "deploy" },
      source: { targetId: "source", targetKind: "task" },
    });
    const rest = await f.search({ ...query, cursor: first.cursor ?? "" });
    expect(
      new Set([...first.items, ...rest.items].map((item) => item.reportId)).size
    ).toBe(220);
    expect([...first.items, ...rest.items]).toHaveLength(220);
    f.database
      .exec(`WITH RECURSIVE n(v) AS (SELECT 2 UNION ALL SELECT v+1 FROM n WHERE v<12)
      INSERT INTO host_reports(reportId,groupId,generation,status,createdAt)
      SELECT r.reportId||'/'||n.v,r.groupId,n.v,r.status,r.createdAt FROM host_reports r CROSS JOIN n WHERE r.generation=1`);
    createStore(f.database, { assertActive() {}, token: "wide-reopen" });
    const { secret } = Schema.decodeUnknownSync(
      Schema.Struct({ secret: Schema.String })
    )(f.database.query("SELECT secret FROM host_page_secret").get());
    let metadataBytes = 0;
    let units = 0;
    const limited = await Effect.runPromise(
      reportSearch(
        f.database,
        createPagination(secret),
        { history: true, query: "no-match" },
        "owner",
        (body) =>
          Effect.try({
            catch: (cause) => storageError(cause, "Search failed"),
            try: body,
          }),
        (metrics) => {
          ({ metadataBytes } = metrics);
          units = metrics.totalUnits;
        }
      )
    );
    expect(limited.scanLimited).toBe(true);
    expect(limited.items).toHaveLength(0);
    expect(limited.cursor).not.toBeNull();
    expect(metadataBytes).toBeLessThanOrEqual(16_777_216);
    expect(metadataBytes).toBeGreaterThan(16_777_216 - 65_536);
    expect(units).toBeLessThan(10_000);
  } finally {
    f.database.close();
  }
});

test("backfill failure rolls back the entire search migration and retry catches up old writers", async () => {
  const f = fixture();
  try {
    f.submit("one");
    f.database.exec(
      "DROP TABLE host_report_search_tags; DROP TABLE host_report_search;"
    );
    const saved = Schema.decodeUnknownSync(
      Schema.Struct({ planJson: Schema.String })
    )(
      f.database.query("SELECT planJson FROM host_report_plans").get()
    ).planJson;
    f.database
      .query("UPDATE host_report_plans SET planJson=?")
      .run("{malformed");
    expect(() =>
      createStore(f.database, { assertActive() {}, token: "reopen" })
    ).toThrow();
    expect(
      f.database
        .query("SELECT name FROM sqlite_master WHERE name='host_report_search'")
        .get()
    ).toBeNull();
    f.database.query("UPDATE host_report_plans SET planJson=?").run(saved);
    const recovered = createStore(f.database, {
      assertActive() {},
      token: "reopen",
    });
    expect(
      (await Effect.runPromise(recovered.reportSearch({}, "owner"))).items
    ).toHaveLength(1);
    // A pre-search writer appends a generation without indexing it.
    f.database
      .exec(`INSERT INTO host_reports(reportId,groupId,generation,status,createdAt)
      SELECT 'old-writer-retry',groupId,2,'Queued',createdAt FROM host_reports LIMIT 1`);
    const reopened = createStore(f.database, {
      assertActive() {},
      token: "again",
    });
    expect(
      (await Effect.runPromise(reopened.reportSearch({}, "owner"))).items[0]
        ?.reportId
    ).toBe("old-writer-retry");
  } finally {
    f.database.close();
  }
});
