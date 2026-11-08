import { Database } from "bun:sqlite";
/* oxlint-disable unicorn/no-await-expression-member -- Assertions inspect fixture results. */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Query } from "@effectory/runtime/lake-protocol";
import type { RunStatus } from "@effectory/runtime/protocol";
import { Artifact } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";

import { createStore } from "../src/host-store.ts";
import { resumeReclamation } from "../src/lake-reclamation.ts";
import {
  cursorSnapshot,
  initializeRetention,
} from "../src/lake-retention-store.ts";
import { createLake } from "../src/lake.ts";

const make = (retention?: { maxVersions?: number; maxAge?: "30 days" }) =>
  Artifact.make({
    id: "report",
    schema: Schema.Int,
    version: 1,
    ...(retention ? { retention } : {}),
  });
const query: Query = {
  artifact: { schemaId: "report", schemaVersion: 1 },
  limit: 1,
  version: 1,
  versions: "all",
};
function fixture(directory: string) {
  const filename = path.join(directory, "state.sqlite");
  const database = new Database(filename);
  const lease = { assertActive: () => {}, token: "retention-test" };
  const store = createStore(database, lease);
  const blobs = path.join(directory, "blobs");
  const lake = createLake(database, blobs, lease);
  const publish = (
    artifact: Artifact.Artifact<string, typeof Schema.Int> = make(),
    value = 1,
    key = "main",
    status: RunStatus = "Succeeded",
    principal = "owner",
    output = "report"
  ) =>
    Effect.gen(function* () {
      const run = yield* store.submit(
        {
          input: {},
          kind: "task",
          requestKey: crypto.randomUUID(),
          targetId: "producer",
        },
        "revision",
        principal
      );
      yield* store.admitAttempt(run.runId, "publish", 1, "idempotent");
      const identity = {
        attempt: 1,
        attemptId: `${run.runId}/publish/1`,
        invocationPath: "publish",
        revision: "revision",
        runId: run.runId,
        taskId: "producer",
        taskVersion: 1,
      };
      const ref = yield* lake.publish(identity, output, artifact, value, {
        key,
      });
      yield* store.project(run.runId, status);
      return { ...ref, identity, runId: run.runId };
    });
  const old = (artifactId: string, version: number, days = 60) => {
    const at = Date.now() - days * 86_400_000;
    database
      .query(
        "UPDATE lake_records SET committedAtMillis = ?, metadataJson = json_set(metadataJson,'$.committedAt',?) WHERE artifactId = ? AND version = ?"
      )
      .run(at, new Date(at).toISOString(), artifactId, version);
  };
  return { blobs, database, filename, lake, lease, old, publish, store };
}
async function withLake<A, E>(
  body: (f: ReturnType<typeof fixture>) => Effect.Effect<A, E>
) {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-retention-"));
  const f = fixture(directory);
  try {
    return await Effect.runPromise(body(f));
  } finally {
    f.database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

test("captured policy changes only on a new publication and author policies preserve newest", () =>
  withLake((f) =>
    Effect.gen(function* () {
      const one = yield* f.publish(make(), 1);
      yield* f.publish(make(), 2);
      yield* f.publish(make(), 3);
      const tightened = make({ maxVersions: 1 });
      expect(
        (yield* f.lake.planReclamation({ _tag: "Policy" })).candidateVersions
      ).toBe(0);
      yield* f.publish(tightened, 4);
      const plan = yield* f.lake.planReclamation({ _tag: "Policy" });
      expect(plan.candidates.map((c) => c.version)).toEqual([1, 2, 3]);
      const result = yield* f.lake.applyReclamation({ planId: plan.planId });
      expect(result.deletedVersions).toBe(3);
      expect(result.pendingBytes).toBe(0);
      expect((yield* f.lake.get(one.artifactId, 4)).value).toBe(4);
      const versions = yield* f.lake.versions(
        { artifactId: one.artifactId, includeReclaimed: true },
        "owner"
      );
      expect(versions.items[0]?.reclamationPlanId).toBe(plan.planId);
      expect(versions.items[3]?.reclaimedAt).toBeUndefined();
    })
  ));

test("apply recomputes current newest and policy; tombstoning newest preserves its policy", () =>
  withLake((f) =>
    Effect.gen(function* () {
      const one = yield* f.publish(make(), 1);
      yield* f.publish(make(), 2);
      const latest = yield* f.publish(make({ maxVersions: 1 }), 3);
      const policy = yield* f.lake.planReclamation({ _tag: "Policy" });
      const explicit = yield* f.lake.planReclamation({
        _tag: "Version",
        artifactId: latest.artifactId,
        version: 3,
      });
      yield* f.lake.applyReclamation({ planId: explicit.planId });
      const receipt = yield* f.lake.applyReclamation({ planId: policy.planId });
      expect(receipt.deletedVersions).toBe(1);
      expect(receipt.skippedVersions).toBe(1);
      expect(
        (yield* f.lake.query(
          { ...query, versions: "latest" },
          "owner"
        )).rows.map((r) => r.version)
      ).toEqual([2]);
      const all = yield* f.lake.planReclamation({
        _tag: "Version",
        artifactId: one.artifactId,
        version: 2,
      });
      yield* f.lake.applyReclamation({ planId: all.planId });
      expect(
        (yield* f.lake
          .versions({ artifactId: one.artifactId }, "owner")
          .pipe(Effect.flip)).code
      ).toBe("NotFound");
      const restored = yield* f.publish(make({ maxVersions: 10 }), 4);
      expect(restored.version).toBe(4);
      expect(
        (yield* f.lake.planReclamation({ _tag: "Policy" })).candidateVersions
      ).toBe(0);
    })
  ));

test("daily single-version identities require operator age selection; protected producers never collect", () =>
  withLake((f) =>
    Effect.gen(function* () {
      for (let n = 0; n < 8; n += 1) {
        const ref = yield* f.publish(
          make({ maxAge: "30 days" }),
          n,
          `day-${n}`,
          (["Cancelling", "NeedsAttention"] as const)[n - 6] ?? "Succeeded"
        );
        f.old(ref.artifactId, ref.version);
      }
      expect(
        (yield* f.lake.planReclamation({ _tag: "Policy" })).candidateVersions
      ).toBe(0);
      const plan = yield* f.lake.planReclamation({
        _tag: "Selection",
        olderThanMillis: 30 * 86_400_000,
        schemaId: "report",
      });
      expect(plan.candidateVersions).toBe(6);
      expect(plan.protectedVersions).toBe(2);
      expect(plan.emptiedArtifacts).toBe(6);
      expect(
        (yield* f.lake.planReclamation({
          _tag: "Selection",
          keepLatest: 1,
          olderThanMillis: 30 * 86_400_000,
          schemaId: "report",
        })).candidateVersions
      ).toBe(0);
      expect(
        (yield* f.lake.applyReclamation({ planId: plan.planId }))
          .deletedVersions
      ).toBe(6);
    })
  ));

test("shared digests are counted once and principal-scoped plans cannot delete another actor's content", () =>
  withLake((f) =>
    Effect.gen(function* () {
      const owner = yield* f.publish(make(), 42, "owner");
      const other = yield* f.publish(make(), 42, "other", "Succeeded", "other");
      const plan = yield* f.lake.planReclamation({
        _tag: "Version",
        artifactId: owner.artifactId,
        version: 1,
      });
      expect(plan.logicalBytes).toBe(2);
      expect(plan.reclaimableBlobBytes).toBe(0);
      expect(
        (yield* f.lake
          .applyReclamation({ planId: plan.planId }, "other")
          .pipe(Effect.flip)).code
      ).toBe("NotFound");
      expect(
        (yield* f.lake.applyReclamation({ planId: plan.planId })).reclaimedBytes
      ).toBe(0);
      expect((yield* f.lake.get(other.artifactId, 1, "other")).value).toBe(42);
      const last = yield* f.lake.planReclamation(
        { _tag: "Version", artifactId: other.artifactId, version: 1 },
        "other"
      );
      expect(
        (yield* f.lake.applyReclamation({ planId: last.planId }, "other"))
          .reclaimedBytes
      ).toBe(2);
      expect(existsSync(path.join(f.blobs, owner.digest))).toBe(false);
    })
  ));

test("reclamation invalidates non-anchor query and version cursors and exposes retained latest", () =>
  withLake((f) =>
    Effect.gen(function* () {
      const one = yield* f.publish(make(), 1);
      yield* f.publish(make(), 2);
      yield* f.publish(make(), 3);
      const q = yield* f.lake.query(query, "owner");
      const v = yield* f.lake.versions(
        { artifactId: one.artifactId, limit: 1 },
        "owner"
      );
      const plan = yield* f.lake.planReclamation({
        _tag: "Version",
        artifactId: one.artifactId,
        version: 3,
      });
      yield* f.lake.applyReclamation({ planId: plan.planId });
      expect(
        (yield* f.lake
          .query(
            query,
            "owner",
            Schema.decodeUnknownSync(Schema.String)(q.cursor)
          )
          .pipe(Effect.flip)).code
      ).toBe("CursorExpired");
      expect(
        (yield* f.lake
          .versions(
            {
              artifactId: one.artifactId,
              cursor: Schema.decodeUnknownSync(Schema.String)(v.cursor),
              limit: 1,
            },
            "owner"
          )
          .pipe(Effect.flip)).code
      ).toBe("CursorExpired");
      expect(
        (yield* f.lake.query({ ...query, versions: "latest" }, "owner")).rows[0]
          ?.version
      ).toBe(2);
    })
  ));

test("applied receipts outlive expiry, while never-applied plans expire even after pruning", () =>
  withLake((f) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now());
      const ref = yield* f.publish();
      const plan = yield* f.lake.planReclamation({
        _tag: "Version",
        artifactId: ref.artifactId,
        version: 1,
      });
      const unused = yield* f.lake.planReclamation({ _tag: "Policy" });
      const receipt = yield* f.lake.applyReclamation({ planId: plan.planId });
      yield* TestClock.adjust("16 minutes");
      yield* f.lake.planReclamation({ _tag: "Policy" });
      expect(yield* f.lake.applyReclamation({ planId: plan.planId })).toEqual(
        receipt
      );
      expect(
        (yield* f.lake
          .applyReclamation({ planId: unused.planId })
          .pipe(Effect.flip)).code
      ).toBe("Conflict");
    }).pipe(Effect.provide(TestClock.layer()))
  ));

for (const phase of ["before-unlink", "after-unlink"] as const) {
  test(`pending cleanup survives failure ${phase} and resumes idempotently from another connection`, () =>
    withLake((f) =>
      Effect.gen(function* () {
        const ref = yield* f.publish();
        const plan = yield* f.lake.planReclamation({
          _tag: "Version",
          artifactId: ref.artifactId,
          version: 1,
        });
        f.database.exec(
          phase === "before-unlink"
            ? "CREATE TRIGGER fault BEFORE UPDATE OF started ON lake_reclamation_unlinks BEGIN SELECT RAISE(ABORT,'simulated interruption before unlink'); END"
            : "CREATE TRIGGER fault BEFORE UPDATE OF receiptJson ON lake_reclamation_plans WHEN json_extract(NEW.receiptJson,'$.reclaimedBytes') > 0 BEGIN SELECT RAISE(ABORT,'simulated interruption after unlink'); END"
        );
        expect(
          (yield* f.lake
            .applyReclamation({ planId: plan.planId })
            .pipe(Effect.flip)).code
        ).toBe("Unavailable");
        expect(existsSync(path.join(f.blobs, ref.digest))).toBe(
          phase === "before-unlink"
        );
        f.database.exec("DROP TRIGGER fault");
        const reopened = new Database(f.filename);
        try {
          yield* resumeReclamation(reopened, f.blobs, f.lease);
        } finally {
          reopened.close();
        }
        const receipt = yield* f.lake.applyReclamation({ planId: plan.planId });
        expect(receipt.pendingBytes).toBe(0);
        expect(receipt.reclaimedBytes).toBe(1);
        expect(receipt.deletedVersions).toBe(1);
      })
    ));
}

test("recovery rechecks a new identical publication before unlinking an old intent", () =>
  withLake((f) =>
    Effect.gen(function* () {
      const ref = yield* f.publish(make(), 42);
      const plan = yield* f.lake.planReclamation({
        _tag: "Version",
        artifactId: ref.artifactId,
        version: 1,
      });
      f.database.exec(
        "CREATE TRIGGER fault BEFORE UPDATE OF started ON lake_reclamation_unlinks BEGIN SELECT RAISE(ABORT,'hold cleanup'); END"
      );
      yield* f.lake.applyReclamation({ planId: plan.planId }).pipe(Effect.flip);
      f.database.exec("DROP TRIGGER fault");
      const next = yield* f.publish(make(), 42);
      const receipt = yield* f.lake.applyReclamation({ planId: plan.planId });
      expect(receipt.reclaimedBytes).toBe(0);
      expect(receipt.pendingBytes).toBe(0);
      expect((yield* f.lake.get(next.artifactId, next.version)).value).toBe(42);
    })
  ));

test("bulk selection advances past protected rows and through bounded plans", () =>
  withLake((f) =>
    Effect.gen(function* () {
      const seed = yield* f.publish(make(), 1, "seed", "Waiting");
      f.old(seed.artifactId, 1);
      const finished = yield* f.publish(make(), 1, "finished");
      f.old(finished.artifactId, 1);
      // Clone valid metadata to exercise paging without thousands of task admissions/fsyncs.
      const insert = f.database
        .prepare(`INSERT INTO lake_records(principal,artifactId,version,schemaId,schemaVersion,publicationKey,fingerprint,metadataJson,fieldsJson,committedAtMillis)
      SELECT principal, ?, 1, schemaId, schemaVersion, ?, fingerprint, json_set(metadataJson,'$.artifactId',?,'$.sequence',?),fieldsJson,committedAtMillis FROM lake_records WHERE sequence = ?`);
      f.database.transaction(() => {
        for (let n = 0; n < 1300; n += 1) {
          insert.run(
            `batch-${n}`,
            `receipt-${n}`,
            `batch-${n}`,
            n + 3,
            n < 200 ? 1 : 2
          );
        }
      })();
      insert.finalize();
      const selection = {
        _tag: "Selection",
        olderThanMillis: 1,
        schemaId: "report",
      } as const;
      const first = yield* f.lake.planReclamation(selection);
      expect(first.candidateVersions).toBe(1000);
      expect(first.protectedVersions).toBe(201);
      expect(first.hasMore).toBe(true);
      expect(first.reclaimableBlobBytes).toBe(0);
      expect(
        (yield* f.lake.applyReclamation({ planId: first.planId }))
          .deletedVersions
      ).toBe(1000);
      const second = yield* f.lake.planReclamation(selection);
      expect(second.candidateVersions).toBe(101);
      expect(second.hasMore).toBe(false);
      expect(
        (yield* f.lake.applyReclamation({ planId: second.planId }))
          .deletedVersions
      ).toBe(101);
      expect((yield* f.lake.planReclamation(selection)).candidateVersions).toBe(
        0
      );
      expect((yield* f.lake.get(seed.artifactId, 1)).value).toBe(1);
    })
  ));

test("plan admission cap counts only unexpired unapplied plans", () =>
  withLake((f) =>
    Effect.gen(function* () {
      const ids: string[] = [];
      for (let n = 0; n < 64; n += 1) {
        ids.push((yield* f.lake.planReclamation({ _tag: "Policy" })).planId);
      }
      expect(
        (yield* f.lake.planReclamation({ _tag: "Policy" }).pipe(Effect.flip))
          .code
      ).toBe("LimitExceeded");
      yield* f.lake.applyReclamation({ planId: ids[0] ?? "" });
      yield* f.lake.planReclamation({ _tag: "Policy" });
      yield* TestClock.adjust("16 minutes");
      yield* f.lake.planReclamation({ _tag: "Policy" });
    }).pipe(Effect.provide(TestClock.layer()))
  ));

test("age and count use OR, schema selectors rank across the identity, and aliases stay isolated", () =>
  withLake((f) =>
    Effect.gen(function* () {
      const artifact = make({ maxAge: "30 days", maxVersions: 3 });
      for (const age of [60, 40, 35, 2, 1]) {
        const ref = yield* f.publish(artifact, age);
        f.old(ref.artifactId, ref.version, age);
      }
      expect(
        (yield* f.lake.planReclamation({ _tag: "Policy" })).candidates.map(
          (c) => c.version
        )
      ).toEqual([1, 2, 3]);
      const other = Artifact.make({
        id: "other-report",
        retention: { maxVersions: 1 },
        schema: Schema.Int,
        version: 2,
      });
      const latest = yield* f.publish(other, 0, "main", "Waiting");
      const alias = yield* f.publish(
        artifact,
        0,
        "main",
        "Succeeded",
        "owner",
        "other-output"
      );
      const filtered = yield* f.lake.planReclamation({
        _tag: "Policy",
        schemaId: "report",
      });
      expect(filtered.candidates.map((c) => c.version)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(
        filtered.candidates.every((c) => c.artifactId !== alias.artifactId)
      ).toBe(true);
      const selection = yield* f.lake.planReclamation({
        _tag: "Selection",
        keepLatest: 1,
        schemaId: "report",
      });
      expect(selection.candidates.map((c) => c.version)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      // A later publication without retention supersedes the captured policy, even from an older revision.
      yield* f.publish(make(), 99);
      const result = yield* f.lake.applyReclamation({
        planId: filtered.planId,
      });
      expect(result.deletedVersions).toBe(0);
      expect(result.skippedVersions).toBe(5);
      // Duplicate receipts never rewrite the captured policy.
      yield* f.lake.publish(latest.identity, "report", other, 0, {
        key: "main",
      });
      expect(
        (yield* f.lake.planReclamation({ _tag: "Policy" })).candidateVersions
      ).toBe(0);
    })
  ));

test("metadata failure rolls back tombstones, epoch and receipt together", () =>
  withLake((f) =>
    Effect.gen(function* () {
      const ref = yield* f.publish();
      const plan = yield* f.lake.planReclamation({
        _tag: "Version",
        artifactId: ref.artifactId,
        version: 1,
      });
      f.database.exec(
        "CREATE TRIGGER fault BEFORE INSERT ON lake_reclamation_epochs BEGIN SELECT RAISE(ABORT,'metadata commit interrupted'); END"
      );
      yield* f.lake.applyReclamation({ planId: plan.planId }).pipe(Effect.flip);
      expect((yield* f.lake.get(ref.artifactId, 1)).value).toBe(1);
      expect(
        f.database
          .query(
            "SELECT receiptJson FROM lake_reclamation_plans WHERE planId = ?"
          )
          .get(plan.planId)
      ).toEqual({ receiptJson: null });
      expect(
        f.database
          .query("SELECT COUNT(*) AS count FROM lake_reclamation_unlinks")
          .get()
      ).toEqual({ count: 0 });
      f.database.exec("DROP TRIGGER fault");
      expect(
        (yield* f.lake.applyReclamation({ planId: plan.planId }))
          .deletedVersions
      ).toBe(1);
      const replay = yield* f.lake
        .publish(ref.identity, "report", make(), 1, { key: "main" })
        .pipe(Effect.flip);
      expect(replay.code).toBe("PublicationConflict");
      expect(replay.message).toContain("reclaimed");
      expect(existsSync(path.join(f.blobs, ref.digest))).toBe(false);
    })
  ));

test("legacy lake migration preserves metadata, backfills timestamps and expires legacy cursors only after reclamation", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE lake_records(sequence INTEGER PRIMARY KEY, principal TEXT, artifactId TEXT, version INTEGER, schemaId TEXT, metadataJson TEXT)"
    );
    const at = "2026-10-05T10:20:30.123Z";
    db.query(
      "INSERT INTO lake_records VALUES(1, 'owner', 'legacy', 1, 'legacy', ?)"
    ).run(JSON.stringify({ committedAt: at, digest: "a".repeat(64) }));
    initializeRetention(db);
    initializeRetention(db);
    expect(
      db
        .query(
          "SELECT retentionJson, committedAtMillis, reclaimedAt FROM lake_records"
        )
        .get()
    ).toEqual({
      committedAtMillis: Date.parse(at),
      reclaimedAt: null,
      retentionJson: null,
    });
    expect(cursorSnapshot(12, 0, "sequence")).toBe(12);
    expect(() => cursorSnapshot(12, 1, "sequence")).toThrow(
      "expired after reclamation"
    );
  } finally {
    db.close();
  }
});
