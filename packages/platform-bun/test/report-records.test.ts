import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Exit, Layer } from "effect";

import { HostStore, hostStoreLayer } from "../src/host-store.ts";
import { ownershipLayer } from "../src/ownership.ts";
import type { EncodedReportPlan } from "../src/report-plan.ts";
import { reportGroupId, reportId } from "../src/report-records.ts";

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
const submit = (key: string, entries: EncodedReportPlan = [entry]) => ({
  input: null,
  kind: "task" as const,
  reportPlan: entries,
  requestKey: key,
  targetId: "source",
});
const storeLayer = (filename: string) =>
  hostStoreLayer(filename).pipe(
    Layer.provide(ownershipLayer(`${filename}.owner`))
  );
async function databaseTest(
  body: (
    filename: string,
    layer: ReturnType<typeof storeLayer>
  ) => Promise<void>
) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-report-records-")
  );
  const filename = path.join(directory, "state.sqlite");
  try {
    await body(filename, storeLayer(filename));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
const materialize = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* HostStore;
    yield* store.project(runId, "Succeeded", "done");
    for (const source of yield* store.reportPendingSources("Ready")) {
      yield* store.reportMaterialize(source.sourceId);
    }
  });

test("report retry refuses an unavailable pinned revision before writing and replays accepted receipts before checking code", async () =>
  await databaseTest(async (_filename, layer) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const source = yield* store.submit(submit("source"), "pinned", "owner");
        const [id] = yield* store.reportIds(source.runId);
        if (id === undefined) {
          return yield* Effect.die("Missing report");
        }
        yield* store.reportCancel(
          { reportId: id, requestKey: "cancel" },
          "owner"
        );
        const request = { reportId: id, requestKey: "retry" };
        const unavailable = (revision: string) => {
          expect(revision).toBe(source.revision);
          throw new OperationError({
            code: "RevisionUnavailable",
            message: "Pinned execution contract is unavailable",
          });
        };
        const refused = yield* store
          .reportRetry(request, "owner", unavailable)
          .pipe(Effect.flip);
        expect(refused.code).toBe("RevisionUnavailable");
        expect(yield* store.reportIds(source.runId)).toEqual([id]);
        expect((yield* store.reportGet(id)).generation).toBe(1);
        // Refusal must not reserve the key. A compatible host can accept it later.
        const accepted = yield* store.reportRetry(
          request,
          "owner",
          (revision) => {
            expect(revision).toBe("pinned");
          }
        );
        expect(accepted.replayed).toBe(false);
        expect(accepted.record.generation).toBe(2);
        // Even if the old code has since become unavailable, a retry of the
        // accepted operation returns its receipt and never creates generation 3.
        const replayed = yield* store.reportRetry(
          request,
          "owner",
          unavailable
        );
        expect(replayed).toEqual({ ...accepted, replayed: true });
        expect(yield* store.reportIds(source.runId)).toHaveLength(2);
        const other = yield* store
          .reportRetry(request, "other", () => {
            throw new Error("Authorization must precede metadata access");
          })
          .pipe(Effect.flip);
        expect(other.code).toBe("NotFound");
      }).pipe(Effect.provide(layer))
    );
  }));

test("report generations survive reopening, pin their source plan, and promote once with inherited tags", async () =>
  await databaseTest(async (_filename, layer) => {
    let id = "";
    let sourceId = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const source = yield* store.submit(
          {
            ...submit("first"),
            checks: { failOn: "high" },
            tags: { team: "platform" },
          },
          "pinned",
          "owner"
        );
        sourceId = source.runId;
        id = reportId(reportGroupId(sourceId, null, "summary"), 1);
        const initial = yield* store.reportGet(id, "owner");
        expect(initial.status).toBe("WaitingSource");
        expect(initial.source.status).toBeNull();
        expect(
          Exit.isFailure(yield* Effect.exit(store.reportGet(id, "other")))
        ).toBe(true);
        yield* materialize(sourceId);
        expect((yield* store.reportGet(id)).status).toBe("Queued");
      }).pipe(Effect.provide(layer))
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const run = yield* store.reportPromote();
        if (!run) {
          return yield* Effect.die("Expected report run");
        }
        expect(run.revision).toBe("pinned");
        expect(run.tags).toEqual({ team: "platform" });
        expect(run.checks).toEqual({ failOn: "high" });
        expect(run.report).toMatchObject({
          execution: entry.execution,
          generation: 1,
          reportId: id,
          sourceInvocationId: null,
          sourceRunId: sourceId,
        });
        expect(run.schedule).toBeUndefined();
        expect(run.input).toMatchObject({
          runId: sourceId,
          status: "Succeeded",
        });
        expect(yield* store.reportPlan(run.runId)).toEqual([]);
        expect(yield* store.reportIds(run.runId)).toEqual([]);
        expect(yield* store.reportPromote()).toBeNull();
        expect(
          (yield* store.observation(run.runId, "owner")).run.report
        ).toEqual(run.report);
        expect(
          (yield* store.history({}, "owner")).items.find(
            (item) => item.runId === run.runId
          )?.report
        ).toEqual(run.report);
        yield* store.project(run.runId, "Succeeded", {
          data: null,
          markdown: "done",
        });
        expect(yield* store.reportGet(id)).toMatchObject({
          reportRunId: run.runId,
          reportRunStatus: "Succeeded",
          status: "Succeeded",
        });
      }).pipe(Effect.provide(layer))
    );
  }));

test("ineligible and excluded sources settle without running reporters", async () =>
  await databaseTest(async (_filename, layer) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const root = yield* store.submit(
          submit("excluded", [{ ...entry, on: ["Failed"] }]),
          "pinned",
          "owner"
        );
        yield* materialize(root.runId);
        const [excluded] = yield* store.reportIds(root.runId);
        if (excluded === undefined) {
          return yield* Effect.die("Missing report");
        }
        expect(yield* store.reportGet(excluded)).toMatchObject({
          notApplicableReason: "OutcomeExcluded",
          reportRunId: null,
          status: "NotApplicable",
        });
        const source = yield* store.submit(
          submit("missing", [{ ...entry, scope: "invocation" }]),
          "pinned",
          "owner"
        );
        yield* store.registerInvocation(source.runId, "path", "engine", {
          taskId: "source",
        });
        const armed = (yield* store.reportPendingSources("Armed")).find(
          (row) => row.sourceRunId === source.runId
        );
        if (!armed) {
          return yield* Effect.die("Missing source");
        }
        yield* store.reportSettleSource(
          armed.sourceId,
          null,
          null,
          "NoNativeExecution"
        );
        yield* store.reportMaterialize(armed.sourceId);
        const [missing] = yield* store.reportIds(source.runId);
        if (missing === undefined) {
          return yield* Effect.die("Missing report");
        }
        expect(yield* store.reportGet(missing)).toMatchObject({
          notApplicableReason: "NoNativeExecution",
          status: "NotApplicable",
        });
        expect(yield* store.reportPromote()).toBeNull();
      }).pipe(Effect.provide(layer))
    );
  }));

test("promotion and its outbox roll back together, and four report slots do not consume normal admission", async () =>
  await databaseTest(async (filename, layer) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const source = yield* store.submit(
          submit(
            "source",
            Array.from({ length: 6 }, (_, index) => ({
              ...entry,
              attachmentId: `report-${index}`,
            }))
          ),
          "pinned",
          "owner"
        );
        yield* materialize(source.runId);
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(filename)),
          (connection) => Effect.sync(() => connection.close())
        );
        db.run(
          "CREATE TRIGGER fail_bind BEFORE UPDATE OF reportRunId ON host_reports BEGIN SELECT RAISE(ABORT, 'injected bind failure'); END"
        );
        expect(Exit.isFailure(yield* Effect.exit(store.reportPromote()))).toBe(
          true
        );
        expect(yield* store.listRuns()).toHaveLength(1);
        expect(yield* store.outbox()).toHaveLength(1);
        db.run("DROP TRIGGER fail_bind");
        const admitted: string[] = [];
        for (let index = 0; index < 4; index += 1) {
          const run = yield* store.reportPromote();
          if (!run) {
            return yield* Effect.die("Expected promoted run");
          }
          admitted.push(run.runId);
        }
        expect(Exit.isFailure(yield* Effect.exit(store.reportPromote()))).toBe(
          true
        );
        expect((yield* store.health()).counts.activeRuns).toBe(0);
        expect(
          (yield* store.submit(submit("normal", []), "pinned", "owner")).status
        ).toBe("Queued");
        const [first] = admitted;
        if (first === undefined) {
          return yield* Effect.die("Expected admitted run");
        }
        yield* store.project(first, "NeedsAttention");
        expect(yield* store.reportPromote()).not.toBeNull();
        expect((yield* store.health()).counts.activeRuns).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(layer))
    );
  }));

test("promotion rotates between sources instead of draining a large source first", async () =>
  await databaseTest(async (_filename, layer) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const plan = Array.from({ length: 16 }, (_, index) => ({
          ...entry,
          attachmentId: `report-${index}`,
        }));
        const a = yield* store.submit(submit("a", plan), "pinned", "owner");
        const b = yield* store.submit(submit("b", plan), "pinned", "owner");
        yield* materialize(a.runId);
        yield* materialize(b.runId);
        const seen: (string | undefined)[] = [];
        for (let index = 0; index < 4; index += 1) {
          seen.push((yield* store.reportPromote())?.report?.sourceRunId);
        }
        expect(new Set(seen.slice(0, 2)).size).toBe(2);
        expect(seen[0]).toBe(seen[2]);
        expect(seen[1]).toBe(seen[3]);
      }).pipe(Effect.provide(layer))
    );
  }));

test("WaitingSource cancellation survives settlement, and retry receipts precede generation conflicts", async () =>
  await databaseTest(async (_filename, layer) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const source = yield* store.submit(submit("source"), "pinned", "owner");
        const [id] = yield* store.reportIds(source.runId);
        if (id === undefined) {
          return yield* Effect.die("Missing report");
        }
        const receipt = yield* store.reportCancel(
          { reason: "unneeded", reportId: id, requestKey: "cancel" },
          "owner"
        );
        expect(receipt.status).toBe("Cancelled");
        expect(receipt.reportRunId).toBeNull();
        yield* materialize(source.runId);
        expect((yield* store.reportGet(id)).status).toBe("Cancelled");
        expect(yield* store.reportPromote()).toBeNull();
        expect(
          (yield* store.reportCancel(
            { reason: "unneeded", reportId: id, requestKey: "cancel" },
            "owner"
          )).replayed
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              store.reportCancel(
                { reason: "changed", reportId: id, requestKey: "cancel" },
                "owner"
              )
            )
          )
        ).toBe(true);
        const next = yield* store.reportRetry(
          { reportId: id, requestKey: "retry" },
          "owner",
          () => {}
        );
        expect(next.record.generation).toBe(2);
        expect(next.record.status).toBe("Queued");
        const replay = yield* store.reportRetry(
          { reportId: id, requestKey: "retry" },
          "owner",
          () => {}
        );
        expect(replay.replayed).toBe(true);
        expect(replay.record.reportId).toBe(next.record.reportId);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              store.reportRetry(
                { reportId: id, requestKey: "new-key" },
                "owner",
                () => {}
              )
            )
          )
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              store.reportRetry(
                { reportId: next.record.reportId, requestKey: "retry" },
                "owner",
                () => {}
              )
            )
          )
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              store.reportRetry(
                { reportId: id, requestKey: "retry" },
                "other",
                () => {}
              )
            )
          )
        ).toBe(true);
        const run = yield* store.reportPromote();
        if (!run) {
          return yield* Effect.die("Missing report run");
        }
        const accepted = yield* store.reportCancel(
          { reportId: next.record.reportId, requestKey: "stop" },
          "owner"
        );
        expect(accepted.status).toBe("Running");
        expect((yield* store.getRun(run.runId)).status).toBe("Cancelling");
        yield* store.project(run.runId, "Cancelled", null, "Control");
        const repeated = yield* store.reportCancel(
          { reportId: next.record.reportId, requestKey: "stop" },
          "owner"
        );
        expect(repeated.status).toBe("Running");
        expect(repeated.replayed).toBe(true);
        expect((yield* store.reportGet(next.record.reportId)).status).toBe(
          "Cancelled"
        );
      }).pipe(Effect.provide(layer))
    );
  }));

test("bulk cancellation fences promotion, drains bounded batches after reopen, and excludes later invocations and retries", async () =>
  await databaseTest(async (_filename, layer) => {
    let sourceId = "";
    const selected: string[] = [];
    let later: string[] = [];
    let retried = "";
    let receipt = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const entries = Array.from({ length: 16 }, (_, index) => ({
          ...entry,
          attachmentId: `summary-${index}`,
          scope: "invocation" as const,
        }));
        const source = yield* store.submit(
          submit("bulk", entries),
          "pinned",
          "owner"
        );
        sourceId = source.runId;
        for (let index = 0; index < 14; index += 1) {
          yield* store.registerInvocation(
            sourceId,
            `path-${index}`,
            `engine-${index}`,
            { taskId: "source" }
          );
          selected.push(
            ...entries.map((item) =>
              reportId(
                reportGroupId(
                  source.runId,
                  `engine-${index}`,
                  item.attachmentId
                ),
                1
              )
            )
          );
        }
        for (const row of yield* store.reportPendingSources("Armed")) {
          yield* store.reportSettleSource(
            row.sourceId,
            "Succeeded",
            null,
            null
          );
          yield* store.reportMaterialize(row.sourceId);
        }
        const admitted = yield* store.reportPromote();
        expect(admitted).not.toBeNull();
        receipt = JSON.stringify(
          yield* store.reportCancelSource(
            {
              reason: "operator",
              requestKey: "stop-current",
              sourceRunId: sourceId,
            },
            "owner"
          )
        );
        expect(yield* store.reportPromote()).toBeNull();
        expect(yield* store.reportCancellationDrain()).toBe(200);
        if (admitted) {
          expect((yield* store.getRun(admitted.runId)).status).toBe(
            "Cancelling"
          );
          yield* store.project(admitted.runId, "Cancelled", null);
        }
        const [first] = selected;
        if (first === undefined) {
          return yield* Effect.die("Missing selection");
        }
        retried = (yield* store.reportRetry(
          { reportId: first, requestKey: "new-generation" },
          "owner",
          () => {}
        )).record.reportId;
        yield* store.registerInvocation(sourceId, "later", "engine-later", {
          taskId: "source",
        });
        later = entries.map((item) =>
          reportId(
            reportGroupId(sourceId, "engine-later", item.attachmentId),
            1
          )
        );
        const replay = yield* store.reportCancelSource(
          {
            reason: "operator",
            requestKey: "stop-current",
            sourceRunId: sourceId,
          },
          "owner"
        );
        expect(JSON.stringify({ ...replay, replayed: false })).toBe(receipt);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              store.reportCancelSource(
                {
                  reason: "different",
                  requestKey: "stop-current",
                  sourceRunId: sourceId,
                },
                "owner"
              )
            )
          )
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              store.reportCancelSource(
                { requestKey: "unauthorized", sourceRunId: sourceId },
                "other"
              )
            )
          )
        ).toBe(true);
      }).pipe(Effect.provide(layer))
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        expect(yield* store.reportCancellationDrain()).toBe(24);
        expect(yield* store.reportCancellationDrain()).toBe(0);
        for (const id of selected) {
          expect((yield* store.reportGet(id)).status).toBe("Cancelled");
        }
        for (const id of later) {
          expect((yield* store.reportGet(id)).status).toBe("WaitingSource");
        }
        expect((yield* store.reportGet(retried)).status).toBe("Queued");
        expect((yield* store.reportPromote())?.report?.reportId).toBe(retried);
        expect((yield* store.getRun(sourceId)).status).toBe("Queued");
        const replay = yield* store.reportCancelSource(
          {
            reason: "operator",
            requestKey: "stop-current",
            sourceRunId: sourceId,
          },
          "owner"
        );
        expect(JSON.stringify({ ...replay, replayed: false })).toBe(receipt);
      }).pipe(Effect.provide(layer))
    );
  }));

test("report inspection pages freeze generation membership while aggregates stay current", async () =>
  await databaseTest(async (_filename, layer) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        const source = yield* store.submit(
          submit(
            "inspection",
            ["a", "b", "c"].map((attachmentId) => ({ ...entry, attachmentId }))
          ),
          "pinned",
          "owner"
        );
        yield* materialize(source.runId);
        for (let index = 0; index < 3; index += 1) {
          const run = yield* store.reportPromote();
          if (!run) {
            return yield* Effect.die("Missing report run");
          }
          yield* store.project(run.runId, "Succeeded", {
            data: 42,
            markdown: "# Done",
          });
        }
        const first = yield* store.reportList(
          { limit: 1, runId: source.runId },
          "owner"
        );
        expect(first.aggregate).toMatchObject({
          Queued: 0,
          Succeeded: 3,
          sourceTerminal: true,
          total: 3,
        });
        const [original] = first.items;
        if (!original || first.cursor === null) {
          return yield* Effect.die("Missing page");
        }
        expect(
          (yield* store.reportInspect(original.reportId, "owner")).content
        ).toEqual({ data: 42, markdown: "# Done" });
        const retry = yield* store.reportRetry(
          { reportId: original.reportId, requestKey: "after-page" },
          "owner",
          () => {}
        );
        const second = yield* store.reportList(
          { cursor: first.cursor, limit: 1, runId: source.runId },
          "owner"
        );
        expect(second.snapshot).toBe(first.snapshot);
        expect(second.aggregate).toMatchObject({
          Queued: 1,
          Succeeded: 2,
          total: 3,
        });
        expect(second.items[0]?.generation).toBe(1);
        const latest = yield* store.reportList(
          { runId: source.runId },
          "owner"
        );
        expect(latest.items.map((item) => item.reportId)).toContain(
          retry.record.reportId
        );
        expect(latest.items.map((item) => item.reportId)).not.toContain(
          original.reportId
        );
        expect(
          (yield* store.reportList(
            { history: true, runId: source.runId },
            "owner"
          )).items
        ).toHaveLength(4);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              store.reportList(
                {
                  cursor: first.cursor,
                  history: true,
                  limit: 1,
                  runId: source.runId,
                },
                "owner"
              )
            )
          )
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              store.reportList({ runId: source.runId }, "other")
            )
          )
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(store.reportInspect(original.reportId, "other"))
          )
        ).toBe(true);
      }).pipe(Effect.provide(layer))
    );
  }));

test(
  "sixteen attachments on 1000 invocations keep scans, inspection and cancellation bounded",
  async () =>
    await databaseTest(async (_filename, layer) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* HostStore;
          const entries = Array.from({ length: 16 }, (_, index) => ({
            ...entry,
            attachmentId: `summary-${index}`,
            scope: "invocation" as const,
          }));
          const source = yield* store.submit(
            submit("large", entries),
            "pinned",
            "owner"
          );
          for (let index = 0; index < 1000; index += 1) {
            yield* store.registerInvocation(
              source.runId,
              `path-${index}`,
              `engine-${index}`,
              { taskId: "source" }
            );
          }
          const seen = new Set<string>();
          for (let batch = 0; batch < 5; batch += 1) {
            const rows = yield* store.reportScan();
            expect(rows).toHaveLength(200);
            for (const row of rows) {
              seen.add(row.sourceId);
            }
            const last = rows.at(-1);
            if (last) {
              yield* store.reportAdvance(last.sourceSeq);
            }
          }
          expect(seen.size).toBe(1000);
          const inspectionStarted = performance.now();
          const page = yield* store.reportList(
            { limit: 200, runId: source.runId },
            "owner"
          );
          expect(performance.now() - inspectionStarted).toBeLessThan(5000);
          expect(page.items).toHaveLength(200);
          expect(page.aggregate).toMatchObject({
            WaitingSource: 16_000,
            total: 16_000,
          });
          expect(yield* store.reportSystemStatus()).toMatchObject({
            counts: { WaitingSource: 10_000 },
            lowerBound: true,
          });
          yield* store.reportCancelSource(
            { requestKey: "large-cancel", sourceRunId: source.runId },
            "owner"
          );
          let largestBatchMs = 0;
          for (let batch = 0; batch < 80; batch += 1) {
            const started = performance.now();
            expect(yield* store.reportCancellationDrain()).toBe(200);
            largestBatchMs = Math.max(
              largestBatchMs,
              performance.now() - started
            );
            yield* Effect.yieldNow;
          }
          expect(largestBatchMs).toBeLessThan(5000);
          expect(yield* store.reportCancellationDrain()).toBe(0);
          expect(
            yield* store.reportAggregate(source.runId, "owner")
          ).toMatchObject({
            Cancelled: 16_000,
            WaitingSource: 0,
            total: 16_000,
          });
          expect((yield* store.getRun(source.runId)).status).toBe("Queued");
        }).pipe(Effect.provide(layer))
      );
    }),
  60_000
);

test("32 attention reports do not consume admission slots and drain leaves queued obligations durable", async () =>
  await databaseTest(async (_filename, layer) => {
    let sourceId = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        yield* store.beginInstance("first");
        const entries = Array.from({ length: 16 }, (_, index) => ({
          ...entry,
          attachmentId: `summary-${index}`,
        }));
        for (let index = 0; index < 3; index += 1) {
          const run = yield* store.submit(
            submit(`attention-${index}`, entries),
            "pinned",
            "owner"
          );
          sourceId = run.runId;
          yield* materialize(run.runId);
        }
        for (let index = 0; index < 32; index += 1) {
          const run = yield* store.reportPromote();
          if (!run) {
            return yield* Effect.die("Missing report admission");
          }
          yield* store.project(run.runId, "NeedsAttention");
        }
        expect((yield* store.reportSystemStatus()).counts.NeedsAttention).toBe(
          32
        );
        const admitted = yield* store.reportPromote();
        expect(admitted).not.toBeNull();
        yield* store.drain({
          gracePeriodMs: 0,
          instanceId: "first",
          requestKey: "drain",
        });
        expect(Exit.isFailure(yield* Effect.exit(store.reportPromote()))).toBe(
          true
        );
        expect((yield* store.reportSystemStatus()).counts.Queued).toBe(16);
      }).pipe(Effect.provide(layer))
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostStore;
        yield* store.beginInstance("second");
        expect(yield* store.reportPromote()).not.toBeNull();
        expect((yield* store.getRun(sourceId)).status).toBe("Succeeded");
      }).pipe(Effect.provide(layer))
    );
  }));
