import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Query, Expression } from "@effectory/runtime/lake-protocol";
import type { OperationError } from "@effectory/runtime/protocol";
import { Artifact } from "@offtree/effectory-sdk";
import type { Task, TaskRuntimeError } from "@offtree/effectory-sdk";
import { Effect, Exit, Layer, Schema } from "effect";

import { HostStore, hostStoreLayer } from "../src/host-store.ts";
import { Lake, lakeLayer } from "../src/lake.ts";
import { ownershipLayer } from "../src/ownership.ts";

const Summary = Artifact.make({
  fields: [["status"], ["optional"]],
  id: "test/summary",
  schema: Schema.Struct({
    optional: Schema.optionalKey(Schema.NullOr(Schema.String)),
    status: Schema.String,
  }),
  version: 1,
});
const query: Query = {
  artifact: { schemaId: Summary.id, schemaVersion: 1 },
  limit: 1,
  version: 1,
  versions: "latest",
};

async function withLake<A>(
  program: Effect.Effect<
    A,
    OperationError | TaskRuntimeError,
    typeof HostStore.Service | typeof Lake.Service
  >
) {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-lake-"));
  const filename = path.join(directory, "state.sqlite");
  try {
    return await Effect.runPromise(
      program.pipe(
        Effect.provide(
          lakeLayer(filename, path.join(directory, "blobs")).pipe(
            Layer.provideMerge(hostStoreLayer(filename)),
            Layer.provide(ownershipLayer(path.join(directory, "owner.sqlite")))
          )
        )
      )
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function producer(key: string) {
  return Effect.gen(function* () {
    const store = yield* HostStore;
    const run = yield* store.submit(
      { input: {}, kind: "task", requestKey: key, targetId: "test/task" },
      "revision",
      "owner"
    );
    yield* store.admitAttempt(run.runId, "publish", 1, "idempotent");
    const identity: Task.Identity = {
      attempt: 1,
      attemptId: `${run.runId}/publish/1`,
      invocationPath: "publish",
      revision: "revision",
      runId: run.runId,
      taskId: "test/task",
      taskVersion: 1,
    };
    return identity;
  });
}

test("slot publication keys share an artifact across runs while different slots remain distinct", () =>
  withLake(
    Effect.gen(function* () {
      const lake = yield* Lake;
      const key = `slot-${Date.parse("2026-11-05T10:00:00.000Z")}`;
      const first = yield* producer("slot-first");
      const second = yield* producer("slot-second");
      const original = yield* lake.publish(
        first,
        "summary",
        Summary,
        { status: "original" },
        { key }
      );
      const revised = yield* lake.publish(
        second,
        "summary",
        Summary,
        { status: "revised" },
        { key }
      );
      expect(revised.artifactId).toBe(original.artifactId);
      expect(revised.version).toBe(2);
      const next = yield* lake.publish(
        second,
        "summary",
        Summary,
        { status: "next" },
        { key: `slot-${Date.parse("2026-11-05T11:00:00.000Z")}` }
      );
      expect(next.artifactId).not.toBe(original.artifactId);
      expect(next.version).toBe(1);
    })
  ));

test("publication commits provenance and one event; replay and changed metadata are distinct", () =>
  withLake(
    Effect.gen(function* () {
      const lake = yield* Lake;
      const store = yield* HostStore;
      const identity = yield* producer("one");
      const ref = yield* lake.publish(
        identity,
        "summary",
        Summary,
        { status: "ready" },
        { key: "main", tags: { environment: "test" } }
      );
      expect(
        yield* lake.publish(
          identity,
          "summary",
          Summary,
          { status: "ready" },
          { key: "main", tags: { environment: "test" } }
        )
      ).toEqual(ref);
      const content = yield* lake.get(ref.artifactId, ref.version);
      expect(content.value).toEqual({ status: "ready" });
      expect(content.metadata.runId).toBe(identity.runId);
      expect(
        (yield* store.events(identity.runId)).filter(
          (event) => event.tag === "ArtifactPublished"
        )
      ).toHaveLength(1);
      const conflict = yield* Effect.exit(
        lake.publish(
          identity,
          "summary",
          Summary,
          { status: "changed" },
          { key: "main" }
        )
      );
      expect(Exit.isFailure(conflict)).toBe(true);
      yield* store.cancel(identity.runId);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            lake.publish(
              identity,
              "summary",
              Summary,
              { status: "late" },
              { key: "late" }
            )
          )
        )
      ).toBe(true);
    })
  ));

test("latest query pagination pins old versions while concurrent runs publish new ones", () =>
  withLake(
    Effect.gen(function* () {
      const lake = yield* Lake;
      const first = yield* producer("first");
      const alpha = yield* lake.publish(
        first,
        "summary",
        Summary,
        { status: "old" },
        { key: "alpha" }
      );
      const beta = yield* lake.publish(
        first,
        "summary",
        Summary,
        { status: "old" },
        { key: "beta" }
      );
      const page = yield* lake.query(query, "owner");
      expect(page.rows.map((record) => record.artifactId)).toEqual([
        alpha.artifactId,
      ]);
      expect(page.cursor).not.toBeNull();
      const second = yield* producer("second");
      const newer = yield* lake.publish(
        second,
        "summary",
        Summary,
        { status: "new" },
        { key: "beta" }
      );
      expect(newer.version).toBe(2);
      const continuation = yield* lake.query(
        query,
        "owner",
        page.cursor ?? undefined
      );
      expect(
        continuation.rows.map((record) => [record.artifactId, record.version])
      ).toEqual([[beta.artifactId, 1]]);
      expect(continuation.snapshot).toBe(page.snapshot);
      const fresh = yield* lake.query({ ...query, limit: 200 }, "owner");
      expect(fresh.rows.map((record) => record.version)).toEqual([1, 2]);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            lake.query(query, "another-owner", page.cursor ?? undefined)
          )
        )
      ).toBe(true);
    })
  ));

test("declared field queries distinguish missing and null, and query validation rejects unsupported fields", () =>
  withLake(
    Effect.gen(function* () {
      const lake = yield* Lake;
      const identity = yield* producer("query");
      yield* lake.publish(
        identity,
        "summary",
        Summary,
        { status: "ready" },
        { key: "missing" }
      );
      yield* lake.publish(
        identity,
        "summary",
        Summary,
        { optional: null, status: "ready" },
        { key: "null", tags: { env: "prod" } }
      );
      const matches = yield* lake.query(
        {
          ...query,
          where: { _tag: "Eq", field: { json: ["optional"] }, value: null },
        },
        "owner"
      );
      expect(matches.rows).toHaveLength(1);
      expect(matches.rows[0]?.tags).toEqual({ env: "prod" });
      const tagged = yield* lake.query(
        {
          ...query,
          where: { _tag: "Eq", field: { tag: "env" }, value: "prod" },
        },
        "owner"
      );
      expect(tagged.rows).toHaveLength(1);
      const invalid = yield* Effect.exit(
        lake.query(
          {
            ...query,
            where: { _tag: "Eq", field: { json: ["secret"] }, value: "x" },
          },
          "owner"
        )
      );
      expect(Exit.isFailure(invalid)).toBe(true);
    })
  ));

const Metric = Artifact.make({
  fields: [["name"], ["score"], ["optional"]],
  id: "test/metric",
  schema: Schema.Struct({
    name: Schema.String,
    optional: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
    score: Schema.Finite,
  }),
  version: 1,
});
const metricQuery: Query = {
  artifact: { schemaId: Metric.id, schemaVersion: 1 },
  limit: 200,
  version: 1,
  versions: "latest",
};

test("Boolean, range and membership queries agree with an independent reference set", () =>
  withLake(
    Effect.gen(function* () {
      const lake = yield* Lake;
      const identity = yield* producer("metrics");
      const expected = [];
      for (let score = 0; score < 24; score += 1) {
        const ref = yield* lake.publish(
          identity,
          "metric",
          Metric,
          {
            name: `metric-${score}`,
            score,
            ...(score % 3 === 0 ? { optional: null } : {}),
          },
          {
            key: String(score),
            tags: { group: score % 2 === 0 ? "even" : "odd" },
          }
        );
        expected.push({ id: ref.artifactId, score });
      }
      const cases: readonly {
        where: Expression;
        accept: (score: number) => boolean;
      }[] = [
        {
          accept: (score) => score > 12,
          where: { _tag: "Gt", field: { json: ["score"] }, value: 12 },
        },
        {
          accept: (score) => score <= 6,
          where: { _tag: "Lte", field: { json: ["score"] }, value: 6 },
        },
        {
          accept: (score) => [1, 3, 7, 20].includes(score),
          where: {
            _tag: "In",
            field: { json: ["score"] },
            values: [1, 3, 7, 20],
          },
        },
        {
          accept: (score) => score >= 5 && score < 18 && score % 2 === 0,
          where: {
            _tag: "And",
            terms: [
              { _tag: "Gte", field: { json: ["score"] }, value: 5 },
              { _tag: "Lt", field: { json: ["score"] }, value: 18 },
              { _tag: "Eq", field: { tag: "group" }, value: "even" },
            ],
          },
        },
        {
          accept: (score) => score < 4 || score > 20,
          where: {
            _tag: "Or",
            terms: [
              { _tag: "Lt", field: { json: ["score"] }, value: 4 },
              { _tag: "Gt", field: { json: ["score"] }, value: 20 },
            ],
          },
        },
        {
          accept: (score) => score % 3 !== 0,
          where: {
            _tag: "Not",
            term: { _tag: "Eq", field: { json: ["optional"] }, value: null },
          },
        },
      ];
      for (const example of cases) {
        const page = yield* lake.query(
          { ...metricQuery, where: example.where },
          "owner"
        );
        expect(page.rows.map((row) => row.artifactId)).toEqual(
          expected
            .filter((item) => example.accept(item.score))
            .map((item) => item.id)
        );
        expect(page.scanned).toBeLessThanOrEqual(24);
        expect(page.scanned).toBeGreaterThanOrEqual(page.matched);
        expect(page.matched).toBe(page.rows.length);
      }
      expect((yield* lake.query(metricQuery, "other")).rows).toHaveLength(0);
      const [first] = expected;
      if (!first) {
        return yield* Effect.die("Missing test artifact");
      }
      const denied = yield* Effect.result(lake.get(first.id, 1, "other"));
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure") {
        expect(denied.failure.code).toBe("NotFound");
      }
    })
  ));

test("ordered projection pages retain old latest versions during writes and distinguish missing from null", () =>
  withLake(
    Effect.gen(function* () {
      const lake = yield* Lake;
      const identity = yield* producer("ordered");
      const records = [];
      for (let score = 0; score < 6; score += 1) {
        const ref = yield* lake.publish(
          identity,
          "metric",
          Metric,
          {
            name: `m-${score}`,
            score: Math.floor(score / 2),
            ...(score === 0 ? { optional: null } : {}),
          },
          { key: String(score) }
        );
        records.push({
          id: ref.artifactId,
          name: `m-${score}`,
          score: Math.floor(score / 2),
        });
      }
      const request: Query = {
        ...metricQuery,
        limit: 2,
        orderBy: [{ direction: "desc", field: { json: ["score"] } }],
        select: [
          { field: { json: ["name"] }, name: "name" },
          { field: { json: ["optional"] }, name: "nullable" },
        ],
      };
      const first = yield* lake.query(request, "owner");
      const replacement = yield* producer("ordered-new");
      yield* lake.publish(
        replacement,
        "metric",
        Metric,
        { name: "newest", score: 99 },
        { key: "0" }
      );
      const rows = [...first.rows];
      let { cursor } = first;
      for (
        let pageIndex = 0;
        cursor !== null && pageIndex < 10;
        pageIndex += 1
      ) {
        const page = yield* lake.query(request, "owner", cursor);
        expect(page.snapshot).toBe(first.snapshot);
        rows.push(...page.rows);
        const { cursor: nextCursor } = page;
        cursor = nextCursor;
      }
      expect(cursor).toBeNull();
      const sorted = records.toSorted(
        (a, b) => b.score - a.score || (a.id < b.id ? -1 : Number(a.id > b.id))
      );
      expect(rows.map((row) => row.artifactId)).toEqual(
        sorted.map((row) => row.id)
      );
      expect(rows.every((row) => row.version === 1)).toBe(true);
      expect(
        rows.find((row) => row.projection?.name === "m-0")?.projection
      ).toEqual({ name: "m-0", nullable: null });
      expect(
        rows.find((row) => row.projection?.name === "m-1")?.projection
      ).toEqual({ name: "m-1" });
      expect(
        (yield* lake.query({ ...request, limit: 200 }, "owner")).rows[0]
          ?.projection?.name
      ).toBe("newest");
    })
  ));

test("query validation rejects incompatible comparisons, undeclared projection/order and excessive ASTs", () =>
  withLake(
    Effect.gen(function* () {
      const lake = yield* Lake;
      const identity = yield* producer("invalid-query");
      yield* lake.publish(
        identity,
        "metric",
        Metric,
        { name: "x", score: 1 },
        { key: "x" }
      );
      let nested: Expression = {
        _tag: "Eq",
        field: { json: ["score"] },
        value: 1,
      };
      for (let index = 0; index < 9; index += 1) {
        nested = { _tag: "Not", term: nested };
      }
      const invalid: Query[] = [
        {
          ...metricQuery,
          where: { _tag: "Gt", field: { json: ["score"] }, value: "1" },
        },
        {
          ...metricQuery,
          where: { _tag: "Gt", field: { json: ["optional"] }, value: null },
        },
        {
          ...metricQuery,
          select: [{ field: { json: ["secret"] }, name: "secret" }],
        },
        {
          ...metricQuery,
          orderBy: [{ direction: "asc", field: { json: ["secret"] } }],
        },
        { ...metricQuery, where: nested },
        {
          ...metricQuery,
          where: {
            _tag: "And",
            terms: Array.from({ length: 64 }, () => ({
              _tag: "Eq" as const,
              field: { json: ["score"] },
              value: 1,
            })),
          },
        },
      ];
      for (const request of invalid) {
        const result = yield* Effect.result(lake.query(request, "owner"));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(["InvalidInput", "LimitExceeded"]).toContain(
            result.failure.code
          );
        }
      }
    })
  ));

test("exact artifact version pages exclude later writes and authorize before cursor lookup", () =>
  withLake(
    Effect.gen(function* () {
      const lake = yield* Lake;
      const one = yield* producer("version-one");
      const first = yield* lake.publish(
        one,
        "summary",
        Summary,
        { status: "one" },
        { key: "same" }
      );
      const two = yield* producer("version-two");
      yield* lake.publish(
        two,
        "summary",
        Summary,
        { status: "two" },
        { key: "same" }
      );
      const page = yield* lake.versions(
        { artifactId: first.artifactId, limit: 1 },
        "owner"
      );
      expect(page.items.map((item) => item.version)).toEqual([1]);
      expect(page.snapshot).toBe(2);
      if (page.cursor === null) {
        return yield* Effect.die("Expected version cursor");
      }
      const three = yield* producer("version-three");
      yield* lake.publish(
        three,
        "summary",
        Summary,
        { status: "three" },
        { key: "same" }
      );
      const next = yield* lake.versions(
        { artifactId: first.artifactId, cursor: page.cursor, limit: 1 },
        "owner"
      );
      expect(next.items.map((item) => item.version)).toEqual([2]);
      expect(next.cursor).toBeNull();
      const denied = yield* Effect.result(
        lake.versions(
          { artifactId: first.artifactId, cursor: "invalid" },
          "other"
        )
      );
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure") {
        expect(denied.failure.code).toBe("NotFound");
      }
    })
  ));
