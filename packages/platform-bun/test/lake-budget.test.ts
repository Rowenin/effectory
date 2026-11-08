import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Artifact } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

import { createStore } from "../src/host-store.ts";
import { createLake } from "../src/lake.ts";
import { ownershipLayer, RepositoryLease } from "../src/ownership.ts";

test("a lake query exceeding its scan budget fails without a partial successful page", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-query-budget-")
  );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lease = yield* RepositoryLease;
        const database = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new Database(path.join(directory, "state.sqlite"), {
                create: true,
              })
          ),
          (db) => Effect.sync(() => db.close())
        );
        const store = createStore(database, lease);
        const lake = createLake(database, path.join(directory, "blobs"), lease);
        const run = yield* store.submit(
          {
            input: null,
            kind: "task",
            requestKey: "budget",
            targetId: "budget",
          },
          "revision",
          "owner"
        );
        yield* store.admitAttempt(run.runId, "task", 1, "idempotent");
        const artifact = Artifact.make({
          id: "budget/value",
          schema: Schema.String,
          version: 1,
        });
        yield* lake.publish(
          {
            attempt: 1,
            attemptId: "attempt",
            invocationPath: "task",
            revision: "revision",
            runId: run.runId,
            taskId: "budget",
            taskVersion: 1,
          },
          "value",
          artifact,
          "small",
          { key: "seed" }
        );
        // Populate valid metadata fixtures directly to isolate query work from
        // 10000 blob fsyncs and task admissions.
        database.exec(`WITH RECURSIVE numbers(n) AS (
          VALUES(0) UNION ALL SELECT n + 1 FROM numbers WHERE n < 9999
        ), seed AS MATERIALIZED (
          SELECT principal, schemaId, schemaVersion, fingerprint, metadataJson, fieldsJson
          FROM lake_records WHERE sequence = 1
        ) INSERT INTO lake_records(principal, artifactId, version, schemaId, schemaVersion, publicationKey, fingerprint, metadataJson, fieldsJson)
        SELECT principal, 'artifact-' || n, 1, schemaId, schemaVersion,
          'publication-' || n, fingerprint,
          json_set(metadataJson, '$.artifactId', 'artifact-' || n, '$.sequence', n + 2), fieldsJson
        FROM numbers, seed`);
        expect(
          database.query("SELECT count(*) AS count FROM lake_records").get()
        ).toEqual({ count: 10_001 });
        const request = {
          artifact: { schemaId: artifact.id, schemaVersion: 1 },
          limit: 1,
          version: 1,
          versions: "all",
        } as const;
        const result = yield* Effect.result(lake.query(request, "owner"));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.code).toBe("QueryBudgetExceeded");
        }
        const hidden = yield* lake.query(request, "other");
        expect(hidden.rows).toHaveLength(0);
        expect(hidden.scanned).toBe(0);
        expect(hidden.snapshot).toBe(0);
        expect((yield* store.getRun(run.runId)).status).toBe("Queued");
      }).pipe(
        Effect.scoped,
        Effect.provide(ownershipLayer(path.join(directory, "owner")))
      )
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
