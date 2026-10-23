/**
 * Durable state: runs, node statuses, immutable records, resource state rows,
 * and approvals. Keyed by collection and scope, never by workspace path.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Context, Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { NodeRow } from "./node.ts";

export type RunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "suspended"
  | "cancelled";

export interface RunRow {
  readonly id: string;
  readonly collection: string;
  readonly workflow: string;
  readonly scope: string;
  readonly revision: string;
  readonly mode: "live" | "fake";
  readonly target?: string;
  /** Encoded workflow input. */
  readonly input: unknown;
  readonly status: RunStatus;
  /** `Graph.toSnapshot` of the plan that ran. */
  readonly plan: unknown;
  readonly result?: unknown;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RecordRow {
  readonly id: number;
  readonly collection: string;
  readonly scope: string;
  readonly fqn: string;
  readonly runId: string;
  /** Schema identity: the Action or Resource type, `AssertResult`, `Report`, ... */
  readonly kind: string;
  readonly value: unknown;
  readonly input?: unknown;
  readonly inputDigest?: string;
  readonly createdAt: number;
}

export type ResourceStatus =
  | "creating"
  | "created"
  | "updating"
  | "updated"
  | "replacing"
  | "replaced"
  | "deleting";

export interface ResourceRow {
  readonly collection: string;
  readonly scope: string;
  readonly fqn: string;
  readonly type: string;
  readonly status: ResourceStatus;
  /** Encoded props the resource was last reconciled to (or is being reconciled to). */
  readonly props: unknown;
  /** Encoded attributes, once known. */
  readonly attributes?: unknown;
  /** Props and attributes of the object being replaced, while `replacing`. */
  readonly previous?: {
    readonly props: unknown;
    readonly attributes?: unknown;
  };
  readonly lifetime: "run" | "scope";
  readonly mode?: "live" | "fake";
  readonly runId: string;
  readonly updatedAt: number;
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalRow {
  readonly id: string;
  readonly runId: string;
  readonly fqn: string;
  readonly title: string;
  readonly review: unknown;
  readonly status: ApprovalStatus;
  readonly decidedBy?: string;
  readonly note?: string;
  readonly createdAt: number;
  readonly decidedAt?: number;
}

/** A `field op value` filter on a record's JSON value. */
export interface Where {
  readonly path: string;
  readonly op: "=" | "!=" | "<" | "<=" | ">" | ">=";
  readonly value: string | number | boolean | null;
}

export interface RecordQuery {
  readonly collection: string;
  readonly scope?: string;
  readonly fqn?: string;
  readonly runId?: string;
  readonly kind?: string;
  readonly inputDigest?: string;
  readonly since?: number;
  readonly where?: readonly Where[];
  /** Newest first. */
  readonly limit?: number;
}

export interface StateShape {
  readonly createRun: (run: RunRow) => Effect.Effect<RunRow>;
  /**
   * Insert `run` unless an unfinished run of the same workflow and scope
   * exists; returns that run instead.
   */
  readonly admitRun: (
    run: RunRow
  ) => Effect.Effect<{ readonly admitted: boolean; readonly run: RunRow }>;
  readonly getRun: (id: string) => Effect.Effect<RunRow | undefined>;
  readonly listRuns: (query: {
    readonly collection: string;
    readonly workflow?: string;
    readonly scope?: string;
    readonly status?: RunStatus;
    readonly limit?: number;
  }) => Effect.Effect<readonly RunRow[]>;
  readonly updateRun: (
    id: string,
    patch: Partial<Omit<RunRow, "id">>
  ) => Effect.Effect<RunRow>;

  readonly putNode: (node: NodeRow) => Effect.Effect<void>;
  readonly getNodes: (runId: string) => Effect.Effect<readonly NodeRow[]>;

  readonly putRecord: (
    record: Omit<RecordRow, "id">
  ) => Effect.Effect<RecordRow>;
  readonly records: (query: RecordQuery) => Effect.Effect<readonly RecordRow[]>;
  /** Delete records beyond `keep` for one FQN in one scope. */
  readonly pruneRecords: (key: {
    readonly collection: string;
    readonly scope: string;
    readonly fqn: string;
    readonly keep: { readonly versions: number } | { readonly days: number };
  }) => Effect.Effect<void>;

  readonly getResource: (key: {
    readonly collection: string;
    readonly scope: string;
    readonly fqn: string;
  }) => Effect.Effect<ResourceRow | undefined>;
  readonly putResource: (row: ResourceRow) => Effect.Effect<void>;
  readonly deleteResource: (key: {
    readonly collection: string;
    readonly scope: string;
    readonly fqn: string;
  }) => Effect.Effect<void>;
  readonly listResources: (query: {
    readonly collection: string;
    readonly scope?: string;
    readonly runId?: string;
    readonly lifetime?: "run" | "scope";
  }) => Effect.Effect<readonly ResourceRow[]>;

  readonly putApproval: (row: ApprovalRow) => Effect.Effect<void>;
  readonly getApproval: (id: string) => Effect.Effect<ApprovalRow | undefined>;
  readonly listApprovals: (query: {
    readonly runId?: string;
    readonly status?: ApprovalStatus;
  }) => Effect.Effect<readonly ApprovalRow[]>;
}

export class State extends Context.Service<State, StateShape>()(
  "effectory/State"
) {}

const migrations = [
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, collection TEXT NOT NULL, workflow TEXT NOT NULL,
    scope TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
    data TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS runs_scope ON runs(collection, workflow, scope, status)",
  `CREATE TABLE IF NOT EXISTS nodes (
    run_id TEXT NOT NULL, fqn TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (run_id, fqn))`,
  `CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL,
    scope TEXT NOT NULL, fqn TEXT NOT NULL, run_id TEXT NOT NULL,
    kind TEXT NOT NULL, value TEXT NOT NULL, input TEXT, input_digest TEXT,
    created_at INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS records_key ON records(collection, scope, fqn, id)",
  "CREATE INDEX IF NOT EXISTS records_kind ON records(collection, kind, created_at)",
  `CREATE TABLE IF NOT EXISTS resources (
    collection TEXT NOT NULL, scope TEXT NOT NULL, fqn TEXT NOT NULL,
    run_id TEXT NOT NULL, lifetime TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (collection, scope, fqn))`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL,
    data TEXT NOT NULL)`,
];

const unfinished = ["running", "suspended"];

const parse = <A>(rows: readonly { readonly data: string }[]) =>
  rows.map((row) => JSON.parse(row.data) as A);

interface RecordSqlRow {
  readonly id: number;
  readonly collection: string;
  readonly scope: string;
  readonly fqn: string;
  readonly run_id: string;
  readonly kind: string;
  readonly value: string;
  readonly input: string | null;
  readonly input_digest: string | null;
  readonly created_at: number;
}

const toRecord = (row: RecordSqlRow): RecordRow => ({
  collection: row.collection,
  createdAt: row.created_at,
  fqn: row.fqn,
  id: row.id,
  kind: row.kind,
  runId: row.run_id,
  scope: row.scope,
  value: JSON.parse(row.value),
  ...(row.input === null ? {} : { input: JSON.parse(row.input) }),
  ...(row.input_digest === null ? {} : { inputDigest: row.input_digest }),
});

const jsonPath = (field: string) => {
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[\d+\])*$/u.test(field)) {
    throw new Error(`Invalid field path: ${field}`);
  }
  return `$.${field}`;
};

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.orDie(effect);
const now = () => Date.now();

/** The SQLite-backed State. Requires an `SqlClient`. */
export const make = Effect.gen(function* makeState() {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of migrations) {
    yield* sql.unsafe(statement);
  }

  const getRun = (id: string) =>
    run(
      sql
        .unsafe<{ data: string }>("SELECT data FROM runs WHERE id = ?", [id])
        .pipe(Effect.map((rows) => parse<RunRow>(rows)[0]))
    );

  const putRun = (row: RunRow) =>
    run(
      sql.unsafe(
        `INSERT INTO runs (id, collection, workflow, scope, status, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
        [
          row.id,
          row.collection,
          row.workflow,
          row.scope,
          row.status,
          row.createdAt,
          JSON.stringify(row),
        ]
      )
    ).pipe(Effect.as(row));

  const state: StateShape = {
    admitRun: (row) =>
      run(
        sql.withTransaction(
          Effect.gen(function* admit() {
            const existing = yield* sql.unsafe<{ data: string }>(
              `SELECT data FROM runs WHERE collection = ? AND workflow = ? AND scope = ?
               AND status IN (${unfinished.map(() => "?").join(", ")})
               ORDER BY created_at DESC LIMIT 1`,
              [row.collection, row.workflow, row.scope, ...unfinished]
            );
            const [active] = parse<RunRow>(existing);
            if (active) {
              return { admitted: false, run: active };
            }
            return { admitted: true, run: yield* putRun(row) };
          })
        )
      ),
    createRun: putRun,
    deleteResource: (key) =>
      run(
        sql.unsafe(
          "DELETE FROM resources WHERE collection = ? AND scope = ? AND fqn = ?",
          [key.collection, key.scope, key.fqn]
        )
      ).pipe(Effect.asVoid),
    getApproval: (id) =>
      run(
        sql
          .unsafe<{ data: string }>("SELECT data FROM approvals WHERE id = ?", [
            id,
          ])
          .pipe(Effect.map((rows) => parse<ApprovalRow>(rows)[0]))
      ),
    getNodes: (runId) =>
      run(
        sql
          .unsafe<{ data: string }>(
            "SELECT data FROM nodes WHERE run_id = ? ORDER BY rowid",
            [runId]
          )
          .pipe(Effect.map((rows) => parse<NodeRow>(rows)))
      ),
    getResource: (key) =>
      run(
        sql
          .unsafe<{ data: string }>(
            "SELECT data FROM resources WHERE collection = ? AND scope = ? AND fqn = ?",
            [key.collection, key.scope, key.fqn]
          )
          .pipe(Effect.map((rows) => parse<ResourceRow>(rows)[0]))
      ),
    getRun,
    listApprovals: (query) => {
      const clauses: string[] = [];
      const params: string[] = [];
      if (query.runId !== undefined) {
        clauses.push("run_id = ?");
        params.push(query.runId);
      }
      if (query.status !== undefined) {
        clauses.push("status = ?");
        params.push(query.status);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      return run(
        sql
          .unsafe<{ data: string }>(
            `SELECT data FROM approvals ${where} ORDER BY rowid`,
            params
          )
          .pipe(Effect.map((rows) => parse<ApprovalRow>(rows)))
      );
    },
    listResources: (query) => {
      const clauses = ["collection = ?"];
      const params: string[] = [query.collection];
      if (query.scope !== undefined) {
        clauses.push("scope = ?");
        params.push(query.scope);
      }
      if (query.runId !== undefined) {
        clauses.push("run_id = ?");
        params.push(query.runId);
      }
      if (query.lifetime !== undefined) {
        clauses.push("lifetime = ?");
        params.push(query.lifetime);
      }
      return run(
        sql
          .unsafe<{ data: string }>(
            `SELECT data FROM resources WHERE ${clauses.join(" AND ")} ORDER BY rowid`,
            params
          )
          .pipe(Effect.map((rows) => parse<ResourceRow>(rows)))
      );
    },
    listRuns: (query) => {
      const clauses = ["collection = ?"];
      const params: (string | number)[] = [query.collection];
      for (const key of ["workflow", "scope", "status"] as const) {
        const value = query[key];
        if (value !== undefined) {
          clauses.push(`${key} = ?`);
          params.push(value);
        }
      }
      params.push(query.limit ?? 50);
      return run(
        sql
          .unsafe<{ data: string }>(
            `SELECT data FROM runs WHERE ${clauses.join(" AND ")}
             ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            params
          )
          .pipe(Effect.map((rows) => parse<RunRow>(rows)))
      );
    },
    pruneRecords: ({ collection, scope, fqn, keep }) =>
      run(
        "versions" in keep
          ? sql.unsafe(
              `DELETE FROM records WHERE collection = ? AND scope = ? AND fqn = ? AND id NOT IN (
                 SELECT id FROM records WHERE collection = ? AND scope = ? AND fqn = ?
                 ORDER BY id DESC LIMIT ?)`,
              [collection, scope, fqn, collection, scope, fqn, keep.versions]
            )
          : sql.unsafe(
              "DELETE FROM records WHERE collection = ? AND scope = ? AND fqn = ? AND created_at < ?",
              [collection, scope, fqn, now() - keep.days * 86_400_000]
            )
      ).pipe(Effect.asVoid),
    putApproval: (row) =>
      run(
        sql.unsafe(
          `INSERT INTO approvals (id, run_id, status, data) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
          [row.id, row.runId, row.status, JSON.stringify(row)]
        )
      ).pipe(Effect.asVoid),
    putNode: (node) =>
      run(
        sql.unsafe(
          `INSERT INTO nodes (run_id, fqn, data) VALUES (?, ?, ?)
           ON CONFLICT(run_id, fqn) DO UPDATE SET data = excluded.data`,
          [node.runId, node.fqn, JSON.stringify(node)]
        )
      ).pipe(Effect.asVoid),
    putRecord: (record) =>
      run(
        sql
          .unsafe<RecordSqlRow>(
            `INSERT INTO records (collection, scope, fqn, run_id, kind, value, input, input_digest, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            [
              record.collection,
              record.scope,
              record.fqn,
              record.runId,
              record.kind,
              JSON.stringify(record.value ?? null),
              record.input === undefined ? null : JSON.stringify(record.input),
              record.inputDigest ?? null,
              record.createdAt,
            ]
          )
          .pipe(Effect.map((rows) => toRecord(rows[0] as RecordSqlRow)))
      ),
    putResource: (row) =>
      run(
        sql.unsafe(
          `INSERT INTO resources (collection, scope, fqn, run_id, lifetime, data)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(collection, scope, fqn) DO UPDATE SET
             run_id = excluded.run_id, lifetime = excluded.lifetime, data = excluded.data`,
          [
            row.collection,
            row.scope,
            row.fqn,
            row.runId,
            row.lifetime,
            JSON.stringify(row),
          ]
        )
      ).pipe(Effect.asVoid),
    records: (query) =>
      Effect.suspend(() => {
        const clauses = ["collection = ?"];
        const params: (string | number | boolean | null)[] = [query.collection];
        const equal = {
          fqn: query.fqn,
          input_digest: query.inputDigest,
          kind: query.kind,
          run_id: query.runId,
          scope: query.scope,
        };
        for (const [column, value] of Object.entries(equal)) {
          if (value !== undefined) {
            clauses.push(`${column} = ?`);
            params.push(value);
          }
        }
        if (query.since !== undefined) {
          clauses.push("created_at >= ?");
          params.push(query.since);
        }
        for (const where of query.where ?? []) {
          if (where.value === null) {
            clauses.push(
              `json_extract(value, ?) IS ${where.op === "!=" ? "NOT " : ""}NULL`
            );
            params.push(jsonPath(where.path));
          } else {
            clauses.push(`json_extract(value, ?) ${where.op} ?`);
            params.push(
              jsonPath(where.path),
              typeof where.value === "boolean"
                ? Number(where.value)
                : where.value
            );
          }
        }
        params.push(query.limit ?? 1000);
        return run(
          sql
            .unsafe<RecordSqlRow>(
              `SELECT * FROM records WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`,
              params
            )
            .pipe(Effect.map((rows) => rows.map(toRecord)))
        );
      }),
    updateRun: (id, patch) =>
      Effect.gen(function* update() {
        const current = yield* getRun(id);
        if (current === undefined) {
          return yield* Effect.die(new Error(`Unknown run: ${id}`));
        }
        return yield* putRun({ ...current, ...patch, id, updatedAt: now() });
      }),
  };
  return state;
});

/** State in a SQLite file, created with its directory if missing. */
export const layer = (filename: string): Layer.Layer<State> =>
  Layer.effect(State, make).pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.sync(() => {
          mkdirSync(path.dirname(filename), { recursive: true });
          return SqliteClient.layer({ filename });
        })
      )
    ),
    Layer.orDie
  );

/** State in an in-memory SQLite database, for tests. */
export const memory: Layer.Layer<State> = Layer.effect(State, make).pipe(
  Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
  Layer.orDie
);
