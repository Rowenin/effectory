/* oxlint-disable typescript/no-non-null-assertion -- Test fixture rows are asserted by their setup. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Artifact } from "@offtree/effectory-sdk";
import type { Duration } from "effect";
import { Effect, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";

import { automaticRetentionLayer } from "../src/automatic-retention.ts";
import { createStore } from "../src/host-store.ts";
import { automaticState } from "../src/lake-automatic-store.ts";
import { resumeReclamation } from "../src/lake-reclamation.ts";
import { createLake, Lake } from "../src/lake.ts";

const decodeCheckpoint = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ rank: Schema.Int, restarts: Schema.Int })
  )
);

const artifact = (retention?: {
  maxVersions?: number;
  maxAge?: Duration.Input;
}) =>
  Artifact.make({
    id: "retained",
    schema: Schema.Int,
    version: 1,
    ...(retention ? { retention } : {}),
  });
function setup(directory: string) {
  const filename = path.join(directory, "state.sqlite");
  const db = new Database(filename);
  const lease = { assertActive: () => {}, token: "automatic-test" };
  const store = createStore(db, lease);
  const blobs = path.join(directory, "blobs");
  const lake = createLake(db, blobs, lease);
  const admit = (taskId = "producer") =>
    Effect.gen(function* () {
      const run = yield* store.submit(
        {
          input: null,
          kind: "task",
          requestKey: crypto.randomUUID(),
          targetId: taskId,
        },
        "revision",
        "owner"
      );
      yield* store.admitAttempt(run.runId, "task", 1, "idempotent");
      return {
        attempt: 1,
        attemptId: `${run.runId}/task/1`,
        invocationPath: "task",
        revision: "revision",
        runId: run.runId,
        taskId,
        taskVersion: 1,
      };
    });
  const publish = (
    definition = artifact({ maxVersions: 1 }),
    value = 1,
    key = "main"
  ) =>
    Effect.gen(function* () {
      const identity = yield* admit();
      const ref = yield* lake.publish(identity, "output", definition, value, {
        key,
      });
      yield* store.project(identity.runId, "Succeeded");
      return { identity, ref };
    });
  const sweep = (target = lake) =>
    Effect.gen(function* () {
      for (let count = 0; count < 10_000; count += 1) {
        if (!(yield* target.automaticStep())) {
          return count;
        }
      }
      throw new Error("Collector made no bounded completion progress");
    });
  return { admit, blobs, db, filename, lake, lease, publish, store, sweep };
}
async function withLake<A, E>(
  body: (f: ReturnType<typeof setup>) => Effect.Effect<A, E>
) {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-automatic-"));
  const f = setup(directory);
  try {
    return await Effect.runPromise(body(f));
  } finally {
    f.db.close();
    await rm(directory, { force: true, recursive: true });
  }
}

test("default off, idempotent settings, generation fence, automatic receipts and idle metadata bounds", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const one = yield* f.publish();
      yield* f.publish(undefined, 2);
      expect((yield* f.lake.automaticStatus).enabled).toBe(false);
      expect(yield* f.lake.automaticStep()).toBe(false);
      const enabled = yield* f.lake.automaticSet({ enabled: true });
      expect((yield* f.lake.automaticSet({ enabled: true })).changedAt).toBe(
        enabled.changedAt
      );
      const { generation } = automaticState(f.db);
      yield* f.lake.automaticSet({ enabled: false });
      yield* f.lake.automaticSet({ enabled: true });
      expect(yield* f.lake.automaticStep(generation)).toBe(false);
      expect((yield* f.lake.get(one.ref.artifactId, 1)).value).toBe(1);
      yield* f.sweep();
      const status = yield* f.lake.automaticStatus;
      expect(status.lastBatch?.receipt).toMatchObject({
        deletedVersions: 1,
        origin: "Automatic",
        pendingBytes: 1,
      });
      expect(status.lastSweepCompletedAt).not.toBeNull();
      yield* f.lake.automaticSet({ enabled: false });
      yield* f.lake.automaticMaintenance;
      expect(existsSync(path.join(f.blobs, one.ref.digest))).toBe(false);
      const { planId } = status.lastBatch!.receipt;
      expect(yield* f.lake.applyReclamation({ planId })).toMatchObject({
        deletedVersions: 1,
        origin: "Automatic",
        pendingBytes: 0,
        reclaimedBytes: 1,
      });
      for (let i = 0; i < 8; i += 1) {
        yield* f.lake.automaticMaintenance;
      }
      expect(
        f.db.query("SELECT COUNT(*) AS n FROM lake_reclamation_plans").get()
      ).toEqual({ n: 1 });
      expect((yield* f.lake.get(one.ref.artifactId, 2)).value).toBe(2);
    })
  ));

test("age OR count, captured policy and newest protection match manual eligibility across nonmonotonic times", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now());
      const def = artifact({ maxAge: "30 days", maxVersions: 3 });
      let id = "";
      for (const [index, days] of [1, 60, 1, 40, 60].entries()) {
        const { ref } = yield* f.publish(def, index);
        id = ref.artifactId;
        f.db
          .query(
            "UPDATE lake_records SET committedAtMillis=? WHERE artifactId=? AND version=?"
          )
          .run(Date.now() - days * 86_400_000, id, ref.version);
      }
      const expected = yield* f.lake.planReclamation({ _tag: "Policy" });
      expect(expected.candidates.map((c) => c.version)).toEqual([1, 2, 4]);
      yield* f.lake.automaticSet({ enabled: true });
      yield* f.sweep();
      expect(
        f.db
          .query(
            "SELECT version FROM lake_records WHERE reclaimedAt IS NOT NULL ORDER BY version"
          )
          .all()
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 4 }]);
      expect((yield* f.lake.get(id, 5)).value).toBe(4);
      yield* f.publish(artifact(), 6);
      yield* TestClock.adjust("2 minutes");
      yield* f.sweep();
      expect((yield* f.lake.get(id, 3)).value).toBe(2);
      yield* f.publish(def, 7, "daily-key");
      f.db
        .query("UPDATE lake_records SET committedAtMillis=0 WHERE version=1")
        .run();
      yield* TestClock.adjust("2 minutes");
      yield* f.sweep();
      expect(
        f.db
          .query(
            "SELECT COUNT(*) AS n FROM lake_records WHERE version=1 AND reclaimedAt IS NULL"
          )
          .get()
      ).toEqual({ n: 1 });
    }).pipe(Effect.provide(TestClock.layer()))
  ));

test("first-access holds survive Waiting and missing consumers; release is reconsidered by the next sweep", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now());
      const { ref } = yield* f.publish();
      yield* f.publish(undefined, 2);
      const consumer = yield* f.admit("consumer");
      const binding = f.lake.reader(consumer, () => true);
      yield* binding.reader.metadata(
        artifact(),
        yield* Schema.decodeUnknownEffect(artifact().refSchema)(ref)
      );
      yield* f.store.project(consumer.runId, "Waiting");
      yield* f.lake.automaticSet({ enabled: true });
      yield* f.sweep();
      expect((yield* f.lake.get(ref.artifactId, 1)).value).toBe(1);
      yield* f.store.project(consumer.runId, "Succeeded");
      f.db
        .query(
          "INSERT INTO lake_consumer_pins VALUES('missing-consumer',(SELECT sequence FROM lake_records WHERE artifactId=? AND version=1))"
        )
        .run(ref.artifactId);
      yield* TestClock.adjust("2 minutes");
      yield* f.sweep();
      expect((yield* f.lake.get(ref.artifactId, 1)).value).toBe(1);
      f.db
        .query(
          "DELETE FROM lake_consumer_pins WHERE consumerRunId='missing-consumer'"
        )
        .run();
      yield* TestClock.adjust("2 minutes");
      yield* f.sweep();
      expect(
        (yield* f.lake.get(ref.artifactId, 1).pipe(Effect.flip)).code
      ).toBe("NotFound");
      yield* binding.close;
    }).pipe(Effect.provide(TestClock.layer()))
  ));

test("cleanup errors survive unrelated successful batches, disabled cleanup retries, and shared content is rechecked", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const first = yield* f.publish();
      yield* f.publish(undefined, 2);
      yield* f.lake.automaticSet({ enabled: true });
      f.db.run(
        "CREATE TRIGGER cleanup_fault BEFORE UPDATE OF started ON lake_reclamation_unlinks BEGIN SELECT RAISE(ABORT,'fault'); END"
      );
      yield* f.lake.automaticMaintenance;
      const failure = yield* f.lake.automaticStatus;
      expect(failure.lastError?.planId).toBe(failure.lastBatch?.receipt.planId);
      yield* f.lake.automaticMaintenance;
      expect((yield* f.lake.automaticStatus).lastError).not.toBeNull();
      yield* f.lake.automaticSet({ enabled: false });
      // Publishing the same bytes now makes the pending old digest shared.
      yield* f.publish(undefined, 1, "new-identity");
      f.db.run("DROP TRIGGER cleanup_fault");
      for (let i = 0; i < 3; i += 1) {
        yield* f.lake.automaticMaintenance;
      }
      const resolved = yield* f.lake.automaticStatus;
      expect(resolved.lastError).toBeNull();
      expect(resolved.lastBatch?.receipt).toMatchObject({
        deletedVersions: 1,
        pendingBytes: 0,
        reclaimedBytes: 0,
      });
      expect(existsSync(path.join(f.blobs, first.ref.digest))).toBe(true);
    })
  ));

test("automatic transaction rolls back checkpoint, tombstones, intents and receipt on failure", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const { ref } = yield* f.publish();
      yield* f.publish(undefined, 2);
      yield* f.lake.automaticSet({ enabled: true });
      f.db.run(
        "CREATE TRIGGER metadata_fault BEFORE INSERT ON lake_reclamation_epochs BEGIN SELECT RAISE(ABORT,'fault'); END"
      );
      yield* f.lake.automaticMaintenance;
      expect((yield* f.lake.automaticStatus).lastError).not.toBeNull();
      expect(automaticState(f.db).checkpoint).toBeNull();
      expect(
        f.db.query("SELECT COUNT(*) AS n FROM lake_reclamation_plans").get()
      ).toEqual({ n: 0 });
      expect((yield* f.lake.get(ref.artifactId, 1)).value).toBe(1);
      f.db.run("DROP TRIGGER metadata_fault");
      yield* f.sweep();
      expect((yield* f.lake.automaticStatus).lastError).toBeNull();
      expect(
        f.db.query("SELECT COUNT(*) AS n FROM lake_reclamation_plans").get()
      ).toEqual({ n: 1 });
    })
  ));

test("bounded rank checkpoints restart after mutation and defer a hot identity without starving another", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const head = yield* f.publish(artifact({ maxVersions: 1000 }));
      const template = f.db
        .query<{ metadataJson: string; retentionJson: string }, []>(
          "SELECT * FROM lake_records LIMIT 1"
        )
        .get();
      if (template === null) {
        return yield* Effect.die("Missing template record");
      }
      f.db.transaction(() => {
        for (let v = 2; v <= 500; v += 1) {
          f.db
            .query(
              "INSERT INTO lake_records(principal,artifactId,version,schemaId,schemaVersion,publicationKey,fingerprint,metadataJson,fieldsJson,retentionJson,committedAtMillis) VALUES('owner',?,?,'retained',1,?,'seed',?,'{}',?,0)"
            )
            .run(
              head.ref.artifactId,
              v,
              `seed-${v}`,
              template.metadataJson,
              template.retentionJson
            );
        }
      })();
      const other = yield* f.publish(undefined, 3, "other");
      yield* f.publish(undefined, 4, "other");
      yield* f.lake.automaticSet({ enabled: true });
      yield* f.lake.automaticStep();
      expect(decodeCheckpoint(automaticState(f.db).checkpoint!).rank).toBe(128);
      yield* f.publish(artifact({ maxVersions: 1000 }), 501);
      yield* f.lake.automaticStep();
      expect(decodeCheckpoint(automaticState(f.db).checkpoint!).restarts).toBe(
        1
      );
      yield* f.publish(artifact({ maxVersions: 1000 }), 502);
      yield* f.sweep();
      expect(
        (yield* f.lake.get(other.ref.artifactId, 1).pipe(Effect.flip)).code
      ).toBe("NotFound");
      expect((yield* f.lake.get(head.ref.artifactId, 1)).value).toBe(1);
    })
  ));

for (const invocation of [false, true]) {
  test(`automatic collection waits for report obligations (child workflow: ${invocation})`, async () =>
    await withLake((f) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now());
        const run = yield* f.store.submit(
          {
            input: null,
            kind: invocation ? "workflow" : "task",
            reportPlan: [
              {
                attachmentId: "summary",
                execution: {
                  attemptTimeout: "5 minutes",
                  timeout: "5 minutes",
                },
                on: ["Succeeded"],
                reporterId: "reporter",
                reporterProviderId: null,
                reporterVersion: 1,
                scope: invocation ? "invocation" : "run",
                targetId: "source",
                targetKind: invocation ? "workflow" : "task",
                targetVersion: 1,
              },
            ],
            requestKey: crypto.randomUUID(),
            targetId: "source",
          },
          "revision",
          "owner"
        );
        if (invocation) {
          yield* f.store.registerWorkflowInvocation(
            run.runId,
            '["child"]',
            "source"
          );
          yield* f.store.enterWorkflowInvocation(run.runId, '["child"]');
        }
        yield* f.store.admitAttempt(run.runId, "task", 1, "idempotent");
        const identity = {
          attempt: 1,
          attemptId: `${run.runId}/task/1`,
          invocationPath: "task",
          revision: "revision",
          runId: run.runId,
          taskId: "source",
          taskVersion: 1,
        };
        const ref = yield* f.lake.publish(
          identity,
          "output",
          artifact({ maxVersions: 1 }),
          1,
          { key: "value" }
        );
        yield* f.store.admitAttempt(run.runId, "second", 1, "idempotent");
        yield* f.lake.publish(
          {
            ...identity,
            attemptId: `${run.runId}/second/1`,
            invocationPath: "second",
          },
          "output",
          artifact({ maxVersions: 1 }),
          2,
          { key: "value" }
        );
        yield* f.store.project(run.runId, "Succeeded");
        yield* f.lake.automaticSet({ enabled: true });
        for (const status of [
          "WaitingSource",
          "Queued",
          "Running",
          "NeedsAttention",
        ]) {
          f.db.query("UPDATE host_reports SET status=?").run(status);
          yield* TestClock.adjust("2 minutes");
          yield* f.sweep();
          expect((yield* f.lake.get(ref.artifactId, 1)).value).toBe(1);
        }
        f.db.query("UPDATE host_reports SET status='Cancelled'").run();
        yield* TestClock.adjust("2 minutes");
        yield* f.sweep();
        expect(
          (yield* f.lake.get(ref.artifactId, 1).pipe(Effect.flip)).code
        ).toBe("NotFound");
      }).pipe(Effect.provide(TestClock.layer()))
    ));
}

test(
  "200,000 real lake versions traverse a protected prefix with bounded keyset batches and persisted rank",
  async () =>
    await withLake((f) =>
      Effect.gen(function* () {
        const { ref } = yield* f.publish(artifact({ maxVersions: 3 }));
        const held = yield* f.admit("held-producer");
        yield* f.store.project(held.runId, "NeedsAttention");
        f.db
          .query(`WITH RECURSIVE numbers(v) AS (SELECT 2 UNION ALL SELECT v+1 FROM numbers WHERE v<200000)
    INSERT INTO lake_records(principal,artifactId,version,schemaId,schemaVersion,publicationKey,fingerprint,metadataJson,fieldsJson,retentionJson,committedAtMillis)
    SELECT r.principal,r.artifactId,n.v,r.schemaId,r.schemaVersion,'bulk/'||n.v,r.fingerprint,
      json_set(r.metadataJson,'$.version',n.v,'$.runId',CASE WHEN n.v>100000 THEN ? ELSE json_extract(r.metadataJson,'$.runId') END),
      r.fieldsJson,r.retentionJson,r.committedAtMillis
    FROM numbers n CROSS JOIN lake_records r WHERE r.artifactId=? AND r.version=1`)
          .run(held.runId, ref.artifactId);
        yield* f.lake.automaticSet({ enabled: true });
        yield* f.lake.automaticStep();
        const saved = automaticState(f.db).checkpoint;
        expect(decodeCheckpoint(saved!).rank).toBe(128);
        const reopened = new Database(f.filename);
        try {
          const next = createLake(reopened, f.blobs, f.lease);
          expect(automaticState(reopened).checkpoint).toBe(saved);
          let batches = 0;
          let maximum = 0;
          const start = performance.now();
          while (true) {
            const before = performance.now();
            const more = yield* next.automaticStep();
            maximum = Math.max(maximum, performance.now() - before);
            if (!more) {
              break;
            }
            batches += 1;
            yield* Effect.yieldNow;
          }
          expect(batches).toBe(1562);
          expect(
            reopened
              .query(
                "SELECT COUNT(*) AS n FROM lake_records WHERE reclaimedAt IS NOT NULL"
              )
              .get()
          ).toEqual({ n: 100_000 });
          expect(
            reopened
              .query(
                "SELECT COUNT(*) AS n FROM lake_records WHERE reclaimedAt IS NOT NULL AND version>100000"
              )
              .get()
          ).toEqual({ n: 0 });
          const explanation = JSON.stringify(
            reopened
              .query(
                "EXPLAIN QUERY PLAN SELECT version FROM lake_records WHERE artifactId=? AND reclaimedAt IS NULL AND version<? ORDER BY version DESC LIMIT 128"
              )
              .all(ref.artifactId, 100_000)
          );
          expect(explanation).toContain("lake_retained_identity");
          expect(explanation).not.toContain("TEMP B-TREE");
          console.info(
            JSON.stringify({
              automaticRetentionProof: {
                batches,
                elapsedMillis: Math.round(performance.now() - start),
                maxBatchMillis: Math.round(maximum),
                versions: 200_000,
              },
            })
          );
        } finally {
          reopened.close();
        }
      })
    ),
  60_000
);

test(
  "SQLite contention retries without keeping a read transaction; scope closure stops the real maintenance loop",
  async () =>
    await withLake((f) =>
      Effect.gen(function* () {
        const { ref } = yield* f.publish();
        yield* f.publish(undefined, 2);
        yield* f.lake.automaticSet({ enabled: true });
        const competitor = new Database(f.filename);
        try {
          competitor.run("BEGIN IMMEDIATE");
          const release = yield* Effect.forkChild(
            Effect.sleep("60 millis").pipe(
              Effect.andThen(Effect.sync(() => competitor.run("COMMIT")))
            )
          );
          expect(yield* f.lake.automaticStep()).toBe(true);
          yield* Fiber.join(release);
          competitor.run("BEGIN IMMEDIATE");
          const error = yield* f.lake.automaticStep().pipe(Effect.flip);
          expect(error.code).toBe("Unavailable");
          expect(f.db.inTransaction).toBe(false);
          competitor.run("ROLLBACK");
          let accesses = 0;
          f.lease.assertActive = () => {
            accesses += 1;
          };
          yield* Effect.scoped(
            Layer.build(
              automaticRetentionLayer.pipe(
                Layer.provide(Layer.succeed(Lake, f.lake))
              )
            ).pipe(Effect.andThen(Effect.sleep("80 millis")))
          );
          const atClose = accesses;
          expect(atClose).toBeGreaterThan(0);
          yield* Effect.sleep("80 millis");
          expect(accesses).toBe(atClose);
          expect(existsSync(path.join(f.blobs, ref.digest))).toBe(false);
        } finally {
          if (competitor.inTransaction) {
            competitor.run("ROLLBACK");
          }
          competitor.close();
        }
      })
    ),
  10_000
);

test(
  "all 1024 externally pinned versions survive automation until their consumer completes",
  async () =>
    await withLake((f) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now());
        const producer = yield* f.admit();
        const newer = yield* f.admit();
        const consumer = yield* f.admit("consumer");
        const binding = f.lake.reader(consumer, () => true);
        const def = artifact({ maxVersions: 1 });
        for (let i = 0; i < 1024; i += 1) {
          const ref = yield* Schema.decodeUnknownEffect(def.refSchema)(
            yield* f.lake.publish(producer, "output", def, 1, {
              key: `pin-${i}`,
            })
          );
          yield* f.lake.publish(newer, "output", def, 2, { key: `pin-${i}` });
          yield* binding.reader.metadata(def, ref);
        }
        yield* f.store.project(producer.runId, "Succeeded");
        yield* f.store.project(newer.runId, "Succeeded");
        yield* f.lake.automaticSet({ enabled: true });
        yield* f.sweep();
        expect(
          f.db
            .query(
              "SELECT COUNT(*) AS n FROM lake_records WHERE reclaimedAt IS NOT NULL"
            )
            .get()
        ).toEqual({ n: 0 });
        expect(
          f.db.query("SELECT COUNT(*) AS n FROM lake_reclamation_plans").get()
        ).toEqual({ n: 0 });
        yield* f.store.project(consumer.runId, "Succeeded");
        yield* TestClock.adjust("2 minutes");
        yield* f.sweep();
        expect(
          f.db
            .query(
              "SELECT COUNT(*) AS n FROM lake_records WHERE reclaimedAt IS NOT NULL"
            )
            .get()
        ).toEqual({ n: 1024 });
        yield* binding.close;
      }).pipe(Effect.provide(TestClock.layer()))
    ),
  30_000
);

test("huge count policy does not rank with OFFSET; manual deletion resets a partial rank and keeps the newest survivor", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const { ref } = yield* f.publish(
        artifact({ maxVersions: Number.MAX_SAFE_INTEGER })
      );
      const template = f.db
        .query<{ metadataJson: string }, []>(
          "SELECT metadataJson FROM lake_records LIMIT 1"
        )
        .get();
      if (template === null) {
        return yield* Effect.die("Missing template record");
      }
      f.db
        .query(`WITH RECURSIVE n(v) AS (SELECT 2 UNION ALL SELECT v+1 FROM n WHERE v<260)
    INSERT INTO lake_records(principal,artifactId,version,schemaId,schemaVersion,publicationKey,fingerprint,metadataJson,fieldsJson,retentionJson,committedAtMillis)
    SELECT 'owner',?,v,'retained',1,'large/'||v,'seed',?,'{}',?,0 FROM n`)
        .run(
          ref.artifactId,
          template.metadataJson,
          JSON.stringify({ maxVersions: Number.MAX_SAFE_INTEGER })
        );
      yield* f.lake.automaticSet({ enabled: true });
      yield* f.lake.automaticStep();
      const plan = yield* f.lake.planReclamation({
        _tag: "Version",
        artifactId: ref.artifactId,
        version: 260,
      });
      yield* f.lake.applyReclamation({ planId: plan.planId });
      yield* f.lake.automaticStep();
      expect(decodeCheckpoint(automaticState(f.db).checkpoint!).restarts).toBe(
        1
      );
      yield* f.sweep();
      expect((yield* f.lake.automaticStatus).lastBatch).toBeNull();
      expect(
        f.db
          .query(
            "SELECT COUNT(*) AS n FROM lake_records WHERE reclaimedAt IS NULL"
          )
          .get()
      ).toEqual({ n: 259 });
    })
  ));

test("maintenance errors remain visible when storage cannot persist its own diagnostic", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      yield* f.publish();
      yield* f.publish(undefined, 2);
      yield* f.lake.automaticSet({ enabled: true });
      f.db.run(
        "CREATE TRIGGER break_scan BEFORE INSERT ON lake_reclamation_epochs BEGIN SELECT RAISE(ABORT,'scan'); END; CREATE TRIGGER break_diagnostic BEFORE UPDATE OF scanError ON lake_automatic_state WHEN NEW.scanError IS NOT NULL BEGIN SELECT RAISE(ABORT,'diagnostic'); END;"
      );
      yield* f.lake.automaticMaintenance;
      expect(automaticState(f.db).scanError).toBeNull();
      expect((yield* f.lake.automaticStatus).lastError?.message).toContain(
        "scan failed"
      );
      yield* f.lake.automaticSet({ enabled: false });
      yield* f.lake.automaticMaintenance;
      expect((yield* f.lake.automaticStatus).lastError).not.toBeNull();
      f.db.run("DROP TRIGGER break_scan; DROP TRIGGER break_diagnostic");
      yield* f.lake.automaticSet({ enabled: true });
      yield* f.sweep();
      expect((yield* f.lake.automaticStatus).lastError).toBeNull();
    })
  ));

for (const phase of [
  "before-commit",
  "after-commit",
  "after-unlink",
] as const) {
  test(
    `real collector SIGKILL recovery at ${phase} preserves one deletion receipt`,
    async () =>
      await withLake((f) =>
        Effect.gen(function* () {
          const { ref } = yield* f.publish();
          yield* f.publish(undefined, 2);
          yield* f.lake.automaticSet({ enabled: true });
          const file = path.join(
            path.dirname(f.filename),
            "collector-crash.ts"
          );
          const imports = {
            effect: import.meta.resolve("effect"),
            lake: new URL("../src/lake.ts", import.meta.url).href,
            store: new URL("../src/host-store.ts", import.meta.url).href,
          };
          yield* Effect.promise(
            async () =>
              await writeFile(
                file,
                `
      import {Database} from "bun:sqlite";
      import {Effect} from ${JSON.stringify(imports.effect)};
      import {createStore} from ${JSON.stringify(imports.store)};
      import {createLake} from ${JSON.stringify(imports.lake)};
      const db=new Database(${JSON.stringify(f.filename)});
      const lease={assertActive:()=>{},token:"automatic-test"};
      createStore(db,lease);
      const lake=createLake(db,${JSON.stringify(f.blobs)},lease);
      const phase=${JSON.stringify(phase)};
      const query=db.query.bind(db);
      db.query=(sql)=>new Proxy(query(sql),{get(target,property){
        if(property==="run") return (...args)=>{
          if((phase==="before-commit" && sql.includes("INSERT INTO lake_reclamation_epochs")) ||
            (phase==="after-unlink" && sql.includes("UPDATE lake_reclamation_plans SET receiptJson") && JSON.parse(args[0]).reclaimedBytes>0)) process.kill(process.pid,"SIGKILL");
          return target.run(...args);
        };
        const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
      }});
      await Effect.runPromise(lake.${phase === "after-unlink" ? "automaticMaintenance" : "automaticStep()"});
      process.kill(process.pid,"SIGKILL");
    `
              )
          );
          const child = Bun.spawn([process.execPath, file], {
            stderr: "pipe",
            stdout: "ignore",
          });
          const code = yield* Effect.promise(async () => await child.exited);
          const error = yield* Effect.promise(
            async () => await new Response(child.stderr).text()
          );
          expect(error).toBe("");
          expect(code).not.toBe(0);
          expect(child.signalCode).toBe("SIGKILL");
          const before = yield* f.lake.automaticStatus;
          if (phase === "before-commit") {
            expect(before.lastBatch).toBeNull();
            expect((yield* f.lake.get(ref.artifactId, 1)).value).toBe(1);
          } else {
            expect(before.lastBatch?.receipt.deletedVersions).toBe(1);
            expect(existsSync(path.join(f.blobs, ref.digest))).toBe(
              phase === "after-commit"
            );
          }
          yield* f.sweep();
          yield* resumeReclamation(f.db, f.blobs, f.lease);
          const after = yield* f.lake.automaticStatus;
          expect(after.lastBatch?.receipt).toMatchObject({
            deletedVersions: 1,
            origin: "Automatic",
            pendingBytes: 0,
            reclaimedBytes: 1,
          });
          if (before.lastBatch !== null) {
            expect(after.lastBatch?.receipt.planId).toBe(
              before.lastBatch.receipt.planId
            );
          }
          expect(
            f.db.query("SELECT COUNT(*) AS n FROM lake_reclamation_plans").get()
          ).toEqual({ n: 1 });
          expect((yield* f.lake.get(ref.artifactId, 2)).value).toBe(2);
        })
      ),
    15_000
  );
}
