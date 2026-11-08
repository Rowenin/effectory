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

test("SQLite exhaustion rejects new work and publication atomically while retaining accepted work", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "effectory-full-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lease = yield* RepositoryLease;
        const database = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new Database(path.join(repository, "state.sqlite"), {
                create: true,
              })
          ),
          (db) => Effect.sync(() => db.close())
        );
        const store = createStore(database, lease);
        const lake = createLake(
          database,
          path.join(repository, "blobs"),
          lease
        );
        const submission = {
          input: null,
          kind: "task",
          requestKey: "accepted",
          targetId: "task",
        } as const;
        const accepted = yield* store.submit(submission, "revision", "owner");
        yield* store.admitAttempt(accepted.runId, "task", 1, "idempotent");
        const { page_count: pages } = Schema.decodeUnknownSync(
          Schema.Struct({ page_count: Schema.Int })
        )(database.query("PRAGMA page_count").get());
        // Limit only this temporary database, without consuming the host volume.
        database.exec(`PRAGMA max_page_count = ${pages}`);
        const failure = yield* Effect.result(
          store.submit(
            {
              ...submission,
              input: "x".repeat(100_000),
              requestKey: "rejected",
            },
            "revision",
            "owner"
          )
        );
        expect(failure._tag).toBe("Failure");
        if (failure._tag === "Failure") {
          expect(failure.failure.code).toBe("StorageFull");
        }
        expect((yield* store.listRuns()).map((run) => run.runId)).toEqual([
          accepted.runId,
        ]);
        expect(
          (yield* store.outbox()).filter((intent) => intent.kind === "Dispatch")
        ).toHaveLength(1);
        expect(yield* store.submit(submission, "changed", "owner")).toEqual(
          yield* store.getRun(accepted.runId)
        );
        const artifact = Artifact.make({
          fields: [["text"]],
          id: "storage/value",
          schema: Schema.Struct({ text: Schema.String }),
          version: 1,
        });
        const identity = {
          attempt: 1,
          attemptId: "attempt",
          invocationPath: "task",
          revision: "revision",
          runId: accepted.runId,
          taskId: "task",
          taskVersion: 1,
        };
        const published = yield* Effect.result(
          lake.publish(
            identity,
            "value",
            artifact,
            { text: "y".repeat(100_000) },
            { key: "main" }
          )
        );
        expect(published._tag).toBe("Failure");
        if (published._tag === "Failure") {
          expect(published.failure.code).toBe("StorageFull");
        }
        expect(
          (yield* store.events(accepted.runId)).some(
            (event) => event.tag === "ArtifactPublished"
          )
        ).toBe(false);
        expect(
          Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))(
            database.query("SELECT COUNT(*) AS count FROM lake_records").get()
          ).count
        ).toBe(0);
        expect(store.storageFailures).toBe(1);
        // Once space is available, original admission and publication keys can be retried.
        database.exec(`PRAGMA max_page_count = ${pages + 100}`);
        const reference = yield* lake.publish(
          identity,
          "value",
          artifact,
          { text: "y".repeat(100_000) },
          { key: "main" }
        );
        expect(reference.version).toBe(1);
        expect(
          (yield* store.submit(
            {
              ...submission,
              input: "x".repeat(100_000),
              requestKey: "rejected",
            },
            "revision",
            "owner"
          )).status
        ).toBe("Queued");
      }).pipe(
        Effect.scoped,
        Effect.provide(ownershipLayer(path.join(repository, "owner")))
      )
    );
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});
