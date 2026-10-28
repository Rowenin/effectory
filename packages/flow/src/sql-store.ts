/** A `RunStore` on any `effect/sql` client, such as SQLite. */
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";

import { StoreError } from "./errors.ts";
import type { PendingInput } from "./errors.ts";
import { RunStore } from "./store.ts";
import type { NodeRecord, NodeStatus, RunRecord, RunStatus } from "./store.ts";

const migrations = [
  `CREATE TABLE IF NOT EXISTS flow_runs (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    input TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    pending TEXT NOT NULL,
    output TEXT,
    error TEXT,
    owner TEXT,
    lease_until INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS flow_nodes (
    run_id TEXT NOT NULL,
    key TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    output TEXT,
    error TEXT,
    PRIMARY KEY (run_id, key)
  )`,
  `CREATE TABLE IF NOT EXISTS flow_responses (
    run_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (run_id, key)
  )`,
];

interface RunRow {
  readonly id: string;
  readonly task: string;
  readonly input: string;
  readonly fingerprint: string;
  readonly status: string;
  readonly pending: string;
  readonly output: string | null;
  readonly error: string | null;
}

interface NodeRow {
  readonly key: string;
  readonly status: string;
  readonly attempts: number;
  readonly output: string | null;
  readonly error: string | null;
}

const storeError = (message: string) => (cause: unknown) =>
  new StoreError({ cause, message });

/** Values are already JSON-encoded through their schemas. */
const toJson = (value: unknown) => JSON.stringify(value) ?? "null";
const fromJson = (text: string): unknown => JSON.parse(text);

const toRun = (row: RunRow): RunRecord => ({
  fingerprint: row.fingerprint,
  id: row.id,
  input: fromJson(row.input),
  pending: fromJson(row.pending) as readonly PendingInput[],
  status: row.status as RunStatus,
  task: row.task,
  ...(row.output === null ? {} : { output: fromJson(row.output) }),
  ...(row.error === null ? {} : { error: row.error }),
});

const toNode = (row: NodeRow): NodeRecord => ({
  attempts: row.attempts,
  key: row.key,
  status: row.status as NodeStatus,
  ...(row.output === null ? {} : { output: fromJson(row.output) }),
  ...(row.error === null ? {} : { error: row.error }),
});

/**
 * A `RunStore` in the `flow_runs`, `flow_nodes` and `flow_responses` tables,
 * created if missing.
 */
export const layerSql: Layer.Layer<RunStore, StoreError, SqlClient.SqlClient> =
  Layer.effect(RunStore)(
    Effect.gen(function* makeSqlStore() {
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.forEach(migrations, (statement) => sql.unsafe(statement), {
        discard: true,
      }).pipe(Effect.mapError(storeError("Could not create the flow tables")));

      return RunStore.of({
        claim: (runId, owner, { now, until }) =>
          sql
            .withTransaction(
              Effect.gen(function* claimLease() {
                yield* sql`
                UPDATE flow_runs SET owner = ${owner}, lease_until = ${until}
                WHERE id = ${runId}
                  AND (owner IS NULL OR owner = ${owner} OR lease_until < ${now})
              `;
                const rows = yield* sql<{ owner: string | null }>`
                SELECT owner FROM flow_runs WHERE id = ${runId}
              `;
                return rows[0]?.owner === owner;
              })
            )
            .pipe(Effect.mapError(storeError(`Could not claim run ${runId}`))),
        createRun: (run) =>
          sql`
          INSERT INTO flow_runs (id, task, input, fingerprint, status, pending)
          VALUES (${run.id}, ${run.task}, ${toJson(run.input)},
            ${run.fingerprint}, ${run.status}, ${toJson(run.pending)})
        `.pipe(
            Effect.asVoid,
            Effect.mapError(storeError(`Could not create run ${run.id}`))
          ),
        getNode: (runId, key) =>
          sql<NodeRow>`
          SELECT key, status, attempts, output, error FROM flow_nodes
          WHERE run_id = ${runId} AND key = ${key}
        `.pipe(
            Effect.map((rows) =>
              Option.map(Option.fromUndefinedOr(rows[0]), toNode)
            ),
            Effect.mapError(storeError(`Could not read node ${key}`))
          ),
        getResponse: (runId, key) =>
          sql<{ value: string }>`
          SELECT value FROM flow_responses
          WHERE run_id = ${runId} AND key = ${key}
        `.pipe(
            Effect.map((rows) =>
              Option.map(Option.fromUndefinedOr(rows[0]), (row) =>
                fromJson(row.value)
              )
            ),
            Effect.mapError(storeError(`Could not read the response to ${key}`))
          ),
        getRun: (id) =>
          sql<RunRow>`
          SELECT id, task, input, fingerprint, status, pending, output, error
          FROM flow_runs WHERE id = ${id}
        `.pipe(
            Effect.map((rows) =>
              Option.map(Option.fromUndefinedOr(rows[0]), toRun)
            ),
            Effect.mapError(storeError(`Could not read run ${id}`))
          ),
        listNodes: (runId) =>
          sql<NodeRow>`
          SELECT key, status, attempts, output, error FROM flow_nodes
          WHERE run_id = ${runId} ORDER BY rowid
        `.pipe(
            Effect.map((rows) => rows.map(toNode)),
            Effect.mapError(storeError(`Could not list nodes of run ${runId}`))
          ),
        listRuns: sql<RunRow>`
          SELECT id, task, input, fingerprint, status, pending, output, error
          FROM flow_runs ORDER BY rowid
        `.pipe(
          Effect.map((rows) => rows.map(toRun)),
          Effect.mapError(storeError("Could not list runs"))
        ),
        putNode: (runId, node) =>
          sql`
          INSERT INTO flow_nodes (run_id, key, status, attempts, output, error)
          VALUES (${runId}, ${node.key}, ${node.status}, ${node.attempts},
            ${node.output === undefined ? null : toJson(node.output)},
            ${node.error ?? null})
          ON CONFLICT (run_id, key) DO UPDATE SET
            status = excluded.status, attempts = excluded.attempts,
            output = excluded.output, error = excluded.error
        `.pipe(
            Effect.asVoid,
            Effect.mapError(storeError(`Could not write node ${node.key}`))
          ),
        putResponse: (runId, key, value) =>
          sql`
          INSERT INTO flow_responses (run_id, key, value)
          VALUES (${runId}, ${key}, ${toJson(value)})
          ON CONFLICT (run_id, key) DO UPDATE SET value = excluded.value
        `.pipe(
            Effect.asVoid,
            Effect.mapError(
              storeError(`Could not record the response to ${key}`)
            )
          ),
        release: (runId, owner) =>
          sql`
          UPDATE flow_runs SET owner = NULL, lease_until = NULL
          WHERE id = ${runId} AND owner = ${owner}
        `.pipe(
            Effect.asVoid,
            Effect.mapError(storeError(`Could not release run ${runId}`))
          ),
        updateRun: (id, update) =>
          sql`
          UPDATE flow_runs SET
            status = ${update.status},
            pending = ${toJson(update.pending)},
            output = ${update.output === undefined ? null : toJson(update.output)},
            error = ${update.error ?? null}
          WHERE id = ${id}
        `.pipe(
            Effect.asVoid,
            Effect.mapError(storeError(`Could not update run ${id}`))
          ),
      });
    })
  );
