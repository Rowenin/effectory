import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  Expression,
  Field,
  Query,
} from "@effectory/runtime/lake-protocol";
import { Artifact } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

import { createStore } from "../src/host-store.ts";
import { initializeQueryIndexes } from "../src/lake-query-candidates.ts";
import { createLake } from "../src/lake.ts";
import { ownershipLayer, RepositoryLease } from "../src/ownership.ts";

const Document = Artifact.make({
  fields: [["optional"], ["status"]],
  id: "query/document",
  schema: Schema.Struct({
    optional: Schema.optionalKey(Schema.NullOr(Schema.String)),
    status: Schema.String,
  }),
  version: 1,
});
const query: Query = {
  artifact: { schemaId: Document.id, schemaVersion: 1 },
  limit: 200,
  version: 1,
  versions: "all",
};
interface Fixture {
  readonly database: Database;
  readonly lake: ReturnType<typeof createLake>;
  readonly store: ReturnType<typeof createStore>;
}
async function withLake<E>(body: (fixture: Fixture) => Effect.Effect<void, E>) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-query-candidates-")
  );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lease = yield* RepositoryLease;
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(path.join(directory, "state.sqlite"))),
          (connection) => Effect.sync(() => connection.close())
        );
        const store = createStore(database, lease);
        const lake = createLake(database, path.join(directory, "blobs"), lease);
        yield* body({ database, lake, store });
      }).pipe(
        Effect.scoped,
        Effect.provide(ownershipLayer(path.join(directory, "owner.sqlite")))
      )
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
const defaultValue = { status: "old" };
function publish(
  f: Fixture,
  requestKey: string,
  key: string,
  tags: Readonly<Record<string, string>> = {},
  value: typeof Document.schema.Type = defaultValue,
  artifact = Document
) {
  return Effect.gen(function* () {
    const run = yield* f.store.submit(
      { input: null, kind: "task", requestKey, targetId: "producer" },
      "revision",
      "owner"
    );
    yield* f.store.admitAttempt(run.runId, "publish", 1, "idempotent");
    const ref = yield* f.lake.publish(
      {
        attempt: 1,
        attemptId: `${run.runId}/publish/1`,
        invocationPath: "publish",
        revision: "revision",
        runId: run.runId,
        taskId: "producer",
        taskVersion: 1,
      },
      "document",
      artifact,
      value,
      { key, tags }
    );
    return { ref, runId: run.runId };
  });
}
const eq = (field: Field, value: string): Expression => ({
  _tag: "Eq",
  field,
  value,
});

test(
  "run, task, identity and conjunctive tag queries exclude 100000 unrelated rows before the budget",
  async () =>
    await withLake((f) =>
      Effect.gen(function* () {
        const seed = yield* publish(f, "seed", "seed", {
          deployment: "wanted",
          team: "wanted",
        });
        // Avoid thrashing the default tiny page cache while building the
        // synthetic corpus. Query semantics and production budgets are unchanged.
        f.database.run("PRAGMA cache_size = -65536");
        // Populate valid metadata directly to isolate query work from publication
        // fsyncs. Each unrelated row matches at most one of the two tag filters.
        f.database.run(`WITH RECURSIVE numbers(n) AS (
          VALUES(0) UNION ALL SELECT n + 1 FROM numbers WHERE n < 99999
        ), seed AS MATERIALIZED (
          SELECT principal,schemaId,schemaVersion,fingerprint,metadataJson,fieldsJson FROM lake_records WHERE sequence = 1
        ) INSERT INTO lake_records(principal,artifactId,version,schemaId,schemaVersion,publicationKey,fingerprint,metadataJson,fieldsJson)
        SELECT principal, 'bulk-' || n, 1, schemaId, schemaVersion, 'bulk-' || n, fingerprint,
          json_set(metadataJson, '$.artifactId', 'bulk-' || n, '$.sequence', n + 2, '$.runId', 'run-' || n,
            '$.taskId', 'unrelated', '$.tags.team', CASE WHEN n % 2 = 0 THEN 'wanted' ELSE 'other' END,
            '$.tags.deployment', CASE WHEN n % 2 = 0 THEN 'other' ELSE 'wanted' END), fieldsJson
        FROM numbers, seed`);
        const filters: Expression[] = [
          eq({ metadata: "runId" }, seed.runId),
          eq({ metadata: "taskId" }, "producer"),
          eq({ metadata: "artifactId" }, seed.ref.artifactId),
          {
            _tag: "And",
            terms: [
              eq({ tag: "team" }, "wanted"),
              eq({ tag: "deployment" }, "wanted"),
            ],
          },
        ];
        for (const where of filters) {
          const prepared = spyOn(f.database, "prepare");
          let sql: string | undefined;
          const result = yield* f.lake
            .query({ ...query, limit: 1, where }, "owner")
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  sql = prepared.mock.calls.find(([text]) =>
                    text.includes("SELECT r.metadataJson")
                  )?.[0];
                  prepared.mockRestore();
                })
              )
            );
          expect(result.rows.map((row) => row.artifactId)).toEqual([
            seed.ref.artifactId,
          ]);
          expect(result.scanned).toBe(1);
          expect(result.matched).toBe(1);
          expect(result.cursor).toBeNull();
          if (
            where._tag === "Eq" &&
            "metadata" in where.field &&
            where.field.metadata === "artifactId"
          ) {
            // `scanned` counts returned rows, not work hidden inside SQLite.
            // Inspect the real query: identity must constrain the index seek,
            // rather than filtering every row under the schema index.
            expect(sql).toBeDefined();
            const plan = yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ detail: Schema.String }))
            )(
              f.database
                .query(`EXPLAIN QUERY PLAN ${sql}`)
                .all(
                  "owner",
                  Document.id,
                  1,
                  result.snapshot,
                  seed.ref.artifactId
                )
            );
            expect(
              plan.some((row) => row.detail.includes("artifactId=?"))
            ).toBe(true);
          }
        }
        const broad = yield* f.lake.query(query, "owner").pipe(Effect.flip);
        expect(broad.code).toBe("QueryBudgetExceeded");
        const other = yield* f.lake.query(
          { ...query, where: eq({ metadata: "runId" }, seed.runId) },
          "other-owner"
        );
        expect(other.rows).toEqual([]);
      })
    ),
  30_000
);

test("candidate narrowing agrees with the full evaluator for compound predicates, literal keys and Unicode", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const alpha = yield* publish(
        f,
        "alpha",
        "alpha",
        {
          empty: "",
          nul: "a\0b",
          odd: String.fromCodePoint(0xd8_00),
          team: "a",
          "team.name/x": "東京😀",
        },
        { optional: null, status: "old" }
      );
      yield* publish(f, "beta", "beta", { team: "b" }, { status: "old" });
      yield* publish(
        f,
        "gamma",
        "gamma",
        { team: "a" },
        { optional: "x", status: "new" }
      );
      const expressions: Expression[] = [
        eq({ metadata: "runId" }, alpha.runId),
        eq({ metadata: "taskId" }, "producer"),
        eq({ metadata: "artifactId" }, alpha.ref.artifactId),
        eq({ tag: "team.name/x" }, "東京😀"),
        eq({ tag: "empty" }, ""),
        eq({ tag: "missing" }, ""),
        eq({ tag: "nul" }, "a\0b"),
        eq({ tag: "odd" }, "\uD800"),
        eq({ tag: 'team" OR 1=1 --' }, "a"),
        eq({ tag: "team" }, "a' OR 1=1 --"),
        {
          _tag: "Or",
          terms: [eq({ tag: "team" }, "a"), eq({ tag: "team" }, "b")],
        },
        { _tag: "Not", term: eq({ tag: "team" }, "a") },
        {
          _tag: "And",
          terms: [
            eq({ tag: "team" }, "a"),
            { _tag: "Not", term: eq({ json: ["status"] }, "new") },
          ],
        },
        {
          _tag: "And",
          terms: [
            eq({ tag: "team" }, "a"),
            { _tag: "Eq", field: { json: ["optional"] }, value: null },
          ],
        },
        {
          _tag: "And",
          terms: [
            { _tag: "And", terms: [eq({ tag: "team" }, "a")] },
            {
              _tag: "Or",
              terms: [
                eq({ json: ["status"] }, "old"),
                eq({ json: ["status"] }, "new"),
              ],
            },
          ],
        },
      ];
      for (const where of expressions) {
        const request = {
          ...query,
          orderBy: [{ direction: "desc", field: { json: ["status"] } }],
          select: [{ field: { json: ["optional"] }, name: "optional" }],
          where,
        } as const;
        const narrowed = yield* f.lake.query(request, "owner");
        // A one-term Or is equivalent, but deliberately cannot be pushed down.
        const baseline = yield* f.lake.query(
          { ...request, where: { _tag: "Or", terms: [where] } },
          "owner"
        );
        expect(narrowed.rows).toEqual(baseline.rows);
        expect(narrowed.matched).toBe(baseline.matched);
        expect(narrowed.snapshot).toBe(baseline.snapshot);
      }
    })
  ));

test("latest ranking ignores pushed filters and cursors keep their original publication snapshot", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const alpha = yield* publish(f, "alpha", "alpha", { team: "old" });
      const beta = yield* publish(f, "beta", "beta", { team: "old" });
      const request: Query = {
        ...query,
        limit: 1,
        versions: "latest",
        where: eq({ tag: "team" }, "old"),
      };
      const first = yield* f.lake.query(request, "owner");
      expect(first.rows[0]?.artifactId).toBe(alpha.ref.artifactId);
      expect(first.cursor).not.toBeNull();
      yield* publish(f, "beta2", "beta", { team: "new" });
      const next = yield* f.lake.query(
        request,
        "owner",
        first.cursor ?? undefined
      );
      expect(next.rows.map((row) => [row.artifactId, row.version])).toEqual([
        [beta.ref.artifactId, 1],
      ]);
      expect(next.snapshot).toBe(first.snapshot);
      expect(next.cursor).toBeNull();
      const fresh = yield* f.lake.query({ ...request, limit: 200 }, "owner");
      expect(fresh.rows.map((row) => row.artifactId)).toEqual([
        alpha.ref.artifactId,
      ]);
      const oldRun = yield* f.lake.query(
        {
          ...query,
          versions: "latest",
          where: eq({ metadata: "runId" }, beta.runId),
        },
        "owner"
      );
      expect(oldRun.rows).toEqual([]);
      const newerSchema = Artifact.make({
        fields: Document.fields,
        id: Document.id,
        schema: Document.schema,
        version: 2,
      });
      yield* publish(
        f,
        "alpha2",
        "alpha",
        { team: "old" },
        { status: "old" },
        newerSchema
      );
      expect(
        (yield* f.lake.query({ ...request, limit: 200 }, "owner")).rows
      ).toEqual([]);
    })
  ));

test("query tag indexes backfill existing records and track metadata changes and reclamation atomically", async () =>
  await withLake((f) =>
    Effect.gen(function* () {
      const first = yield* publish(f, "first", "first", { "team/name": "old" });
      const second = yield* publish(f, "second", "second", {
        "team/name": "old",
      });
      f.database.run(`DROP TRIGGER lake_query_tags_insert;
      DROP TRIGGER lake_query_tags_update;
      DROP TABLE lake_query_tags`);
      initializeQueryIndexes(f.database);
      initializeQueryIndexes(f.database);
      const request = {
        ...query,
        limit: 1,
        where: eq({ tag: "team/name" }, "old"),
      } as const;
      const page = yield* f.lake.query(request, "owner");
      expect(page.scanned).toBe(2);
      expect(page.cursor).not.toBeNull();
      f.database
        .query(
          "UPDATE lake_records SET metadataJson = json_set(metadataJson, '$.tags.\"team/name\"', 'new') WHERE artifactId = ?"
        )
        .run(second.ref.artifactId);
      const changed = yield* f.lake.query(
        { ...query, where: eq({ tag: "team/name" }, "new") },
        "owner"
      );
      expect(changed.rows.map((row) => row.artifactId)).toEqual([
        second.ref.artifactId,
      ]);
      expect(changed.scanned).toBe(1);
      yield* f.store.project(first.runId, "Succeeded");
      const plan = yield* f.lake.planReclamation({
        _tag: "Version",
        artifactId: first.ref.artifactId,
        version: first.ref.version,
      });
      yield* f.lake.applyReclamation({ planId: plan.planId });
      expect((yield* f.lake.query(request, "owner")).rows).toEqual([]);
      expect(
        f.database.query("SELECT COUNT(*) AS total FROM lake_query_tags").get()
      ).toEqual({ total: 1 });
      const expired = yield* f.lake
        .query(request, "owner", page.cursor ?? undefined)
        .pipe(Effect.flip);
      expect(expired.code).toBe("CursorExpired");
    })
  ));
