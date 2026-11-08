/* oxlint-disable typescript/no-non-null-assertion -- Asserted fixture rows and byte positions. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Artifact,
  ArtifactReader,
  ArtifactReadError,
  ArtifactUnavailable,
  ArtifactStorage,
  Report,
  Task,
  Application,
} from "@offtree/effectory-sdk";
import { Effect, Schema, Stream, Layer } from "effect";

import example from "../../../examples/artifact-reads/effectory.ts";
import { catalogLayer } from "../src/catalog.ts";
import { createStore, HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { createLake } from "../src/lake.ts";
import { Runner } from "../src/runner.ts";

const Json = Artifact.make({
  fields: [["n"]],
  id: "reader-json",
  schema: Schema.Struct({ n: Schema.Int }),
  version: 1,
});
const Bytes = Artifact.make({
  contentType: "application/octet-stream",
  id: "reader-bytes",
  kind: "bytes",
  version: 1,
});
function setup(directory: string) {
  const db = new Database(path.join(directory, "state.sqlite"));
  const lease = { assertActive: () => {}, token: "reader-test" };
  const store = createStore(db, lease);
  const lake = createLake(db, path.join(directory, "blobs"), lease);
  const admit = (taskId: string, principal = "owner") =>
    Effect.gen(function* () {
      const run = yield* store.submit(
        {
          input: null,
          kind: "task",
          requestKey: crypto.randomUUID(),
          targetId: taskId,
        },
        "revision",
        principal
      );
      yield* store.admitAttempt(run.runId, "task", 1, "idempotent");
      const identity = {
        attempt: 1,
        attemptId: `${run.runId}/task/1`,
        invocationPath: "task",
        revision: "revision",
        runId: run.runId,
        taskId,
        taskVersion: 1,
      };
      return { binding: lake.reader(identity, () => true), identity };
    });
  return { admit, db, lake, store };
}
async function withStore<A, E>(
  body: (
    store: ReturnType<typeof setup>,
    directory: string
  ) => Effect.Effect<A, E>
) {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-reader-"));
  const f = setup(directory);
  try {
    return await Effect.runPromise(body(f, directory));
  } finally {
    f.db.close();
    await rm(directory, { force: true, recursive: true });
  }
}

for (const invocation of [false, true]) {
  test(
    `report source exemption exceeds 1024 and projection rebuild/rollback remains conservative (workflow invocation: ${invocation})`,
    () =>
      withStore((f, directory) =>
        Effect.gen(function* () {
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
              requestKey: "source-with-report",
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
            attemptId: "source/1",
            invocationPath: "task",
            revision: "revision",
            runId: run.runId,
            taskId: "source",
            taskVersion: 1,
          };
          const refs = [];
          for (let i = 0; i < 1025; i += 1) {
            refs.push(
              Schema.decodeUnknownSync(Json.refSchema)(
                yield* f.lake.publish(
                  identity,
                  "value",
                  Json,
                  { n: i },
                  { key: `row-${i}` }
                )
              )
            );
          }
          yield* f.store.project(run.runId, "Succeeded");
          const reporter = yield* f.admit("reporter");
          f.db
            .query(
              "UPDATE host_reports SET reportRunId=? WHERE groupId IN (SELECT groupId FROM host_report_groups WHERE sourceRunId=?)"
            )
            .run(reporter.identity.runId, run.runId);
          for (const ref of refs) {
            yield* reporter.binding.reader.metadata(Json, ref);
          }
          expect(
            f.db.query("SELECT COUNT(*) AS n FROM lake_consumer_pins").get()
          ).toEqual({ n: 0 });
          expect(
            f.db.query("SELECT COUNT(*) AS n FROM lake_report_holds").get()
          ).toEqual({ n: 1 });
          // A failed report transition must roll its hold back atomically.
          try {
            f.db
              .transaction(() => {
                f.db
                  .query(
                    "UPDATE host_reports SET status='Cancelled' WHERE reportRunId=?"
                  )
                  .run(reporter.identity.runId);
                expect(
                  f.db
                    .query("SELECT COUNT(*) AS n FROM lake_report_holds")
                    .get()
                ).toEqual({ n: 0 });
                throw new Error("rollback");
              })
              .immediate();
          } catch (error) {
            expect(String(error)).toContain("rollback");
          }
          expect(
            f.db.query("SELECT COUNT(*) AS n FROM lake_report_holds").get()
          ).toEqual({ n: 1 });
          // Simulate an older database without the reader projection.
          f.db.exec(
            "DROP TRIGGER lake_report_insert; DROP TRIGGER lake_report_update; DROP TRIGGER lake_report_delete; DROP TABLE lake_report_holds;"
          );
          const reopened = createLake(f.db, path.join(directory, "blobs"), {
            assertActive: () => {},
            token: "reader-test",
          });
          expect(
            f.db.query("SELECT COUNT(*) AS n FROM lake_report_holds").get()
          ).toEqual({ n: 1 });
          const ref = refs[0]!;
          const plan = yield* reopened.planReclamation({
            _tag: "Version",
            artifactId: ref.artifactId,
            version: 1,
          });
          expect(plan.protectedBy?.reportVersions).toBe(1);
          f.db
            .query(
              "UPDATE host_reports SET status='Cancelled' WHERE reportRunId=?"
            )
            .run(reporter.identity.runId);
          const reclaim = yield* reopened.planReclamation({
            _tag: "Version",
            artifactId: ref.artifactId,
            version: 1,
          });
          expect(
            (yield* reopened.applyReclamation({ planId: reclaim.planId }))
              .deletedVersions
          ).toBe(1);
          f.db
            .query(
              "UPDATE host_reports SET status='Queued' WHERE reportRunId=?"
            )
            .run(reporter.identity.runId);
          expect(
            yield* reporter.binding.reader.metadata(Json, ref).pipe(Effect.flip)
          ).toMatchObject({ reason: "Reclaimed" });
        })
      ),
    30_000
  );
}

test(
  "protection details truncate consumers without losing counts or overlap",
  () =>
    withStore((f) =>
      Effect.gen(function* () {
        const producer = yield* f.admit("producer");
        const ref = Schema.decodeUnknownSync(Json.refSchema)(
          yield* f.lake.publish(
            producer.identity,
            "value",
            Json,
            { n: 1 },
            { key: "shared" }
          )
        );
        for (let i = 0; i < 22; i += 1) {
          const consumer = yield* f.admit(`consumer-${i}`);
          yield* consumer.binding.reader.metadata(Json, ref);
        }
        const version = (yield* f.lake.versions(
          { artifactId: ref.artifactId },
          "owner"
        )).items[0]!;
        expect(version.protection).toMatchObject({
          consumerRunCount: 22,
          producerRunId: producer.identity.runId,
          truncated: true,
        });
        expect(version.protection?.consumerRunIds.length).toBe(20);
        const plan = yield* f.lake.planReclamation({
          _tag: "Version",
          artifactId: ref.artifactId,
          version: 1,
        });
        expect(plan.protectedVersions).toBe(1);
        expect(plan.protectedBy).toMatchObject({
          consumerVersions: 1,
          producerVersions: 1,
          reportVersions: 0,
        });
      })
    ),
  10_000
);

test("Report.test forwards source fixtures into real reader query and get", async () => {
  const producer = Task.make(
    {
      error: Schema.Never,
      id: "fixture-producer",
      input: Schema.Null,
      outputs: { value: Json },
      replay: "idempotent",
      success: Json.refSchema,
      version: 1,
    },
    () =>
      Effect.gen(function* () {
        return yield* (yield* ArtifactStorage).publish(
          Json,
          { n: 42 },
          { key: "daily" }
        );
      })
  );
  const reporter = Task.make(
    {
      error: Schema.Union([ArtifactReadError, ArtifactUnavailable]),
      id: "fixture-reporter",
      input: Report.sourceOf(producer),
      replay: "idempotent",
      success: Report.result(Schema.Int),
      version: 1,
    },
    (source) =>
      Effect.gen(function* () {
        const reader = yield* ArtifactReader;
        const rows = yield* reader.query(Json, {
          versions: "all",
          where: {
            _tag: "Eq",
            field: { metadata: "runId" },
            value: source.runId,
          },
        });
        const values = yield* Effect.forEach(rows.rows, (row) =>
          reader.get(Json, row.ref)
        );
        const total = values.reduce((sum, value) => sum + value.n, 0);
        return { data: total, markdown: `# ${total}` };
      })
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* Artifact.fixture(
        Json,
        { n: 42 },
        {
          key: "daily",
          output: "value",
          runId: "source-1",
          taskId: producer.id,
        }
      );
      return yield* Report.test(reporter, {
        artifacts: [fixture],
        outcome: { _tag: "Succeeded", value: fixture.reference },
        source: {
          invocationId: null,
          revision: "fixture-revision",
          runId: "source-1",
          scope: "run",
          status: "Succeeded",
          targetId: producer.id,
          targetKind: "task",
          targetVersion: 1,
        },
      });
    })
  );
  expect(result.value).toEqual({ data: 42, markdown: "# 42" });
});

test("documented graph example publishes and reads through the actual runner", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-reader-example-")
  );
  const catalog = Layer.unwrap(
    Effect.map(Application.Registry, (registry) =>
      catalogLayer("example", new Map([["example", registry]]))
    )
  ).pipe(Layer.provide(example.layer));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* Runner;
        const store = yield* HostStore;
        const accepted = yield* runner.submit(
          {
            input: 42,
            kind: "workflow",
            requestKey: "example",
            targetId: "artifact-round-trip",
          },
          "owner"
        );
        for (let i = 0; i < 1000; i += 1) {
          const run = yield* store.getRun(accepted.runId);
          if (
            [
              "Succeeded",
              "Failed",
              "Cancelled",
              "TimedOut",
              "Rejected",
            ].includes(run.status)
          ) {
            expect(run.status).toBe("Succeeded");
            expect(run.result).toBe(42);
            return;
          }
          yield* Effect.sleep("10 millis");
        }
        return yield* Effect.die("Example did not complete");
      }).pipe(
        Effect.provide(
          hostLayer({
            blobs: path.join(directory, "blobs"),
            catalog,
            database: path.join(directory, "state.sqlite"),
          })
        )
      )
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 15_000);

test.skipIf(process.getuid?.() === 0)(
  "binary reads preserve transient storage failure classification",
  () =>
    withStore((f, directory) =>
      Effect.gen(function* () {
        const producer = yield* f.admit("source");
        const ref = Schema.decodeUnknownSync(Bytes.refSchema)(
          yield* f.lake.publishBytes(
            producer.identity,
            "bytes",
            Bytes,
            Stream.succeed(new Uint8Array([1, 2, 3])),
            { key: "bytes" }
          )
        );
        yield* f.store.project(producer.identity.runId, "Succeeded");
        const consumer = yield* f.admit("consumer");
        const filename = path.join(directory, "blobs", ref.digest);
        yield* Effect.promise(() => chmod(filename, 0));
        try {
          expect(
            yield* consumer.binding.reader.bytes(Bytes, ref).pipe(Effect.flip)
          ).toMatchObject({ _tag: "ArtifactUnavailable", reason: "Storage" });
        } finally {
          yield* Effect.promise(() => chmod(filename, 0o600));
        }
        yield* Effect.promise(() => rm(filename));
        expect(
          yield* consumer.binding.reader.bytes(Bytes, ref).pipe(Effect.flip)
        ).toMatchObject({ _tag: "ArtifactReadError", reason: "Corrupt" });
      })
    ),
  10_000
);
