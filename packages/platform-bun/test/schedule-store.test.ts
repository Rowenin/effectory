import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import type { OperationError } from "@effectory/runtime/protocol";
import { ScheduleProvenance } from "@effectory/runtime/protocol";
import { ScheduleHistoryEntry } from "@effectory/runtime/schedule-protocol";
import {
  Application,
  Workflow,
  WorkflowSchedule,
} from "@offtree/effectory-sdk";
import { Clock, Effect, Exit, Schema } from "effect";
import { TestClock } from "effect/testing";

import { Catalog } from "../src/catalog.ts";
import { createStore, HostStore } from "../src/host-store.ts";
import { startScheduler } from "../src/scheduler.ts";

function required<A>(value: A | undefined | null): A {
  if (value === null || value === undefined) {
    throw new Error("Expected fixture value");
  }
  return value;
}
const minute = 60_000;
const initial = Math.floor(Date.now() / minute) * minute;
const WorkflowInput = Schema.Struct({ name: Schema.String });
const Echo = Workflow.make(
  {
    error: Schema.Never,
    id: "echo",
    input: WorkflowInput,
    success: WorkflowInput,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    return yield* graph.input(WorkflowInput);
  })
);
const make = (
  options: Partial<
    Parameters<typeof WorkflowSchedule.make<typeof Echo.spec>>[0]
  > = {}
) =>
  WorkflowSchedule.make({
    cron: "* * * * *",
    id: "daily",
    input: { name: "Ada" },
    workflow: Echo,
    ...options,
  });
const definitions = (...values: WorkflowSchedule.Definition[]) =>
  new Map(values.map((value) => [value.id, value]));
async function withStore<A>(
  program: (
    store: ReturnType<typeof createStore>,
    database: Database
  ) => Effect.Effect<A, OperationError>
) {
  const database = new Database(":memory:");
  const store = createStore(database, {
    assertActive: () => {
      /* This isolated in-memory DB has one owner. */
    },
    token: "test-lease",
  });
  try {
    return await Effect.runPromise(program(store, database));
  } finally {
    database.close();
  }
}
const mutation = (requestKey: string, scheduleId = "daily") => ({
  requestKey,
  scheduleId,
});

test("admitted history and run provenance share the canonical occurrence constraints", () => {
  expect(ScheduleProvenance).toBe(WorkflowSchedule.Occurrence);
  const entry = {
    _tag: "Admitted" as const,
    catchUp: false,
    generation: 1,
    runId: "run",
    scheduleId: "daily",
    scheduledFor: "2026-11-05T10:00:00.000Z",
    status: "Queued" as const,
  };
  const decode = Schema.decodeUnknownSync(ScheduleHistoryEntry);
  expect(decode(entry)).toEqual(entry);
  expect(() => decode({ ...entry, generation: 0 })).toThrow();
  expect(() =>
    decode({ ...entry, scheduledFor: "2026-11-05T10:00:00Z" })
  ).toThrow();
});

test("malformed stored occurrence fails run get, history and watch snapshots without dropping rows", async () =>
  await withStore((store, database) =>
    Effect.gen(function* () {
      yield* store.scheduleReconcile(definitions(make()), "revision", initial);
      yield* store.scheduleTick("daily", initial + minute, false);
      const run = required((yield* store.listRuns())[0]);
      database.query("UPDATE host_runs SET scheduleJson=? WHERE runId=?").run(
        JSON.stringify({
          ...run.schedule,
          scheduledFor: "2026-11-05T10:00:00Z",
        }),
        run.runId
      );
      for (const read of [
        store.getRun(run.runId),
        store.history({}, "owner"),
        store.observation(run.runId, "owner"),
      ]) {
        const error = yield* Effect.match(
          read as Effect.Effect<unknown, OperationError>,
          {
            onFailure: (failure) => failure,
            onSuccess: () => {
              throw new Error("malformed occurrence was accepted");
            },
          }
        );
        expect(error.code).toBe("Unavailable");
      }
    })
  ));

test("scheduled admission is atomic, owner-visible and isolated from manual request keys", async () =>
  await withStore((store, database) =>
    Effect.gen(function* () {
      yield* store.scheduleReconcile(
        definitions(make()),
        "revision-one",
        initial
      );
      database.run(
        "CREATE TRIGGER fail_occurrence BEFORE INSERT ON host_schedule_history BEGIN SELECT RAISE(ABORT, 'injected crash before occurrence'); END"
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.scheduleTick("daily", initial + minute, false)
          )
        )
      ).toBe(true);
      expect(yield* store.listRuns()).toHaveLength(0);
      expect(yield* store.outbox()).toHaveLength(0);
      database.run("DROP TRIGGER fail_occurrence");
      yield* store.scheduleTick("daily", initial + minute, true);
      const [scheduled] = yield* store.listRuns();
      if (!scheduled) {
        throw new Error("missing scheduled run");
      }
      expect(scheduled.schedule).toMatchObject({
        catchUp: false,
        generation: 1,
        scheduleId: "daily",
        scheduledFor: new Date(initial + minute).toISOString(),
      });
      expect((yield* store.history({}, "owner")).items[0]?.schedule).toEqual(
        scheduled.schedule
      );
      expect(
        (yield* store.observation(scheduled.runId, "owner")).run.schedule
      ).toEqual(scheduled.schedule);
      yield* store.scheduleTick("daily", initial + minute, true);
      expect(yield* store.outbox()).toHaveLength(1);
      const request = {
        input: { name: "Ada" },
        kind: "workflow" as const,
        requestKey: scheduled.requestKey,
        targetId: "echo",
      };
      const manual = yield* store.submit(request, "revision-two", "owner");
      expect(manual.runId).not.toBe(scheduled.runId);
      expect(manual).not.toHaveProperty("schedule");
      expect((yield* store.lookupSubmission(request, "owner"))?.runId).toBe(
        manual.runId
      );
      expect(
        (yield* store.submit(request, "revision-three", "owner")).runId
      ).toBe(manual.runId);
      const page = yield* store.scheduleHistory(
        { scheduleId: "daily" },
        "owner",
        initial + minute
      );
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        _tag: "Admitted",
        runId: scheduled.runId,
      });
      expect(
        Exit.isFailure(
          yield* Effect.exit(store.scheduleGet("daily", "stranger", initial))
        )
      ).toBe(true);
    })
  ));

test("pause receipts survive edits/removal/re-addition; resume excludes its exact instant", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const schedule = make();
      yield* store.scheduleReconcile(definitions(schedule), "v1", initial);
      const paused = yield* store.scheduleMutation(
        { ...mutation("pause"), reason: "deploy" },
        true,
        "owner",
        initial
      );
      yield* store.scheduleReconcile(
        definitions(make({ input: { name: "Grace" } })),
        "v2",
        initial + minute
      );
      expect((yield* store.scheduleGet("daily", "owner", initial)).state).toBe(
        "Paused"
      );
      yield* store.scheduleReconcile(definitions(), "v3", initial + 2 * minute);
      expect(
        (yield* store.scheduleList({}, "owner", initial)).items
      ).toHaveLength(0);
      expect(
        (yield* store.scheduleList({ state: "Removed" }, "owner", initial))
          .items
      ).toHaveLength(1);
      yield* store.scheduleReconcile(
        definitions(schedule),
        "v4",
        initial + 3 * minute
      );
      const returned = yield* store.scheduleGet("daily", "owner", initial);
      expect(returned.generation).toBe(3);
      expect(returned.state).toBe("Paused");
      const resumed = yield* store.scheduleMutation(
        mutation("resume"),
        false,
        "owner",
        initial + 4 * minute
      );
      expect(resumed.changed).toBe(true);
      expect(
        yield* store.scheduleMutation(
          { ...mutation("pause"), reason: "deploy" },
          true,
          "owner",
          initial + 5 * minute
        )
      ).toEqual(paused);
      expect((yield* store.scheduleGet("daily", "owner", initial)).state).toBe(
        "Active"
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.scheduleMutation(mutation("pause"), false, "owner", initial)
          )
        )
      ).toBe(true);
      yield* store.scheduleTick("daily", initial + 4 * minute, true);
      expect(yield* store.listRuns()).toHaveLength(0);
      yield* store.scheduleTick("daily", initial + 5 * minute, false);
      expect(yield* store.listRuns()).toHaveLength(1);
    })
  ));

test("unfinished runs block across generations but manual runs and other schedules are independent", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      yield* store.scheduleReconcile(definitions(make()), "v1", initial);
      yield* store.scheduleTick("daily", initial + minute, false);
      const [first] = yield* store.listRuns();
      if (!first) {
        throw new Error("missing run");
      }
      for (const status of [
        "Waiting",
        "NeedsAttention",
        "Cancelling",
      ] as const) {
        yield* store.project(first.runId, status);
        yield* store.scheduleTick("daily", initial + 2 * minute, false);
        expect(
          (yield* store.scheduleGet("daily", "owner", initial)).blockedBy
            ?.status
        ).toBe(status);
      }
      yield* store.scheduleReconcile(
        definitions(
          make({ input: { name: "changed" } }),
          make({ id: "other" })
        ),
        "v2",
        initial + 3 * minute
      );
      yield* store.scheduleTick("daily", initial + 4 * minute, false);
      yield* store.scheduleTick("other", initial + 4 * minute, false);
      expect(yield* store.listRuns()).toHaveLength(2);
      yield* store.project(first.runId, "Cancelled");
      yield* store.scheduleTick("daily", initial + 5 * minute, false);
      const runs = yield* store.listRuns();
      expect(runs).toHaveLength(3);
      expect(runs.find((run) => run.schedule?.generation === 2)?.revision).toBe(
        "v2"
      );
    })
  ));

test("unchanged revisions preserve progress; late restart admits only the latest eligible occurrence", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const specs = definitions(
        make({ catchUp: { latestWithin: "1 hour" }, cron: "0 * * * *" }),
        make({ cron: "0 * * * *", id: "skip" })
      );
      const hour = Math.floor(initial / 3_600_000) * 3_600_000;
      yield* store.scheduleReconcile(specs, "v1", hour);
      yield* store.scheduleReconcile(
        specs,
        "v2",
        hour + 3 * 3_600_000 + 2 * minute
      );
      yield* store.scheduleTick(
        "daily",
        hour + 3 * 3_600_000 + 2 * minute,
        true
      );
      yield* store.scheduleTick(
        "skip",
        hour + 3 * 3_600_000 + 2 * minute,
        true
      );
      const runs = yield* store.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.revision).toBe("v2");
      expect(runs[0]?.schedule?.catchUp).toBe(true);
      const history = yield* store.scheduleHistory(
        { scheduleId: "daily" },
        "owner",
        initial
      );
      expect(history.items[0]).toMatchObject({
        _tag: "Missed",
        count: 2,
        reason: "Downtime",
      });
      expect(history.items[1]).toMatchObject({
        _tag: "Admitted",
        catchUp: true,
      });
      yield* store.scheduleTick("daily", hour, false);
      expect(yield* store.listRuns()).toHaveLength(1);
      yield* store.beginInstance("instance");
      yield* store.drain({
        gracePeriodMs: 0,
        instanceId: "instance",
        requestKey: "drain",
      });
      yield* store.project(required(runs[0]).runId, "Succeeded", {
        name: "Ada",
      });
      yield* store.scheduleTick("daily", hour + 4 * 3_600_000, false);
      expect(yield* store.listRuns()).toHaveLength(1);
      expect((yield* store.schedulerStatus(initial)).state).toBe("Draining");
    })
  ));

test("bounded receipts evict old keys without disabling pause; history cursors detect coalescing", async () =>
  await withStore((store, database) =>
    Effect.gen(function* () {
      yield* store.scheduleReconcile(definitions(make()), "v1", initial);
      for (let index = 0; index < 258; index += 1) {
        yield* store.scheduleMutation(
          mutation(`key-${index}`),
          index % 2 === 0,
          "owner",
          initial
        );
      }
      expect(
        database
          .query("SELECT count(*) AS count FROM host_schedule_receipts")
          .get()
      ).toEqual({ count: 256 });
      expect(
        (yield* store.scheduleMutation(
          mutation("key-0"),
          true,
          "owner",
          initial
        )).changed
      ).toBe(true);
      yield* store.scheduleTick("daily", initial + minute, false);
      yield* store.scheduleMutation(
        mutation("unpause"),
        false,
        "owner",
        initial + minute
      );
      yield* store.scheduleTick("daily", initial + 2 * minute, false);
      yield* store.scheduleTick("daily", initial + 3 * minute, false);
      const page = yield* store.scheduleHistory(
        { limit: 1, scheduleId: "daily" },
        "owner",
        initial
      );
      expect(page.cursor).not.toBeNull();
      yield* store.scheduleTick("daily", initial + 4 * minute, false);
      const continuation = yield* Effect.exit(
        store.scheduleHistory(
          { cursor: required(page.cursor), limit: 1, scheduleId: "daily" },
          "owner",
          initial
        )
      );
      expect(Exit.isFailure(continuation)).toBe(true);
      expect(
        (yield* store.scheduleGet("daily", "owner", initial)).lastMissed
      ).toMatchObject({ count: 2, reason: "Overlap" });
      yield* store.scheduleTick("daily", initial + 20_000 * minute, false);
      expect(
        (yield* store.scheduleGet("daily", "owner", initial)).lastMissed
      ).toMatchObject({ count: 10_000, saturated: true });
    })
  ));

test("history retains 1000 entries; pruned cursor expires and run dedup survives pruning", async () =>
  await withStore((store, database) =>
    Effect.gen(function* () {
      yield* store.scheduleReconcile(definitions(make()), "v1", initial);
      yield* store.scheduleTick("daily", initial + minute, false);
      yield* store.scheduleTick("daily", initial + 2 * minute, false);
      const page = yield* store.scheduleHistory(
        { limit: 1, scheduleId: "daily" },
        "owner",
        initial
      );
      const first = required((yield* store.listRuns())[0]);
      const insert = database.query(
        "INSERT INTO host_schedule_history(scheduleId,dataJson) VALUES ('daily',?)"
      );
      database.transaction(() => {
        for (let index = 0; index < 1000; index += 1) {
          insert.run(
            JSON.stringify({
              _tag: "Admitted",
              ...first.schedule,
              runId: first.runId,
              status: first.status,
            })
          );
        }
      })();
      yield* store.scheduleTick("daily", initial + 3 * minute, false);
      expect(
        database
          .query("SELECT count(*) AS count FROM host_schedule_history")
          .get()
      ).toEqual({ count: 1000 });
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.scheduleHistory(
              { cursor: required(page.cursor), limit: 1, scheduleId: "daily" },
              "owner",
              initial
            )
          )
        )
      ).toBe(true);
      yield* store.scheduleTick("daily", initial + minute, true);
      expect(yield* store.listRuns()).toHaveLength(1);
    })
  ));

test("scheduler uses Effect Clock, observes activation, and closes with its scope", async () => {
  const database = new Database(":memory:");
  const store = createStore(database, {
    assertActive: () => {},
    token: "clock-test",
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(initial);
          const registry = yield* Application.Registry.pipe(
            Effect.provide(Application.make({ schedules: [make()] }).layer)
          );
          let active = "v1";
          yield* startScheduler.pipe(
            Effect.provideService(HostStore, store),
            Effect.provideService(Catalog, {
              activate: () => Effect.die("unused"),
              get active() {
                return active;
              },
              assertExecutable: () => {},
              get: () => Effect.succeed({ registry, revision: active }),
              prepare: () => Effect.die("unused"),
            })
          );
          yield* TestClock.adjust("1 minute");
          expect(yield* store.listRuns()).toHaveLength(1);
          const first = required((yield* store.listRuns())[0]);
          yield* store.project(first.runId, "Succeeded", { name: "Ada" });
          active = "v2";
          yield* TestClock.adjust("1 minute");
          const runs = yield* store.listRuns();
          expect(runs).toHaveLength(2);
          expect(
            runs.find((run) => run.revision === "v2")?.schedule?.generation
          ).toBe(1);
          expect(
            (yield* store.schedulerStatus(yield* Clock.currentTimeMillis))
              .revision
          ).toBe("v2");
        })
      ).pipe(Effect.provide(TestClock.layer()))
    );
  } finally {
    database.close();
  }
});

test("temporary capacity failure retries the same occurrence and supersedes only one pending candidate", async () =>
  await withStore((store, database) =>
    Effect.gen(function* () {
      yield* store.scheduleReconcile(definitions(make()), "v1", initial);
      const template = yield* store.submit(
        {
          input: {},
          kind: "workflow",
          requestKey: "template",
          targetId: "echo",
        },
        "v1",
        "owner"
      );
      database
        .query(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<999)
    INSERT INTO host_runs(runId,kind,targetId,revision,inputJson,principal,requestKey,fingerprint,status,acceptedAt)
    SELECT 'filler-'||n,'workflow','echo','v1','{}','owner','filler-'||n,'fixture','Queued',? FROM numbers`)
        .run(new Date(initial).toISOString());
      yield* store.scheduleTick("daily", initial + minute, false);
      expect(
        (yield* store.scheduleGet("daily", "owner", initial)).lastError?.code
      ).toBe("LimitExceeded");
      yield* store.scheduleTick("daily", initial + minute + 1000, false);
      expect(
        (yield* store.scheduleHistory(
          { scheduleId: "daily" },
          "owner",
          initial
        )).items
      ).toHaveLength(0);
      yield* store.scheduleTick("daily", initial + 2 * minute, false);
      expect(
        (yield* store.scheduleGet("daily", "owner", initial)).lastMissed
      ).toMatchObject({ count: 1, reason: "AdmissionFailed" });
      database.run("DELETE FROM host_runs WHERE runId LIKE 'filler-%'");
      yield* store.project(template.runId, "Succeeded", {});
      yield* store.scheduleTick("daily", initial + 2 * minute + 1000, false);
      yield* store.scheduleTick("daily", initial + 2 * minute + 2000, true);
      expect(yield* store.listRuns()).toHaveLength(2);
      expect(
        (yield* store.scheduleGet("daily", "owner", initial)).lastError
      ).toBeNull();
      expect(
        (yield* store.scheduleHistory(
          { scheduleId: "daily" },
          "owner",
          initial
        )).items
      ).toHaveLength(2);
    })
  ));

test("tombstones evict the oldest eligible removal, preserve protected identities, and never reuse generations", async () =>
  await withStore((store, database) =>
    Effect.gen(function* () {
      yield* store.scheduleReconcile(definitions(make()), "v1", initial);
      yield* store.scheduleReconcile(definitions(), "v2", initial + minute);
      database.transaction(() => {
        const insert =
          database.query(`INSERT INTO host_schedules(scheduleId,definitionJson,digest,generation,revision,removed,removedAt,pauseJson,watermark)
      SELECT ?,definitionJson,digest,generation,revision,1,?,NULL,watermark FROM host_schedules WHERE scheduleId='daily'`);
        for (let index = 0; index < 1024; index += 1) {
          insert.run(`old-${index}`, initial + 2 * minute + index);
        }
      })();
      yield* store.scheduleMutation(
        mutation("protect"),
        true,
        "owner",
        initial
      );
      yield* store.scheduleReconcile(definitions(), "v3", initial + 3 * minute);
      expect(
        database
          .query("SELECT count(*) AS count FROM host_schedules WHERE removed=1")
          .get()
      ).toEqual({ count: 1024 });
      expect(
        Exit.isFailure(
          yield* Effect.exit(store.scheduleGet("old-0", "owner", initial))
        )
      ).toBe(true);
      expect(
        (yield* store.scheduleGet("daily", "owner", initial)).pause
      ).not.toBeNull();
      yield* store.scheduleReconcile(
        definitions(make({ id: "old-0" })),
        "v4",
        initial + 4 * minute
      );
      expect(
        (yield* store.scheduleGet("old-0", "owner", initial)).generation
      ).toBe(2);
      database
        .query("UPDATE host_schedules SET pauseJson=? WHERE removed=1")
        .run(
          JSON.stringify({
            actor: "owner",
            at: new Date(initial).toISOString(),
            reason: "protected fixture",
          })
        );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.scheduleReconcile(definitions(), "v5", initial + 5 * minute)
          )
        )
      ).toBe(false);
      // The unpaused removal can be evicted; protect another active identity before removing it.
      yield* store.scheduleReconcile(
        definitions(make({ id: "new" })),
        "v6",
        initial + 6 * minute
      );
      yield* store.scheduleMutation(
        mutation("protect", "new"),
        true,
        "owner",
        initial
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.scheduleReconcile(definitions(), "v7", initial + 7 * minute)
          )
        )
      ).toBe(true);
      expect((yield* store.schedulerStatus(initial)).revision).toBe("v6");
      yield* store.scheduleMutation(
        mutation("release"),
        false,
        "owner",
        initial
      );
      yield* store.scheduleReconcile(definitions(), "v7", initial + 7 * minute);
      expect((yield* store.schedulerStatus(initial)).revision).toBe("v7");
    })
  ));

test("tag-only schedule edits preserve pending catch-up and keep admitted metadata immutable", async () =>
  await withStore((store, database) =>
    Effect.gen(function* () {
      yield* store.scheduleReconcile(
        definitions(make({ tags: { team: "old" } })),
        "v1",
        initial
      );
      database.run(
        "CREATE TRIGGER fail_tag_admission BEFORE INSERT ON host_runs BEGIN SELECT RAISE(ABORT, 'temporary unavailable'); END"
      );
      yield* Effect.exit(store.scheduleTick("daily", initial + minute, false));
      const before = database
        .query(
          "SELECT generation,watermark,pendingSlot FROM host_schedules WHERE scheduleId='daily'"
        )
        .get();
      yield* store.scheduleReconcile(
        definitions(make({ tags: { team: "new" } })),
        "v2",
        initial + minute + 1000
      );
      expect(
        database
          .query(
            "SELECT generation,watermark,pendingSlot FROM host_schedules WHERE scheduleId='daily'"
          )
          .get()
      ).toEqual(before);
      database.run("DROP TRIGGER fail_tag_admission");
      yield* store.scheduleTick("daily", initial + minute + 2000, true);
      const run = required((yield* store.listRuns())[0]);
      expect(run.tags).toEqual({ team: "new" });
      expect(run.schedule?.generation).toBe(1);
      yield* store.scheduleReconcile(
        definitions(make({ tags: { team: "later" } })),
        "v3",
        initial + minute + 3000
      );
      expect((yield* store.getRun(run.runId)).tags).toEqual({ team: "new" });
    })
  ));

test("check thresholds preserve default identity and nondefault changes create a generation inherited at admission", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      yield* store.scheduleReconcile(definitions(make()), "checks-v1", initial);
      const before = yield* store.scheduleGet("daily", "owner", initial);
      const low = make({ checks: { failOn: "low" } });
      expect(Object.isFrozen(low.checks)).toBe(true);
      yield* store.scheduleReconcile(definitions(low), "checks-v2", initial);
      const unchanged = yield* store.scheduleGet("daily", "owner", initial);
      expect(unchanged.generation).toBe(before.generation);
      yield* store.scheduleReconcile(
        definitions(make({ checks: { failOn: "high" } })),
        "checks-v3",
        initial
      );
      const high = yield* store.scheduleGet("daily", "owner", initial);
      expect(high.generation).toBeGreaterThan(before.generation);
      expect(high.checks).toEqual({ failOn: "high" });
      yield* store.scheduleTick("daily", initial + minute, false);
      expect(required((yield* store.listRuns())[0]).checks).toEqual({
        failOn: "high",
      });
    })
  ));
